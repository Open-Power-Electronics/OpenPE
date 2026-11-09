import { emptyCapabilityInput, type CapabilityHost } from '../api/capabilities';
import { thermalConfigSchema, type ThermalConfig } from './thermal';

export type ThermalConfigurationInput = { config: Partial<ThermalConfig> };
export type ThermalProbeInput = { point: { x: number; y: number; z?: number } | null };
export type ThermalCapabilityAdapter = {
  available: () => boolean | string;
  canRun: () => boolean | string;
  read: () => unknown;
  configure: (input: ThermalConfigurationInput, signal: AbortSignal) => Promise<unknown>;
  run: (signal: AbortSignal) => Promise<unknown>;
  cancel: () => unknown;
  probe: (input: ThermalProbeInput, signal: AbortSignal) => Promise<unknown>;
  exportImage: (signal: AbortSignal) => Promise<unknown>;
  canImport?: () => boolean | string;
  importSpice?: (input: Record<string, never>, signal: AbortSignal) => Promise<unknown>;
};

/** Settings and displayed results are session state; completed runs also write host-owned records. */
export function registerThermalCapabilities(
  host: CapabilityHost,
  adapter: ThermalCapabilityAdapter,
) {
  const shared = { plugin: 'pcb-thermal@openpe', available: () => adapter.available() };
  const remove = [
    host.register({
      owner: 'plugin',
      ...shared,
      id: 'thermal.status',
      kind: 'query',
      description:
        'Read PCB thermal settings, Gmsh and Elmer availability, run status, board-temperature statistics and the selected real solver node.',
      inputSchema: emptyCapabilityInput,
      handler: () => adapter.read(),
    }),
    host.register<ThermalConfigurationInput>({
      owner: 'plugin',
      ...shared,
      id: 'thermal.configure',
      kind: 'command',
      description:
        'Update session thermal inputs: ambient in °C, convection in W/(m²·K), conductivity in W/(m·K), geometry in mm and each footprint heat input in W into the board. Heat sources replace the complete list.',
      mutation: 'session',
      review: 'none',
      inputSchema: {
        type: 'object',
        required: ['config'],
        properties: {
          config: { ...thermalConfigSchema, required: [], minProperties: 1 },
        },
        additionalProperties: false,
      },
      handler: (input, { signal }) => adapter.configure(input, signal),
    }),
    host.register({
      owner: 'plugin',
      ...shared,
      id: 'thermal.importSpice',
      kind: 'command',
      description:
        'Load heat inputs from a verified matching completed SPICE result, using signed average terminal V·I over full-resolution native samples in the final 20% of the transient. No solver is started. Only supported dissipative paths with linked PCB footprints are included; the assumed heat into pads remains an analysis input.',
      mutation: 'session',
      review: 'none',
      available: () =>
        adapter.available() === true
          ? (adapter.canImport?.() ??
            (adapter.importSpice ? true : 'SPICE heat-source import is unavailable.'))
          : adapter.available(),
      inputSchema: emptyCapabilityInput,
      handler: (input: Record<string, never>, { signal }) => adapter.importSpice!(input, signal),
    }),
    host.register({
      owner: 'plugin',
      ...shared,
      id: 'thermal.run',
      kind: 'command',
      description:
        'Refresh verified completed electrical losses when SPICE heat input is selected, then mesh the current PCB with Gmsh and solve steady board temperatures with Elmer. Open Thermal in Layout first. Desktop projects must be saved; the latest successful run and its process files are saved beside the project, outside design content.',
      mutation: 'external',
      review: 'optional',
      available: () => (adapter.available() === true ? adapter.canRun() : adapter.available()),
      inputSchema: emptyCapabilityInput,
      handler: (_input, { signal }) => adapter.run(signal),
    }),
    host.register({
      owner: 'plugin',
      ...shared,
      id: 'thermal.cancel',
      kind: 'command',
      description:
        'Stop the active thermal heat-source import, mesh or solver process. Incomplete temperature fields are discarded.',
      mutation: 'session',
      review: 'none',
      inputSchema: emptyCapabilityInput,
      handler: () => adapter.cancel(),
    }),
    host.register<ThermalProbeInput>({
      owner: 'plugin',
      ...shared,
      id: 'thermal.probe',
      kind: 'command',
      description:
        'Inspect the closest real thermal solver node to a point in PCB millimetres, or clear the probe. Omitting z uses the visible board surface.',
      mutation: 'session',
      review: 'none',
      inputSchema: {
        type: 'object',
        required: ['point'],
        properties: {
          point: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['x', 'y'],
                properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                additionalProperties: false,
              },
            ],
          },
        },
        additionalProperties: false,
      },
      handler: (input, { signal }) => adapter.probe(input, signal),
    }),
    host.register({
      owner: 'plugin',
      ...shared,
      id: 'thermal.exportImage',
      kind: 'command',
      description:
        'Export the visible solved board-temperature map, scale and probe to PNG using the native image picker.',
      mutation: 'external',
      review: 'optional',
      inputSchema: emptyCapabilityInput,
      handler: (_input, { signal }) => adapter.exportImage(signal),
    }),
  ];
  host.emit('thermal.ready', { plugin: shared.plugin });
  return () => {
    for (const dispose of remove.reverse()) dispose();
  };
}
