import { pinPositions, type Circuit, type Point, type Label } from './circuit';
import { onWire, samePoint } from './wiring';
import { fieldId, objectPosition, selectedField } from './schematic-edit';
import { schematicTexts } from './schematic-text';
import { extraSymbolAnnotations } from './library';
import type { SchematicLayers } from './schematic-layers';
import { isOwnedCircuit } from './immutable-project';
import { schematicSectionIds, type SchematicSectionView } from './schematic-section';

export const schematicWireWidth = 0.28;
export const schematicJunctionRadius = 0.6;

export function globalLabelPath(label: Label) {
  const end = Math.max(9, label.text.length * 1.4 + 5),
    shape = label.shape || 'input';
  const left = ['input', 'bidirectional'].includes(shape),
    right = ['output', 'bidirectional', 'tri_state'].includes(shape);
  return `M 0 0 L ${left ? 2 : 0} -2.3 H ${end - (right ? 2 : 0)} ${right ? `L ${end} 0 L ${end - 2} 2.3` : `V 2.3`} H ${left ? 2 : 0} Z`;
}

const ownedVisibleJunctions = new WeakMap<Circuit, Circuit['junctions']>();
export function visibleJunctions(doc: Circuit) {
  const owned = isOwnedCircuit(doc);
  const cached = owned ? ownedVisibleJunctions.get(doc) : undefined;
  if (cached) return cached.map((junction) => ({ ...junction }));
  const pins = doc.parts.flatMap((part) => pinPositions(part, doc.libraries[part.libId]));
  const visible = doc.junctions.filter((junction) => {
    const branches = doc.wires.reduce((count, wire) => {
      if (!onWire(junction, wire)) return count;
      return count + (samePoint(junction, wire.a) || samePoint(junction, wire.b) ? 1 : 2);
    }, 0);
    // Suppress only redundant two-way dots. Keep isolated markers and real branches.
    return branches !== 2 || pins.some((pin) => samePoint(pin, junction));
  });
  if (owned) {
    ownedVisibleJunctions.set(doc, visible);
    return visible.map((junction) => ({ ...junction }));
  }
  return visible;
}

const visibilityLayerKeys = [
  'symbols',
  'references',
  'values',
  'wires',
  'labels',
  'notes',
  'noConnects',
] as const;

/** Electrical targets use active section membership independently of emphasis,
 * retaining the same junction filtering as selection and drawing. */
export function visibleSchematicWireTargetIds(
  doc: Circuit,
  layers: Pick<SchematicLayers, 'symbols' | 'wires' | 'labels'>,
  sectionView: SchematicSectionView = 'all',
): Set<string> {
  const ids = new Set([
    ...(layers.symbols ? doc.parts.map((part) => part.id) : []),
    ...(layers.wires ? [...doc.wires, ...visibleJunctions(doc)].map((item) => item.id) : []),
    ...(layers.labels ? doc.labels.map((label) => label.id) : []),
  ]);
  if (sectionView !== 'all') {
    const section = schematicSectionIds(doc, sectionView);
    for (const id of ids) if (!section.has(id)) ids.delete(id);
  }
  return ids;
}

const ownedVisibleIds = new WeakMap<Circuit, Map<number, Set<string>>>();
/** Layer-visible interaction IDs. A section limits eligible targets; geometry in
 * other sections remains displayed dimmed by the renderer. Omit it for display bounds. */
export function visibleSchematicIds(
  doc: Circuit,
  layers: SchematicLayers,
  sectionView: SchematicSectionView = 'all',
): Set<string> {
  const owned = isOwnedCircuit(doc);
  const layerKey = visibilityLayerKeys.reduce(
    (value, name, index) => value | (layers[name] ? 1 << index : 0),
    0,
  );
  const key =
    layerKey |
    ((sectionView === 'hardware' ? 1 : sectionView === 'simulation' ? 2 : 0) <<
      visibilityLayerKeys.length);
  const variants = owned ? ownedVisibleIds.get(doc) : undefined;
  const cached = variants?.get(key);
  if (cached) return new Set(cached);
  const ids = new Set<string>();
  for (const part of doc.parts) {
    if (layers.symbols) ids.add(part.id);
    if (layers.references && !part.ref.startsWith('#')) ids.add(fieldId(part.id, 'Reference'));
    if (layers.values) ids.add(fieldId(part.id, 'Value'));
    if (layers.values && extraSymbolAnnotations(part).some((field) => field.name === 'Sim.Params'))
      ids.add(fieldId(part.id, 'Sim.Params'));
  }
  for (const item of [
    ...(layers.wires ? [...doc.wires, ...visibleJunctions(doc)] : []),
    ...(layers.labels ? doc.labels : []),
    ...(layers.notes ? schematicTexts(doc.original) : []),
    ...(layers.noConnects ? doc.noConnects || [] : []),
  ])
    ids.add(item.id);
  if (sectionView !== 'all') {
    const section = schematicSectionIds(doc, sectionView);
    for (const id of ids) if (!section.has(id)) ids.delete(id);
  }
  if (owned) {
    const next = variants ?? new Map<number, Set<string>>();
    next.set(key, ids);
    while (next.size > 3) next.delete(next.keys().next().value!);
    ownedVisibleIds.set(doc, next);
    return new Set(ids);
  }
  return ids;
}

// View-only guides: the renderer supplies the same preview offsets as the glyphs.
export function fieldDragLinks(doc: Circuit, ids: string[], offset: (id: string) => Point) {
  return ids.flatMap((id) => {
    const field = selectedField(id);
    if (!field) return [];
    const owner = doc.parts.find((part) => part.id === field.id);
    const at = objectPosition(doc, id);
    if (!owner || !at) return [];
    const ownerOffset = offset(owner.id),
      textOffset = offset(id);
    return [
      {
        id,
        from: { x: owner.x + ownerOffset.x, y: owner.y + ownerOffset.y },
        to: { x: at.x + ownerOffset.x + textOffset.x, y: at.y + ownerOffset.y + textOffset.y },
      },
    ];
  });
}
