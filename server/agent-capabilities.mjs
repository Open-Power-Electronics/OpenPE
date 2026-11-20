import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const namePattern = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
export const agentDiscoveryGuidance =
  'Discover available IDs via capabilities.list with includeSchema:false and optional prefix/kind. Fetch full schemas in one request for the needed IDs before use. Reuse definitions within the turn. Refresh only for new IDs, capability or plugin changes, or a host error about availability. The host rechecks availability on every call.';
export const agentSimulationGuidance =
  'Await simulation.run and reuse its result. Use simulation.status for needed progress, errors, probes or measurements. Avoid duplicate runs, tight polling and discovery as a progress check.';
export const agentExecutionGuidance =
  'Commands and review Apply use current project state. Omit expectedRevision. Query current targets as needed and await each project-changing command before preparing the next. In Review, reads and review:none commands run directly. Treat review-required as pending. Apply pending Source with a separate source.apply before navigation that requires it.';
export const agentCapabilityLimits = Object.freeze({
  inputBytes: 32 * 1024 * 1024 - 4096,
  resultBytes: 32 * 1024 * 1024 - 4096,
  requests: 256,
  pending: 4,
  timeoutMs: 60000,
});

export const agentCapabilityTools = [
  {
    name: 'openpe_query',
    description: 'Read a current OpenPE query. Use capabilities.list to discover IDs and schemas.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, input: {} },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'openpe_execute',
    description:
      'Invoke an advertised OpenPE command through the workbench. The result can require review.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        input: {},
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'openpe_observe',
    description: 'Read current OpenPE events since an optional cursor, with truncation status.',
    inputSchema: {
      type: 'object',
      properties: { after: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
  },
];

/** Reject oversized/non-JSON data rather than silently truncate a command or result. */
export function boundedAgentJSON(value, maxBytes) {
  let nodes = 0;
  const seen = new Set();
  const check = (item, depth = 0) => {
    if (++nodes > 1000000 || depth > 64) throw new Error('Capability data is too complex.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item))
      throw new Error('Capability data must be finite JSON.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
      throw new Error('Capability data must be plain JSON.');
    seen.add(item);
    for (const entry of Object.values(item)) check(entry, depth + 1);
    seen.delete(item);
  };
  check(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes)
    throw new Error('Capability data exceeds the response budget. Use a narrower query or page.');
  return json;
}

const imageQueries = new Set(['project.datasheet.page', 'library.datasheet.page']);

/** Only explicit datasheet page queries may attach host-rendered images to tools. */
export function agentCapabilityContent(tool, args, result) {
  const json = boundedAgentJSON(result, agentCapabilityLimits.resultBytes);
  if (tool !== 'openpe_query' || !imageQueries.has(args?.name) || !result?.image)
    return { text: json };
  const { image, ...metadata } = result;
  if (
    image.mimeType !== 'image/png' ||
    typeof image.data !== 'string' ||
    image.data.length > 12 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
    !Buffer.from(image.data, 'base64')
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    !Number.isInteger(image.width) ||
    image.width < 1 ||
    image.width > 2400 ||
    !Number.isInteger(image.height) ||
    image.height < 1 ||
    image.height > 2400
  )
    throw new Error('Invalid datasheet page image.');
  return {
    text: boundedAgentJSON(
      {
        ...metadata,
        image: { mimeType: image.mimeType, width: image.width, height: image.height },
      },
      agentCapabilityLimits.resultBytes,
    ),
    image: image.data,
  };
}

export function validateAgentCapabilityCall(tool, args) {
  if (!agentCapabilityTools.some((entry) => entry.name === tool))
    throw new Error('Unknown OpenPE capability tool.');
  boundedAgentJSON(args, agentCapabilityLimits.inputBytes);
  if (!args || Array.isArray(args) || typeof args !== 'object')
    throw new Error('Capability arguments must be an object.');
  const keys = tool === 'openpe_observe' ? ['after'] : ['name', 'input'];
  if (Object.keys(args).some((key) => !keys.includes(key)))
    throw new Error('Unsupported capability argument.');
  if (tool === 'openpe_observe') {
    if (args.after !== undefined && (!Number.isSafeInteger(args.after) || args.after < 0))
      throw new Error('Invalid event cursor.');
  } else if (typeof args.name !== 'string' || !namePattern.test(args.name)) {
    throw new Error('Invalid capability name.');
  }
  return args;
}

function sameSecret(value, expected) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{64}$/.test(value) &&
    value.length === expected.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
}

/** One live chat owns every request and its single-use response capability.
 * @param {{sessionId:string, emit:(event:any)=>void, signal:AbortSignal, origin?:string, timeoutMs?:number}} options
 */
export function createAgentCapabilityBridge({
  sessionId,
  emit,
  signal,
  origin,
  timeoutMs = agentCapabilityLimits.timeoutMs,
}) {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const pending = new Map();
  let count = 0,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The originating Agent request was cancelled or completed.'));
    }
    pending.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  return {
    id,
    token,
    close,
    authorized(value) {
      return !closed && sameSecret(value, token);
    },
    async call(tool, args) {
      validateAgentCapabilityCall(tool, args);
      if (closed) throw new Error('The originating Agent request is no longer active.');
      if (pending.size >= agentCapabilityLimits.pending || ++count > agentCapabilityLimits.requests)
        throw new Error(
          'Agent capability request limit reached. Finish pending requests or start another turn.',
        );
      const requestId = randomUUID();
      const responseToken = randomBytes(32).toString('hex');
      return new Promise((resolve, reject) => {
        const timer =
          tool === 'openpe_execute'
            ? undefined
            : setTimeout(() => {
                pending.delete(requestId);
                reject(new Error('The workbench did not answer the capability request in time.'));
              }, timeoutMs);
        pending.set(requestId, { resolve, reject, responseToken, timer });
        try {
          emit({
            type: 'capability-request',
            runId: id,
            sessionId,
            requestId,
            token: responseToken,
            tool,
            arguments: args,
          });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error);
        }
      });
    },
    respond(body, responseOrigin) {
      if (
        closed ||
        body?.runId !== id ||
        body?.sessionId !== sessionId ||
        responseOrigin !== origin
      )
        throw new Error('The originating Agent request is no longer active.');
      const entry = pending.get(body.requestId);
      if (!entry || !sameSecret(body.token, entry.responseToken))
        throw new Error('Unknown or already answered Agent capability request.');
      if (
        Object.keys(body).some(
          (key) => !['runId', 'sessionId', 'requestId', 'token', 'result', 'error'].includes(key),
        ) ||
        Object.hasOwn(body, 'error') === Object.hasOwn(body, 'result')
      )
        throw new Error('Invalid capability response.');
      if (body.error !== undefined) {
        if (typeof body.error !== 'string' || !body.error || body.error.length > 4000)
          throw new Error('Invalid capability error.');
      } else boundedAgentJSON(body.result, agentCapabilityLimits.resultBytes);
      pending.delete(body.requestId);
      clearTimeout(entry.timer);
      if (body.error) entry.reject(new Error(body.error));
      else entry.resolve(body.result);
    },
  };
}
