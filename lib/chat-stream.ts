import { withoutSessionTitle } from './session-title';

export type ChatTimings = {
  connectionMs?: number;
  clientFirstTextMs?: number;
  clientTotalMs?: number;
  resolvedMs?: number;
  spawnedMs?: number;
  readyMs?: number;
  submittedMs?: number;
  firstEventMs?: number;
  firstTextMs?: number;
  completedMs?: number;
};
export type ChatOutcome = 'completed' | 'failed' | 'cancelled';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type AgentCapabilities = {
  query(
    name: string,
    input?: unknown,
    options?: { signal?: AbortSignal },
  ): unknown | Promise<unknown>;
  execute(
    name: string,
    input?: unknown,
    options?: { expectedRevision?: string; signal?: AbortSignal },
  ): unknown | Promise<unknown>;
  observe(after?: number): unknown | Promise<unknown>;
};
export type AgentCapabilityRequest = {
  type: 'capability-request';
  runId: string;
  sessionId: string;
  requestId: string;
  token: string;
  tool: 'openpe_query' | 'openpe_execute' | 'openpe_observe';
  arguments: { name?: string; input?: unknown; expectedRevision?: string; after?: number };
};
export type AgentCommandReview = {
  id: string;
  name: string;
  input?: unknown;
  expectedRevision: string;
};
export type AgentCapabilityRevision = { current?: string };

/** Transport adapter only: every operation resolves against the originating live host. */
export async function resolveAgentCapability(
  event: AgentCapabilityRequest,
  host: AgentCapabilities,
  approvalMode: 'review' | 'auto',
  review: (command: AgentCommandReview) => void,
  signal?: AbortSignal,
  revision?: AgentCapabilityRevision,
) {
  signal?.throwIfAborted();
  const args = event.arguments;
  if (event.tool === 'openpe_observe') {
    const result = await host.observe(args.after);
    signal?.throwIfAborted();
    return result ?? null;
  }
  if (!args.name) throw new Error('A capability name is required.');
  if (event.tool === 'openpe_query') {
    const result = await host.query(args.name, args.input, signal ? { signal } : undefined);
    signal?.throwIfAborted();
    if (revision && ['project.snapshot', 'core.state', 'workbench.state'].includes(args.name)) {
      const state = result as { revision?: unknown; ui?: { revision?: unknown } } | null;
      const value = state?.revision ?? state?.ui?.revision;
      if (
        (typeof value === 'string' && value) ||
        (typeof value === 'number' && Number.isSafeInteger(value))
      )
        revision.current = String(value);
    }
    return result ?? null;
  }
  if (event.tool !== 'openpe_execute') throw new Error('Unknown OpenPE capability tool.');
  const expectedRevision = args.expectedRevision ?? revision?.current;
  if (!expectedRevision)
    throw new Error(
      'Query core.state to read the current project revision before executing a command.',
    );
  signal?.throwIfAborted();
  if (approvalMode === 'auto')
    return (
      (await host.execute(args.name, args.input, {
        expectedRevision,
        ...(signal ? { signal } : {}),
      })) ?? null
    );
  const command = structuredClone({
    id: event.requestId,
    name: args.name,
    ...(args.input !== undefined ? { input: args.input } : {}),
    expectedRevision,
  });
  review(command);
  return { status: 'review-required', reviewId: command.id, command };
}

export type ChatEvent =
  | { type: 'status'; stage?: string; text: string }
  | { type: 'text'; text: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'text-replace'; text: string }
  | { type: 'error'; text: string }
  | { type: 'timing'; timings: ChatTimings }
  | { type: 'agent-info'; model?: string; reasoningEffort?: string }
  | AgentCapabilityRequest
  | { type: 'done'; outcome?: ChatOutcome };

// Decode complete SSE frames, including UTF-8 split across reads and CRLF.
export async function readChatEvents(
  body: ReadableStream<Uint8Array>,
  receive: (event: ChatEvent) => void,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const abort = () => void reader.cancel().catch(() => {});
  const decoder = new TextDecoder();
  let buffer = '',
    data: string[] = [],
    frameLength = 0;
  const line = (value: string) => {
    signal?.throwIfAborted();
    if (!value) {
      if (data.length) {
        const json = data.join('\n');
        const event = JSON.parse(json) as ChatEvent;
        if (event.type !== 'capability-request' && json.length > 2_000_000)
          throw new Error('Agent event exceeds the 2 MB limit.');
        receive(event);
      }
      data = [];
      frameLength = 0;
    } else if (value.startsWith('data:')) {
      frameLength += value.length;
      if (frameLength > 32 * 1024 * 1024)
        throw new Error('Agent capability event exceeds the 32 MB limit.');
      data.push(value.slice(5).replace(/^ /, ''));
    }
  };
  try {
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 32 * 1024 * 1024)
        throw new Error('Agent capability event exceeds the 32 MB limit.');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
      if (done) break;
    }
    if (buffer) line(buffer.replace(/\r$/, ''));
    line('');
  } finally {
    signal?.removeEventListener('abort', abort);
    const cancelled = reader.cancel().catch(() => {});
    if (!signal?.aborted) await cancelled;
    reader.releaseLock();
  }
}

// Hide even an unfinished proposal fence while text is arriving.
export function responseText(text: string) {
  if (text.trim() === '```') return '';
  return withoutSessionTitle(text)
    .replace(/```openpe\b[\s\S]*?(?:```|$)/g, '')
    .replace(
      /(^|\n)[ \t]{0,3}(?:`{1,2}|```(?:o|op|ope|open|openp|openpe|openpe_|openpe_s|openpe_se|openpe_ses|openpe_sess|openpe_sessi|openpe_sessio|openpe_session))$/,
      '$1',
    )
    .trim();
}
