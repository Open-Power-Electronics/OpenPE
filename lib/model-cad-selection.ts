import { modelCadSelectableEdges, type ModelCadObject } from './model-cad';

export type ModelCadSelection =
  | { kind: 'body'; objectId: string }
  | { kind: 'face'; objectId: string; faceId: string }
  | { kind: 'edge' | 'line'; objectId: string; edgeId: string };
type ModelCadSelectionMode = ModelCadSelection['kind'];
export type ModelCadSelectionFilters = {
  bodies: boolean;
  faces: boolean;
  edges: boolean;
  lines: boolean;
};
export const DEFAULT_MODEL_CAD_SELECTION_FILTERS: Readonly<ModelCadSelectionFilters> =
  Object.freeze({
    bodies: true,
    faces: true,
    edges: true,
    lines: true,
  });
export const MODEL_CAD_SELECTION_LIMIT = 256;

/** Eligibility changes selection only; a subentity never becomes its owning body. */
export function modelCadSelectionEligible(
  item: ModelCadSelection,
  filters: Readonly<ModelCadSelectionFilters>,
): boolean {
  return modelCadSelectionModeAvailable(item.kind, filters);
}

export function modelCadSelectionModeAvailable(
  mode: ModelCadSelectionMode | 'auto',
  filters: Readonly<ModelCadSelectionFilters>,
): boolean {
  switch (mode) {
    case 'auto':
      return filters.bodies || filters.faces || filters.edges || filters.lines;
    case 'body':
      return filters.bodies;
    case 'face':
      return filters.faces;
    case 'edge':
      return filters.edges;
    case 'line':
      return filters.lines;
  }
}

export function filterModelCadSelection(
  selection: readonly ModelCadSelection[],
  filters: Readonly<ModelCadSelectionFilters>,
): ModelCadSelection[] {
  return selection
    .filter((item) => modelCadSelectionEligible(item, filters))
    .map((item) => ({ ...item }));
}

/** These identities describe untreated analytic topology, never tessellation triangles. */
export function modelCadSelectableFaceIds(object: ModelCadObject): string[] {
  if (object.kind === 'boolean' || object.edgeTreatment) return [];
  const profile = object.kind === 'extrusion' ? object.profile : undefined;
  const circular = object.kind === 'cylinder' || profile?.kind === 'circle';
  const sides = profile?.kind === 'polygon' ? profile.points.length : 4;
  return [
    'profile:top',
    'profile:bottom',
    ...(circular ? ['profile:wall'] : Array.from({ length: sides }, (_, i) => `side:${i}`)),
  ];
}

export function modelCadSelectionKey(selection: ModelCadSelection): string {
  return JSON.stringify([
    selection.kind,
    selection.objectId,
    selection.kind === 'body'
      ? null
      : selection.kind === 'face'
        ? selection.faceId
        : selection.edgeId,
  ]);
}

function independentUnique(selection: readonly ModelCadSelection[]): ModelCadSelection[] {
  const seen = new Set<string>();
  return selection
    .filter((item) => {
      const key = modelCadSelectionKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({ ...item }));
}

/** Local presentation selection: replacement, additive selection and modifier toggling. */
export function updateModelCadSelection(
  previous: readonly ModelCadSelection[],
  next: ModelCadSelection | null,
  { additive = false, toggle = true }: { additive?: boolean; toggle?: boolean } = {},
): ModelCadSelection[] {
  if (!additive) return next ? [{ ...next }] : [];
  const result = independentUnique(previous);
  if (!next) return result;
  const key = modelCadSelectionKey(next);
  const index = result.findIndex((item) => modelCadSelectionKey(item) === key);
  if (index >= 0) {
    if (toggle) result.splice(index, 1);
    return result;
  }
  if (result.length >= MODEL_CAD_SELECTION_LIMIT)
    throw new Error(`Model selection supports at most ${MODEL_CAD_SELECTION_LIMIT} entities.`);
  result.push({ ...next });
  return result;
}

/** Reject stale subentities after geometry changes without promoting them to whole bodies. */
export function pruneModelCadSelection(
  selection: readonly ModelCadSelection[],
  objects: readonly ModelCadObject[],
): ModelCadSelection[] {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const faceIds = new Map<string, Set<string>>();
  const edgeIds = new Map<string, Map<string, 'line' | 'circle'>>();
  return independentUnique(selection).filter((item) => {
    const object = byId.get(item.objectId);
    if (!object) return false;
    if (item.kind === 'body') return true;
    if (item.kind === 'face') {
      let faces = faceIds.get(item.objectId);
      if (!faces) {
        faces = new Set(modelCadSelectableFaceIds(object));
        faceIds.set(item.objectId, faces);
      }
      return faces.has(item.faceId);
    }
    let edges = edgeIds.get(item.objectId);
    if (!edges) {
      edges = new Map(modelCadSelectableEdges(object).map((edge) => [edge.id, edge.kind]));
      edgeIds.set(item.objectId, edges);
    }
    const kind = edges.get(item.edgeId);
    return kind !== undefined && (item.kind === 'edge' || kind === 'line');
  });
}

/** A face/edge/line is never an implicit solid operand. Bodies mode must select it explicitly. */
export function modelCadSelectedBodyIds(selection: readonly ModelCadSelection[]): string[] {
  return [
    ...new Set(selection.filter((item) => item.kind === 'body').map((item) => item.objectId)),
  ];
}
