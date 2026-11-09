import { emptyCapabilityInput, type CapabilityHost } from '../api/capabilities';
import type { ProbeTarget, TransientConfig } from './spice';
import type { WaveformAxis } from './waveform-view';

export type SimulationNumericKey = 'voltage' | 'frequency' | 'duty' | 'stop' | 'step';
export type SimulationSelectionKey = 'inputId' | 'pwmId' | 'outputId' | 'switchId' | 'currentId';
export type SimulationConfigurationInput = {
  /** Numeric settings use V, Hz, percent, seconds and seconds respectively. */
  config?: Partial<Pick<TransientConfig, SimulationNumericKey | SimulationSelectionKey>>;
  /** Text drafts use the units displayed in the settings card and may be incomplete. */
  drafts?: Partial<Record<SimulationNumericKey, string>>;
};
export type SimulationProbesInput = { target?: ProbeTarget | null; selected?: string[] };
export type SimulationPresentationInput = {
  layout?: string;
  linked?: boolean;
  visibleCursors?: [boolean, boolean];
  cursor?: { vector: string; which: 0 | 1; time: number };
  view?: {
    vector: string;
    range?: 'full' | 'tail';
    time?: WaveformAxis | null;
    values?: WaveformAxis | null;
    zoomMode?: boolean;
  };
  navigate?: { vector: string; direction: 'back' | 'forward' };
};
export type SimulationCapabilityAdapter = {
  available: () => boolean | string;
  canRun: () => boolean | string;
  read: () => unknown;
  configure: (input: SimulationConfigurationInput, signal: AbortSignal) => Promise<unknown>;
  probes: (input: SimulationProbesInput, signal: AbortSignal) => Promise<unknown>;
  run: (signal: AbortSignal) => Promise<unknown>;
  cancel: () => unknown;
};

const numericProperties = {
  voltage: { type: 'number' },
  frequency: { type: 'number' },
  duty: { type: 'number' },
  stop: { type: 'number', exclusiveMinimum: 0 },
  step: { type: 'number', exclusiveMinimum: 0 },
};
const selectionProperties = Object.fromEntries(
  ['inputId', 'pwmId', 'outputId', 'switchId', 'currentId'].map((key) => [
    key,
    { type: 'string', maxLength: 128 },
  ]),
);

/** Bundled plugin adapter: human controls and Agent commands share these handlers. */
export function registerSimulationCapabilities(
  host: CapabilityHost,
  adapter: SimulationCapabilityAdapter,
) {
  const shared = { plugin: 'spice-simulation@openpe', available: () => adapter.available() };
  const disposers = [
    host.register({
      owner: 'plugin',
      ...shared,
      id: 'simulation.status',
      kind: 'query',
      description:
        'Read simulation settings, support errors, probes, every trace, reduced curves and exact measurements.',
      inputSchema: emptyCapabilityInput,
      handler: () => adapter.read(),
    }),
    host.register<SimulationConfigurationInput>({
      owner: 'plugin',
      ...shared,
      id: 'simulation.configure',
      kind: 'command',
      description:
        'Update transient settings. Numeric config uses V, Hz, percent and seconds; drafts use the visible card units.',
      mutation: 'session',
      review: 'none',
      inputSchema: {
        type: 'object',
        minProperties: 1,
        properties: {
          config: {
            type: 'object',
            minProperties: 1,
            properties: { ...numericProperties, ...selectionProperties },
            additionalProperties: false,
          },
          drafts: {
            type: 'object',
            minProperties: 1,
            properties: Object.fromEntries(
              Object.keys(numericProperties).map((key) => [
                key,
                { type: 'string', maxLength: 128 },
              ]),
            ),
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      handler: (input, { signal }) => adapter.configure(input, signal),
    }),
    host.register<SimulationProbesInput>({
      owner: 'plugin',
      ...shared,
      id: 'simulation.probes',
      kind: 'command',
      description:
        'Probe a current or voltage target, clear the probe, or select visible waveform vectors.',
      mutation: 'session',
      review: 'none',
      inputSchema: {
        type: 'object',
        minProperties: 1,
        properties: {
          target: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['kind', 'id'],
                properties: {
                  kind: { enum: ['voltage', 'current'] },
                  id: { type: 'string', minLength: 1, maxLength: 128 },
                  pin: { type: 'number' },
                },
                additionalProperties: false,
              },
            ],
          },
          selected: {
            type: 'array',
            maxItems: 256,
            uniqueItems: true,
            items: { type: 'string', maxLength: 256 },
          },
        },
        additionalProperties: false,
      },
      handler: (input, { signal }) => adapter.probes(input, signal),
    }),
    host.register({
      owner: 'plugin',
      ...shared,
      id: 'simulation.run',
      kind: 'command',
      description:
        'Run the supported transient to completion with current settings, recording newly verified model references in the project. Opening Simulation is required; hiding it cancels the run.',
      mutation: 'document',
      review: 'optional',
      available: () => (adapter.available() === true ? adapter.canRun() : adapter.available()),
      inputSchema: emptyCapabilityInput,
      handler: (_input, { signal }) => adapter.run(signal),
    }),
    host.register({
      owner: 'plugin',
      ...shared,
      id: 'simulation.cancel',
      kind: 'command',
      revision: 'independent',
      description:
        'Stop the active transient run and retain received samples as partial results for inspection.',
      mutation: 'session',
      review: 'none',
      inputSchema: emptyCapabilityInput,
      handler: () => adapter.cancel(),
    }),
  ];
  host.emit('simulation.ready', { plugin: shared.plugin });
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

export function registerSimulationPresentationCapability(
  host: CapabilityHost,
  adapter: {
    available: () => boolean | string;
    apply: (input: SimulationPresentationInput, signal: AbortSignal) => Promise<unknown>;
  },
) {
  const axis = {
    type: 'object',
    required: ['min', 'max'],
    properties: {
      min: { type: 'number' },
      max: { type: 'number' },
      step: { type: 'number', exclusiveMinimum: 0 },
    },
    additionalProperties: false,
  };
  const vector = { type: 'string', minLength: 1, maxLength: 256 };
  return host.register<SimulationPresentationInput>({
    owner: 'plugin',
    id: 'simulation.presentation',
    kind: 'command',
    description:
      'Set waveform layout, linked/visible cursors, cursor times, per-trace time/value axes, zoom mode or view history. Times use seconds; values use the trace unit.',
    mutation: 'session',
    review: 'none',
    plugin: 'spice-simulation@openpe',
    available: adapter.available,
    inputSchema: {
      type: 'object',
      minProperties: 1,
      additionalProperties: false,
      properties: {
        layout: { type: 'string', pattern: '^(auto|[1-3]x[1-4])$' },
        linked: { type: 'boolean' },
        visibleCursors: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'boolean' } },
        cursor: {
          type: 'object',
          required: ['vector', 'which', 'time'],
          properties: { vector, which: { enum: [0, 1] }, time: { type: 'number' } },
          additionalProperties: false,
        },
        view: {
          type: 'object',
          required: ['vector'],
          minProperties: 2,
          properties: {
            vector,
            range: { enum: ['full', 'tail'] },
            time: { anyOf: [axis, { type: 'null' }] },
            values: { anyOf: [axis, { type: 'null' }] },
            zoomMode: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        navigate: {
          type: 'object',
          required: ['vector', 'direction'],
          properties: { vector, direction: { enum: ['back', 'forward'] } },
          additionalProperties: false,
        },
      },
    },
    handler: (input, { signal }) => adapter.apply(input, signal),
  });
}
