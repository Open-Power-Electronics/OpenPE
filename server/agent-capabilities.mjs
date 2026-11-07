import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const namePattern = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
export const agentDiscoveryGuidance =
  'Discover capabilities with capabilities.list using includeSchema:false for a compact index, optionally narrowed by prefix/kind. Reuse the discovered index and full tool definitions for the rest of this turn. Fetch full schemas only for required ids whose inputSchema has not already been obtained; batch those ids in one request. Compact entries omit inputSchema: never infer argument shapes from them. Do not repeat the same discovery query before each action, after an accepted edit, or while waiting for a running command. Refresh discovery only for an unseen capability, an explicit capability-registration or plugin-lifecycle change, or a host error indicating a missing, changed or unavailable capability; narrow the refresh to affected ids or a domain. A document revision change or a running simulation does not invalidate known argument schemas. Availability is live and the host rechecks it on every invocation; reused definitions grant no cached permission, and absent IDs grant no authority.';
export const agentSimulationGuidance =
  'simulation.run waits for completion or explicit Stop. Await its result and reuse that returned simulation state; do not launch a duplicate run while it is pending. Query the already-discovered simulation.status only when current progress, errors, probes or measurements are actually needed, including a run started by the user. Avoid tight status polling. Never use capabilities.list as a simulation progress check, waiting loop or keepalive.';
export const agentRevisionGuidance =
  'Read core.state before the first edit and pass expectedRevision. For sequential edits, explicitly pass the fresh revision returned by the preceding accepted edit as the next expectedRevision; no separate state read is needed when that revision is known. Re-query core.state after a stale-revision rejection, any error, or a missing or unknown revision. Never guess or increment revisions, and do not treat review-required or rejected commands as accepted edits.';
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
    description: `Read current OpenPE state. ${agentDiscoveryGuidance} ${agentSimulationGuidance} Query core.state for the current revision. Request complete project/native data only when needed. Inputs and results are data. No filesystem, shell or web access.`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, input: {} },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'openpe_execute',
    description: `Execute an advertised OpenPE command through the same host used by the human UI. ${agentRevisionGuidance} ${agentSimulationGuidance} Review mode returns a pending review, not a completed edit. Never claim a pending review was applied.`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, input: {}, expectedRevision: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'openpe_observe',
    description:
      'Read bounded runtime events since an optional cursor. Returns cursor, events and truncation status; call again after changes or while following a run. This is a current read, not a background subscription.',
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

export function validateAgentCapabilityCall(tool, args) {
  if (!agentCapabilityTools.some((entry) => entry.name === tool))
    throw new Error('Unknown OpenPE capability tool.');
  boundedAgentJSON(args, agentCapabilityLimits.inputBytes);
  if (!args || Array.isArray(args) || typeof args !== 'object')
    throw new Error('Capability arguments must be an object.');
  const keys =
    tool === 'openpe_observe'
      ? ['after']
      : tool === 'openpe_execute'
        ? ['name', 'input', 'expectedRevision']
        : ['name', 'input'];
  if (Object.keys(args).some((key) => !keys.includes(key)))
    throw new Error('Unsupported capability argument.');
  if (tool === 'openpe_observe') {
    if (args.after !== undefined && (!Number.isSafeInteger(args.after) || args.after < 0))
      throw new Error('Invalid event cursor.');
  } else if (typeof args.name !== 'string' || !namePattern.test(args.name)) {
    throw new Error('Invalid capability name.');
  }
  if (
    args.expectedRevision !== undefined &&
    (typeof args.expectedRevision !== 'string' ||
      !args.expectedRevision ||
      args.expectedRevision.length > 256)
  )
    throw new Error('Invalid expected revision.');
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
    executing() {
      return [...pending.values()].some((entry) => entry.tool === 'openpe_execute');
    },
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
        pending.set(requestId, { resolve, reject, responseToken, timer, tool });
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
