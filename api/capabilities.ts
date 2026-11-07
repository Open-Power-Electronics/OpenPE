import { compileCapabilitySchema, type CapabilityValidation } from './capability-schema';

/** The capability boundary carries data, never renderer objects or native handles. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CapabilityActor = 'human' | 'agent' | 'system';
export type CapabilityMutation = false | 'document' | 'session' | 'external';
export type CapabilityReview = 'none' | 'optional' | 'required';
export type CapabilityOwner = 'core' | 'host' | 'plugin' | 'api';
export type CapabilityLevel = 'object' | 'operation' | 'task';
export type CapabilitySchema = Record<string, unknown> | boolean;
export type CapabilityEvent = {
  seq: number;
  time: string;
  type: string;
  data: JsonValue;
};
export type CapabilityOptions = {
  signal?: AbortSignal;
  actor?: CapabilityActor;
  requestId?: string;
  expectedRevision?: string;
  /** Remote adapters resolve true only after the result reaches its caller. */
  resultDelivery?: Promise<boolean>;
  /** Track only serialized deferred requests, so normal transport EOF can drain them. */
  onAfterResult?: (completion: Promise<void>) => void;
};
export type CapabilityContext = {
  signal: AbortSignal;
  actor: CapabilityActor;
  requestId: string;
  expectedRevision?: string;
  emit: (type: string, data: unknown) => void;
  /** Defer one lifecycle action until result delivery, retaining cancellation. */
  afterResult: (action: () => void) => void;
};
export type CapabilityDefinition<Input = unknown> = {
  id: string;
  kind: 'query' | 'command';
  description: string;
  inputSchema: CapabilitySchema;
  mutation?: CapabilityMutation;
  review?: CapabilityReview;
  /** Every registration declares its architectural owner. */
  owner: CapabilityOwner;
  /** Domain abstraction, omitted for infrastructure and presentation controls. */
  level?: CapabilityLevel;
  plugin?: string;
  /** true enables the capability; a string is an actionable unavailable reason. */
  available?: () => boolean | string;
  handler: (input: Input, context: CapabilityContext) => unknown | Promise<unknown>;
};
export type CapabilityDescription = {
  id: string;
  kind: 'query' | 'command';
  description: string;
  inputSchema: CapabilitySchema;
  mutation: CapabilityMutation;
  review: CapabilityReview;
  owner: CapabilityOwner;
  level?: CapabilityLevel;
  plugin?: string;
  available: boolean;
  reason?: string;
};
export type CapabilityObservation = {
  cursor: number;
  events: CapabilityEvent[];
  truncated: boolean;
};
export type CapabilityHost = {
  register: <Input = unknown>(definition: CapabilityDefinition<Input>) => () => void;
  catalog: () => CapabilityDescription[];
  query: (id: string, input?: unknown, options?: CapabilityOptions) => Promise<unknown>;
  execute: (id: string, input?: unknown, options?: CapabilityOptions) => Promise<unknown>;
  emit: (type: string, data: unknown) => void;
  observe: (after?: number) => CapabilityObservation;
  subscribe: (listener: (event: CapabilityEvent) => void) => () => void;
  suspend: (reason: string) => void;
  resume: () => void;
  dispose: () => void;
};

type Entry = {
  definition: CapabilityDefinition<any>;
  validate: (value: unknown) => CapabilityValidation;
  active: Set<AbortController>;
};

export const emptyCapabilityInput = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} satisfies CapabilitySchema;

function cancelled() {
  const error = new Error('The capability request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Reject lossy JSON coercions (undefined, nonfinite numbers, cycles, class instances). */
function copyJson(value: unknown, limit: number): JsonValue {
  const ancestors = new Set<object>();
  function inspect(item: unknown, depth: number): void {
    if (depth > 128) throw new Error('Capability data exceeds the supported nesting depth.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') throw new Error('Capability data must contain only JSON values.');
    if (ancestors.has(item))
      throw new Error('Capability data must not contain circular references.');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error('Capability data must contain only JSON objects.');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (!(index in item)) throw new Error('Capability arrays must not contain empty elements.');
        inspect(item[index], depth + 1);
      }
    } else {
      for (const nested of Object.values(item)) inspect(nested, depth + 1);
    }
    ancestors.delete(item);
  }
  inspect(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > limit)
    throw new Error('Capability data exceeds the supported size.');
  return JSON.parse(text) as JsonValue;
}

/** A renderer/Node-independent registry shared by human and Agent adapters. */
export function createCapabilityHost(
  hostOptions: {
    eventLimit?: number;
    maxDataBytes?: number;
    maxEventBytes?: number;
    now?: () => Date;
    revision?: () => string;
  } = {},
): CapabilityHost {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: CapabilityEvent) => void>();
  const events: CapabilityEvent[] = [];
  const eventLimit = Math.max(1, Math.min(2000, hostOptions.eventLimit ?? 256));
  const maxDataBytes = hostOptions.maxDataBytes ?? 32 * 1024 * 1024;
  const maxEventBytes = hostOptions.maxEventBytes ?? 64 * 1024;
  let sequence = 0;
  let requestSequence = 0;
  let disposed = false;
  let suspended: string | null = null;
  function emit(type: string, data: unknown) {
    if (disposed) return;
    if (!/^[a-zA-Z][a-zA-Z0-9._:-]{0,127}$/.test(type))
      throw new Error('Invalid capability event type.');
    const payload = copyJson(data, maxEventBytes);
    const event: CapabilityEvent = {
      seq: ++sequence,
      time: (hostOptions.now?.() ?? new Date()).toISOString(),
      type,
      data: payload,
    };
    events.push(event);
    if (events.length > eventLimit) events.splice(0, events.length - eventLimit);
    for (const listener of listeners) {
      // Observers cannot interrupt the operation or other observers.
      try {
        listener(copyJson(event, maxEventBytes + 1024) as CapabilityEvent);
      } catch {}
    }
  }
  function availability(entry: Entry): { available: boolean; reason?: string } {
    if (suspended && entry.definition.kind === 'command')
      return { available: false, reason: suspended };
    try {
      const value = entry.definition.available?.() ?? true;
      return value === true
        ? { available: true }
        : {
            available: false,
            reason: typeof value === 'string' ? value : 'This capability is currently unavailable.',
          };
    } catch (error) {
      return {
        available: false,
        reason:
          error instanceof Error ? error.message : 'This capability is currently unavailable.',
      };
    }
  }
  function requireRevision(kind: 'query' | 'command', expectedRevision: string | undefined) {
    if (
      kind === 'command' &&
      expectedRevision !== undefined &&
      hostOptions.revision &&
      expectedRevision !== hostOptions.revision()
    )
      throw new Error(
        'The project changed since this command was prepared. Query the current project and try again.',
      );
  }
  async function invoke(
    kind: 'query' | 'command',
    id: string,
    input: unknown,
    options: CapabilityOptions = {},
  ) {
    if (disposed) throw new Error('The capability host is closed.');
    if (options.signal?.aborted) throw cancelled();
    const entry = entries.get(id);
    if (!entry || entry.definition.kind !== kind)
      throw new Error(`Unknown ${kind} capability: ${id}.`);
    requireRevision(kind, options.expectedRevision);
    const data = copyJson(input === undefined ? {} : input, maxDataBytes);
    const validation = entry.validate(data);
    if (!validation.valid) throw new Error(`Invalid input for ${id}: ${validation.error}.`);
    const state = availability(entry);
    if (!state.available) throw new Error(state.reason);
    const control = new AbortController();
    const abort = () => control.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    entry.active.add(control);
    const requestId = options.requestId ?? `capability-${++requestSequence}`;
    const actor = options.actor ?? 'human';
    const details = { id, requestId, actor };
    const revision = hostOptions.revision?.();
    let deferred: (() => void) | undefined;
    let waitingForDelivery = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishDeferred: (() => void) | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      entry.active.delete(control);
      options.signal?.removeEventListener('abort', abort);
      control.signal.removeEventListener('abort', cleanup);
      finishDeferred?.();
    };
    try {
      emit('capability.started', details);
      // Availability predicates and event observers may synchronously revoke
      // this registration or close the workspace before the handler starts.
      if (
        control.signal.aborted ||
        disposed ||
        entries.get(id) !== entry ||
        (suspended && kind === 'command')
      ) {
        control.abort();
        throw cancelled();
      }
      // Synchronous availability/started observers can also advance the project.
      requireRevision(kind, options.expectedRevision);
      const result = await entry.definition.handler(data, {
        signal: control.signal,
        actor,
        requestId,
        emit,
        afterResult(action) {
          if (kind !== 'command' || deferred || typeof action !== 'function')
            throw new Error('Only commands may defer one lifecycle action.');
          deferred = action;
        },
        ...(options.expectedRevision !== undefined
          ? { expectedRevision: options.expectedRevision }
          : {}),
      });
      if (control.signal.aborted) throw cancelled();
      const output = copyJson(result ?? null, maxDataBytes);
      emit('capability.completed', details);
      if (deferred && !control.signal.aborted) {
        const completion = new Promise<void>((resolve) => {
          finishDeferred = resolve;
        });
        options.onAfterResult?.(completion);
        if (control.signal.aborted) {
          cleanup();
          return output;
        }
        waitingForDelivery = true;
        control.signal.addEventListener('abort', cleanup, { once: true });
        // The result is already serialized. Keep its original authority alive
        // until transport acknowledgement, then dispatch outside this call stack.
        void (options.resultDelivery ?? Promise.resolve(true)).then(
          (delivered) => {
            if (!delivered || control.signal.aborted) {
              control.abort();
              cleanup();
              return;
            }
            timer = setTimeout(() => {
              try {
                if (control.signal.aborted || disposed || entries.get(id) !== entry || suspended)
                  throw cancelled();
                const state = availability(entry);
                if (!state.available) throw new Error(state.reason);
                if (revision !== undefined && hostOptions.revision?.() !== revision)
                  throw new Error('The project changed before the lifecycle action started.');
                // Availability/revision adapters can synchronously revoke authority.
                if (control.signal.aborted || disposed || entries.get(id) !== entry || suspended)
                  throw cancelled();
                deferred!();
              } catch (error) {
                emit(control.signal.aborted ? 'capability.cancelled' : 'capability.failed', {
                  ...details,
                  message:
                    error instanceof Error
                      ? error.message.slice(0, 2048)
                      : 'The lifecycle action failed.',
                });
              } finally {
                cleanup();
              }
            }, 0);
          },
          () => {
            control.abort();
            cleanup();
          },
        );
      }
      return output;
    } catch (error) {
      emit(control.signal.aborted ? 'capability.cancelled' : 'capability.failed', {
        ...details,
        message:
          error instanceof Error ? error.message.slice(0, 2048) : 'Capability execution failed.',
      });
      throw error;
    } finally {
      if (!waitingForDelivery) cleanup();
    }
  }
  const host: CapabilityHost = {
    register(definition) {
      if (disposed) throw new Error('The capability host is closed.');
      if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,159}$/.test(definition.id))
        throw new Error('Invalid capability ID.');
      if (entries.has(definition.id))
        throw new Error(`Capability ${definition.id} is already registered.`);
      if (definition.kind === 'query' && definition.mutation)
        throw new Error('A query capability cannot mutate state.');
      const owner = definition.owner;
      if (!['core', 'host', 'plugin', 'api'].includes(owner))
        throw new Error('Invalid capability owner.');
      if (
        definition.level !== undefined &&
        !['object', 'operation', 'task'].includes(definition.level)
      )
        throw new Error('Invalid capability abstraction level.');
      if (
        definition.plugin !== undefined &&
        (typeof definition.plugin !== 'string' || !definition.plugin.trim())
      )
        throw new Error('A plugin capability needs a nonempty plugin identity.');
      if ((owner === 'plugin') !== (definition.plugin !== undefined))
        throw new Error(
          'Only a plugin owner may declare a plugin identity, and it must declare one.',
        );
      const schema = copyJson(definition.inputSchema, maxEventBytes) as CapabilitySchema;
      const entry: Entry = {
        definition: { ...definition, owner, inputSchema: schema as CapabilitySchema },
        validate: compileCapabilitySchema(schema),
        active: new Set(),
      };
      const id = entry.definition.id;
      entries.set(id, entry);
      emit('capability.registered', { id });
      return () => {
        if (entries.get(id) !== entry) return;
        entries.delete(id);
        for (const control of entry.active) control.abort();
        emit('capability.unregistered', { id });
      };
    },
    catalog() {
      return [...entries.values()].map((entry) => {
        const {
          id,
          kind,
          description,
          inputSchema,
          mutation = false,
          review = 'none',
          owner,
          level,
          plugin,
        } = entry.definition;
        return copyJson(
          {
            id,
            kind,
            description,
            inputSchema,
            mutation,
            review,
            owner,
            ...(level ? { level } : {}),
            ...(plugin ? { plugin } : {}),
            ...availability(entry),
          },
          maxDataBytes,
        ) as CapabilityDescription;
      });
    },
    query: (id, input, options) => invoke('query', id, input, options),
    execute: (id, input, options) => invoke('command', id, input, options),
    emit,
    observe(after = 0) {
      if (!Number.isSafeInteger(after) || after < 0)
        throw new Error('Choose a nonnegative event cursor.');
      return {
        cursor: sequence,
        events: events
          .filter((event) => event.seq > after)
          .map((event) => copyJson(event, maxEventBytes + 1024) as CapabilityEvent),
        truncated: !!events.length && after < events[0].seq - 1,
      };
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    suspend(reason) {
      suspended = reason || 'This workspace is closing.';
      for (const entry of entries.values()) for (const control of entry.active) control.abort();
      emit('workspace.suspended', { reason: suspended });
    },
    resume() {
      if (!suspended || disposed) return;
      suspended = null;
      emit('workspace.resumed', {});
    },
    dispose() {
      if (disposed) return;
      for (const entry of entries.values()) for (const control of entry.active) control.abort();
      entries.clear();
      listeners.clear();
      events.length = 0;
      disposed = true;
    },
  };
  host.register({
    id: 'capabilities.list',
    kind: 'query',
    owner: 'api',
    description:
      'Discover current capabilities. Use includeSchema:false for a compact index, prefix/kind to narrow a domain, or ids to retrieve only the exact schemas needed. Availability remains live.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 160 },
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
        },
        prefix: { type: 'string', minLength: 1, maxLength: 160 },
        kind: { enum: ['query', 'command'] },
        includeSchema: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: (input) => {
      const filter = input as {
        ids?: string[];
        prefix?: string;
        kind?: string;
        includeSchema?: boolean;
      };
      const selected = host
        .catalog()
        .filter(
          (item) =>
            (!filter.ids || filter.ids.includes(item.id)) &&
            (!filter.prefix || item.id.startsWith(filter.prefix)) &&
            (!filter.kind || item.kind === filter.kind),
        );
      if (filter.ids?.some((id) => !entries.has(id)))
        throw new Error(
          'An explicitly requested capability is not registered. Refresh the compact capability index.',
        );
      return filter.includeSchema === false
        ? selected.map(({ inputSchema: _schema, ...item }) => item)
        : selected;
    },
  });
  return host;
}
