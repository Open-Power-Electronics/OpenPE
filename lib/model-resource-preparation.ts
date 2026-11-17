import type { Circuit, Part } from './circuit';
import type { Footprint, FootprintModel } from './pcb';
import type { SpiceModelDeclaration } from './bridge';
import { partFields } from './library';
import { validateFootprintModelPath } from './pcb-properties';
import {
  basicSimulationAvailable,
  basicSimulationKind,
  canSelectPassiveSimulationModel,
  isPassiveSimulationModel,
  simulationModelSource,
  type PassiveSimulationModel,
} from './simulation-model-source';
import {
  simulationLibraryForPath,
  simulationLibraryDeclaration,
  simulationLibraryModelName,
} from './simulation-model-presentation';
import { externalModelBinding, externalModelBindingFields } from './simulation-model-binding';

/** Shared GUI/Agent preparation; the host supplies the verified resource path. */
export function prepareFootprintModelSelection(footprint: Footprint, index: number, path: string) {
  validateFootprintModelPath(path);
  const models = footprint.models ?? [];
  if (!Number.isInteger(index) || index < 0 || index > models.length)
    throw new Error('Choose an existing model index or append at the end.');
  const next: FootprintModel[] = models.slice();
  next[index] = models[index]
    ? { ...models[index], path }
    : {
        path,
        offset: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      };
  return next;
}

export function prepareSimulationLibrarySelection(
  part: Part,
  current: Record<string, string>,
  path: string,
  declarations: readonly SpiceModelDeclaration[],
) {
  const library = simulationLibraryForPath(path, current['Sim.Library'] || '');
  const sameFile = library === current['Sim.Library'];
  const name = current['Sim.Name'];
  if (sameFile && name && !simulationLibraryDeclaration(library, name, declarations))
    throw new Error(
      `This library does not contain model "${simulationLibraryModelName(library, name)}". Choose a matching model.`,
    );
  const fields: Record<string, string> = { ...current, 'Sim.Library': library };
  if (!sameFile) {
    fields['OpenPE.ModelSource'] ??=
      simulationModelSource(current) === 'external' || !basicSimulationAvailable(part)
        ? 'external'
        : 'basic';
    delete fields['Sim.Name'];
  }
  return fields;
}

export function prepareSimulationModelSelection(
  circuit: Circuit | undefined,
  part: Part,
  current: Record<string, string>,
  selection:
    | { source: 'basic'; passiveModel?: PassiveSimulationModel | null }
    | {
        source: 'external';
        name: string;
        declarations?: readonly SpiceModelDeclaration[];
        mapping?: Record<string, string>;
      },
) {
  if (selection.source === 'basic') {
    const fields: Record<string, string> = { ...current, 'OpenPE.ModelSource': 'basic' };
    if (selection.passiveModel === null) {
      if (!canSelectPassiveSimulationModel(part, circuit) || current['Sim.Library']?.trim())
        throw new Error('Clear the built-in model on a supported symbol without a library file.');
      delete fields['OpenPE.PassiveModel'];
      delete fields['OpenPE.ModelSource'];
      return fields;
    }
    if (selection.passiveModel !== undefined) {
      if (
        !canSelectPassiveSimulationModel(part, circuit) ||
        !isPassiveSimulationModel(selection.passiveModel)
      )
        throw new Error('Choose R, C or L for a supported two-terminal passive symbol.');
      if (
        fields['OpenPE.PassiveModel'] !== undefined ||
        selection.passiveModel !== basicSimulationKind(part)
      )
        fields['OpenPE.PassiveModel'] = selection.passiveModel;
    }
    if (
      !basicSimulationAvailable(part) &&
      !(
        canSelectPassiveSimulationModel(part, circuit) &&
        isPassiveSimulationModel(fields['OpenPE.PassiveModel'])
      )
    )
      throw new Error('This component has no intrinsic model.');
    return fields;
  }
  const library = current['Sim.Library'];
  if (!library) throw new Error('Choose a model library first.');
  if (!selection.declarations && selection.name && selection.name === current['Sim.Name'])
    return { ...current, 'OpenPE.ModelSource': 'external' };
  if (!circuit) throw new Error('Component terminals are unavailable.');
  const declaration = simulationLibraryDeclaration(
    library,
    selection.name,
    selection.declarations ?? [],
  );
  if (!declaration) throw new Error('This model is not declared in the selected library.');
  const basis = { ...part, fields: { ...partFields(part), ...current } };
  const binding = externalModelBinding(circuit, basis, declaration);
  if (!binding.compatible)
    throw new Error(binding.reason || 'This model is incompatible with the component.');
  if (selection.name === current['Sim.Name'] && !selection.mapping)
    return { ...current, 'OpenPE.ModelSource': 'external' };
  const changes = externalModelBindingFields(circuit, basis, declaration, selection.mapping);
  const fields: Record<string, string> = { ...current, 'OpenPE.ModelSource': 'external' };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete fields[key];
    else fields[key] = value;
  }
  return fields;
}
