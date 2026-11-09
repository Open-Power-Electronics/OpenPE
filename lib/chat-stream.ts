import { withoutSessionTitle } from './session-title';
import type { CapabilityDescription, CapabilityHost } from '../api/capabilities';

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
export type { ReasoningEffort } from './agent-providers';
export type AgentCapabilities = {
  query(
    name: string,
    input?: unknown,
    options?: { signal?: AbortSignal },
  ): unknown | Promise<unknown>;
  execute(
    name: string,
    input?: unknown,
    options?: {
      signal?: AbortSignal;
      resultDelivery?: Promise<boolean>;
      onAfterResult?: (completion: Promise<void>) => void;
    },
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
  arguments: { name?: string; input?: unknown; after?: number };
};
export type AgentCommandReview = {
  id: string;
  name: string;
  input?: unknown;
};

/** One project adapter serializes document edits; each handler starts on current Core data. */
export function agentCapabilitiesForHost(host: CapabilityHost): AgentCapabilities {
  let edits = Promise.resolve();
  return {
    query: (name, input, options) => host.query(name, input, { ...options, actor: 'agent' }),
    observe: (after) => host.observe(after),
    execute(name, input, options) {
      const commandInput = structuredClone(input);
      const invoke = async () => {
        options?.signal?.throwIfAborted();
        return host.execute(name, commandInput, { ...options, actor: 'agent' });
      };
      if (host.catalog().find((entry) => entry.id === name)?.mutation !== 'document')
        return invoke();
      const result = edits.then(invoke);
      edits = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}

/** Transport adapter only: every operation resolves against the originating live host. */
export async function resolveAgentCapability(
  event: AgentCapabilityRequest,
  host: AgentCapabilities,
  approvalMode: 'review' | 'auto',
  review: (command: AgentCommandReview, description: string) => void,
  signal?: AbortSignal,
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
    return result ?? null;
  }
  if (event.tool !== 'openpe_execute') throw new Error('Unknown OpenPE capability tool.');
  signal?.throwIfAborted();
  const command = structuredClone({
    id: event.requestId,
    name: args.name,
    ...(args.input !== undefined ? { input: args.input } : {}),
  });
  if (approvalMode === 'review') {
    const catalog = (await host.query(
      'capabilities.list',
      { ids: [command.name], kind: 'command', includeSchema: false },
      signal ? { signal } : undefined,
    )) as CapabilityDescription[];
    signal?.throwIfAborted();
    const description = catalog.find(
      (entry) => entry.id === command.name && entry.kind === 'command',
    );
    if (!description) throw new Error(`Unknown command capability: ${command.name}`);
    if (!description.available)
      throw new Error(description.reason || 'This command is unavailable.');
    if (description.review !== 'none') {
      review(command, description.description);
      return { status: 'review-required', reviewId: command.id, command };
    }
  }
  const result = await host.execute(command.name, command.input, {
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  return result ?? null;
}

export type ChatEvent =
  | { type: 'input-ready'; runId: string; sessionId: string; token: string }
  | { type: 'input-accepted'; requestId: string; sessionId: string; prompt: string }
  | { type: 'process'; id: string; text: string; append?: boolean }
  | AgentQuestionRequest
  | { type: 'question-closed'; requestId: string; sessionId: string }
  | { type: 'status'; stage?: string; text: string }
  | { type: 'text'; text: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'text-replace'; text: string }
  | { type: 'error'; text: string }
  | { type: 'timing'; timings: ChatTimings }
  | { type: 'agent-info'; model?: string; reasoningEffort?: string }
  | AgentCapabilityRequest
  | { type: 'done'; outcome?: ChatOutcome };

export type AgentQuestion = {
  id: string;
  header: string;
  question: string;
  detail?: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
};
export type AgentQuestionRequest = {
  type: 'question-request';
  runId: string;
  sessionId: string;
  requestId: string;
  token: string;
  questions: AgentQuestion[];
};

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
