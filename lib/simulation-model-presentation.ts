import profiles from './example-simulation.json';
import { simulationModelDefinitions } from './simulation-models';
import { lm2596AdjustableDerivedModel, referenceModels, tiModels } from './ti-dcdc';
import type { Circuit, Part } from './circuit';
import { partFields } from './library';
import { storagePrimitive, initialConditionField } from './simulation-initial-conditions';
import { exampleSimulationProfile } from './spice-examples';
import { isEmcFlyback, emcFlybackCapacitors, emcFlybackResistors } from './spice-emc-flyback';
import { emcFlybackCapacitorEsr, emcFlybackInitialNodeGroups } from './emc-flyback-initial-state';
import { spiceNets } from './spice';
import { participatesInSimulation } from './simulation-participation';
import { isModelBuck } from './spice-buck';
import {
  basicSimulationAvailable,
  basicSimulationKind,
  simulationModelSource,
  effectiveSimulationModelFields,
} from './simulation-model-source';

// Native model identities remain authoritative. The inspector presents their
// colocated files without rewriting a model assignment just by viewing it.
const filesById = new Map(simulationModelDefinitions.map((model) => [model.id, model.file]));
const libraryFiles = new Map<string, string>();
for (const model of [...tiModels, ...referenceModels])
  libraryFiles.set(`TI:${model.id}`, filesById.get(model.id)!);
libraryFiles.set(
  lm2596AdjustableDerivedModel.library,
  filesById.get(lm2596AdjustableDerivedModel.sourceModelId)!,
);
for (const profile of profiles.profiles)
  for (const part of profile.parts) {
    const library = (part.sim as Record<string, string>)['Sim.Library'];
    const file = filesById.get(part.modelId);
    if (library && file) libraryFiles.set(library, file);
  }

export function simulationLibraryPath(library: string): string {
  return libraryFiles.get(library) ?? library;
}

export function simulationLibraryForPath(file: string, current: string): string {
  if (simulationLibraryPath(current) === file) return current;
  return [...libraryFiles].find(([, path]) => path === file)?.[0] ?? file;
}

/** The reviewed adjustable derivative is prepared from this exact source declaration. */
export function simulationLibraryModelName(library: string, name: string): string {
  return library === lm2596AdjustableDerivedModel.library &&
    name === lm2596AdjustableDerivedModel.subcircuit
    ? lm2596AdjustableDerivedModel.sourceSubcircuit
    : name;
}

export function simulationLibraryDeclaration<T extends { name: string }>(
  library: string,
  name: string,
  declarations: readonly T[],
): T | undefined {
  const expected = simulationLibraryModelName(library, name);
  return declarations.find((declaration) => declaration.name === expected);
}

export function simulationComponentPresentation(part: Part, circuit?: Circuit) {
  const stored = partFields(part);
  const basicAvailable = basicSimulationAvailable(part);
  const fields =
      simulationModelSource(stored) === 'basic' && basicAvailable
        ? effectiveSimulationModelFields(part, stored)
        : stored,
    primitive = storagePrimitive(part);
  let model = fields['Sim.Name'] || 'Model not assigned';
  let initial = 'Computed';
  if (primitive) model = `ngspice ${primitive}`;
  else if (fields['Sim.Device'] === 'R' || /^Device:R(?:_|$)/.test(part.libId)) model = 'ngspice R';
  else if (fields['Sim.Device'] === 'V')
    model = fields['Sim.Type'] ? `${fields['Sim.Type']} voltage source` : 'Voltage source';
  else if (fields['Sim.Device'] === 'I')
    model = fields['Sim.Type'] ? `${fields['Sim.Type']} current source` : 'Current source';
  if (circuit) {
    if (isEmcFlyback(circuit)) {
      if (emcFlybackCapacitors.includes(part.ref)) {
        const nets = spiceNets(circuit, ['PGND', 'SGND']);
        const node = (ref: string, pin: string) => {
          const owner = circuit.parts.find((p) => p.ref === ref);
          if (!owner) throw new Error('Missing EMC initial-state terminal.');
          return nets.node(owner, pin);
        };
        try {
          const voltages = new Map(emcFlybackInitialNodeGroups(node).flat());
          const positive = emcFlybackCapacitorEsr[part.ref]
            ? `emc_${part.ref}`
            : node(part.ref, '1');
          const negative = node(part.ref, '2');
          initial = String(
            Number(((voltages.get(positive) ?? 0) - (voltages.get(negative) ?? 0)).toPrecision(12)),
          );
        } catch {
          initial = 'Unavailable';
        }
      } else if (emcFlybackResistors.includes(part.ref)) model = 'ngspice R';
      else if (['V1', 'V2', 'I1'].includes(part.ref)) initial = 'Computed';
      else {
        model =
          (
            {
              Q1: 'EMC_IRF520N',
              D2: 'EMC_ES2D',
              D3: 'EMC_SS510C',
              D7: 'EMC_SS510C',
              U1: 'UC3845B',
              U3: 'TL431B',
              U4: 'LTV817',
              T1: 'Coupled inductors',
              RG: 'Zero-volt sense source',
            } as Record<string, string>
          )[part.ref] || 'Not modeled';
        initial = 'Not modeled';
      }
    } else {
      let profile: ReturnType<typeof exampleSimulationProfile>;
      try {
        profile = exampleSimulationProfile(circuit);
      } catch {
        profile = undefined;
      }
      const definition = profile?.parts.find((p) => p.ref === part.ref);
      if (definition?.modelName) model = definition.modelName;
      else if (
        definition &&
        !['R', 'C', 'L', 'V', 'unsupported', 'excluded', 'T'].includes(definition.kind)
      )
        model = `OPENPE_DEFAULT_${fields['Sim.Device'] || definition.kind}`;
      else if (part.libId === 'Transistor_FET:IRF540N') model = 'IRF540N';
      else if (!profile && part.libId === 'Simulation_SPICE:D' && isModelBuck(circuit))
        model = 'OPENPE_DEMO_D';
      else if (!profile && part.libId === 'Device:D_Schottky') model = 'OPENPE_DIODE';
      const explicit = circuit.parts.some((p) => {
        const kind = storagePrimitive(p);
        return (
          kind &&
          participatesInSimulation(p) &&
          partFields(p)[initialConditionField(kind)] !== undefined
        );
      });
      if (profile?.initialConditions || explicit) initial = '0';
    }
  }
  if (part.excludeFromSimulation) model = 'Excluded from simulation';
  if (primitive && fields[initialConditionField(primitive)] !== undefined)
    initial = fields[initialConditionField(primitive)] || 'Invalid value';
  return {
    basicModel:
      basicAvailable && ['R', 'C', 'L'].includes(basicSimulationKind(part) || '')
        ? `ngspice ${basicSimulationKind(part)}`
        : model.replace(/^OPENPE_(?:DERIVED_)?/i, ''),
    model: fields['Sim.Library']
      ? simulationLibraryPath(fields['Sim.Library'])
      : model.replace(/^OPENPE_(?:DERIVED_)?/i, ''),
    initial,
  };
}
