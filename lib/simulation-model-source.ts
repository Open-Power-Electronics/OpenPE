import type { Part } from './circuit';
import { partFields } from './library';
import examples from './example-simulation.json';
import references from './reference-simulation.json';

export type SimulationModelSource = 'basic' | 'external';
export type BasicSimulationKind = 'R' | 'C' | 'L' | 'V' | 'I' | 'D' | 'Q' | 'M';
type BasicDefinition = {
  libId: string;
  kind: string;
  sim: Partial<Record<string, string>>;
  modelId: string;
  modelName: string;
};
const definitions = (
  [...examples.profiles, ...references.profiles] as { parts: BasicDefinition[] }[]
).flatMap((profile) => profile.parts);

/** Current native KiCad bindings define the mode unless an explicit override is stored. */
export function simulationModelSource(fields: Record<string, string>): SimulationModelSource {
  const mode = fields['OpenPE.ModelSource'];
  if (mode !== undefined && mode !== 'basic' && mode !== 'external')
    throw new Error('Use basic or external for the simulation model source.');
  return mode ?? (fields['Sim.Library']?.trim() ? 'external' : 'basic');
}

export function basicSimulationKind(part: Pick<Part, 'libId'>): BasicSimulationKind | null {
  if (part.libId === 'Simulation_SPICE:IPULSE') return 'I';
  if (
    [
      'Device:R',
      'Device:R_Small',
      'Device:C',
      'Device:C_Small',
      'Device:C_Polarized',
      'Device:L',
      'Device:L_Small',
      'Device:L_Iron',
    ].includes(part.libId)
  ) {
    const kind = part.libId.split(':')[1][0];
    return kind as 'R' | 'C' | 'L';
  }
  const definition = definitions.find(
    (candidate) =>
      candidate.libId === part.libId &&
      (['R', 'C', 'L', 'V'].includes(candidate.kind) ||
        (['D', 'Q', 'M'].includes(candidate.kind) && !candidate.modelId && !candidate.modelName)),
  );
  return definition ? (definition.kind as BasicSimulationKind) : null;
}

export function basicSimulationAvailable(part: Pick<Part, 'libId'>): boolean {
  return basicSimulationKind(part) !== null;
}

/** Symbol-owned device family survives selecting a SUBCKT instance override.
 * Ambiguous or unreviewed transistor polarity is never inferred from its pins. */
export function reviewedSimulationDevice(part: Pick<Part, 'libId'>): string | null {
  if (part.libId === 'Transistor_FET:IRF540N' || part.libId === 'Transistor_FET:IRF520N')
    return 'NMOS';
  const candidates = definitions.filter((definition) => definition.libId === part.libId);
  const devices = [
    ...new Set(
      candidates
        .map((definition) => definition.sim['Sim.Device'])
        .filter((device): device is string => !!device),
    ),
  ];
  if (devices.length === 1) return devices[0];
  if (devices.length > 1) return null;
  const kind = basicSimulationKind(part);
  return kind && ['R', 'C', 'L', 'V', 'I', 'D'].includes(kind) ? kind : null;
}

/** These two reviewed MOSFET mappings intentionally differ: the KiCad Buck's
 * stored Sim.Pins is authoritative even though its drawn labels exchange G/D. */
export function reviewedSimulationPins(part: Pick<Part, 'libId'>): string | null {
  if (part.libId === 'Transistor_FET:IRF540N') return '1=D 2=G 3=S';
  if (part.libId === 'Transistor_FET:IRF520N') return '1=G 2=D 3=S';
  const mappings = [
    ...new Set(
      definitions
        .filter((definition) => definition.libId === part.libId)
        .map((definition) => definition.sim['Sim.Pins'])
        .filter((pins): pins is string => !!pins),
    ),
  ];
  if (mappings.length === 1) return mappings[0];
  if (mappings.length > 1) return null;
  const kind = basicSimulationKind(part);
  return kind && ['R', 'C', 'L', 'V', 'I'].includes(kind) ? '1=+ 2=-' : null;
}

export function assertSimulationModelConfiguration(part: Part, fields = partFields(part)): void {
  const explicit = fields['OpenPE.ModelSource'];
  simulationModelSource(fields);
  if (
    fields['OpenPE.SourceType'] !== undefined &&
    (!['V', 'I'].includes(basicSimulationKind(part) || '') ||
      !['DC', 'PULSE', 'SIN'].includes(fields['OpenPE.SourceType']))
  )
    throw new Error(`${part.ref}: unsupported source waveform.`);
  if (explicit === 'basic' && !basicSimulationAvailable(part))
    throw new Error(`${part.ref}: no basic simulation model is available for this component.`);
  if (explicit === 'external' && (!fields['Sim.Library']?.trim() || !fields['Sim.Name']?.trim()))
    throw new Error(`${part.ref}: choose an external model file and model name before running.`);
  if (
    explicit === 'external' &&
    !['C', 'L'].includes(basicSimulationKind(part) ?? '') &&
    (fields['OpenPE.InitialVoltage'] !== undefined || fields['OpenPE.InitialCurrent'] !== undefined)
  )
    throw new Error(
      `${part.ref}: primitive initial conditions are not supported by this external model.`,
    );
}

/** Only the active model's effective fields reach compilation. Retained external
 * binding data remains untouched in Source, Save, recovery and whole-project undo. */
export function effectiveSimulationModelFields(
  part: Part,
  fields: Record<string, string>,
  reviewedDefaults?: Record<string, string>,
): Record<string, string> {
  simulationModelSource(fields);
  const result = { ...fields };
  if (
    simulationModelSource(fields) === 'basic' &&
    ['V', 'I'].includes(basicSimulationKind(part) || '') &&
    fields['OpenPE.SourceType']
  )
    result['Sim.Type'] = fields['OpenPE.SourceType'];
  if (fields['OpenPE.ModelSource'] !== 'basic') return result;
  if (!basicSimulationAvailable(part)) return result;
  for (const name of ['Sim.Library', 'Sim.Name', 'Sim.Device', 'Sim.Type', 'Sim.Pins'])
    delete result[name];
  const kind = basicSimulationKind(part)!;
  const definition = definitions.find(
    (candidate) => candidate.libId === part.libId && candidate.kind === kind,
  );
  const defaults =
    reviewedDefaults ??
    definition?.sim ??
    (kind === 'I'
      ? { 'Sim.Device': 'I', 'Sim.Type': 'PULSE', 'Sim.Pins': '1=+ 2=-' }
      : ['R', 'C', 'L'].includes(kind)
        ? { 'Sim.Device': kind, 'Sim.Type': '=', 'Sim.Pins': '1=+ 2=-' }
        : {});
  for (const name of ['Sim.Device', 'Sim.Type', 'Sim.Pins'])
    if (defaults[name] !== undefined) result[name] = defaults[name];
  if (['V', 'I'].includes(kind) && fields['OpenPE.SourceType'])
    result['Sim.Type'] = fields['OpenPE.SourceType'];
  return result;
}
