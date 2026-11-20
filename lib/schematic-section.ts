import { materializedCircuitTree, pinPositions, type Circuit, type Part } from './circuit';
import { isOwnedCircuit } from './immutable-project';
import { partFootprint } from './library';
import { projectPhysicalNetGroups } from './project-net-groups';
import { fieldId, selectedField } from './schematic-edit';
import { schematicPolylines, schematicTexts } from './schematic-text';
import { child, children, val } from './sexpr';

export type SchematicSection = 'hardware' | 'simulation';
export type SchematicSectionView = SchematicSection | 'all';

/** Hardware requires an assigned package and native board inclusion. SPICE
 * participation and model binding remain independent of section visibility. */
export function partSchematicSection(part: Pick<Part, 'raw' | 'fields'>): SchematicSection {
  return !partFootprint(part) || val(child(part.raw ?? [], 'on_board')) === 'no'
    ? 'simulation'
    : 'hardware';
}

/** One pure candidate for GUI placements, Properties and the shared Core command.
 * Multi-unit symbols always change together, retaining all other native fields. */
export function prepareSchematicSection(
  circuit: Circuit,
  ids: readonly string[],
  section: SchematicSection,
): Circuit {
  if (section !== 'hardware' && section !== 'simulation')
    throw new Error('Choose Real or Virtual for the component section.');
  const references = new Set<string>();
  for (const id of ids) {
    const ownerId = selectedField(id)?.id ?? id;
    const part = circuit.parts.find((part) => part.id === ownerId);
    if (!part) throw new Error('Choose a component in the current schematic.');
    references.add(part.ref);
  }
  const changed = circuit.parts.filter(
    (part) =>
      references.has(part.ref) &&
      (val(child(part.raw ?? [], 'on_board')) === 'no' ? 'simulation' : 'hardware') !== section,
  );
  if (!changed.length) return circuit;
  // New placements have no raw instance yet. Materialize the canonical writer's
  // exact native instance instead of manufacturing an incomplete raw symbol.
  const instances = changed.some((part) => !part.raw)
    ? new Map(
        children(materializedCircuitTree(circuit), 'symbol').map((node) => [
          val(child(node, 'uuid')),
          node,
        ]),
      )
    : null;
  const targets = new Set(changed.map((part) => part.id));
  return {
    ...circuit,
    parts: circuit.parts.map((part) => {
      if (!targets.has(part.id)) return part;
      const instance = part.raw ?? instances?.get(part.id);
      if (!instance) throw new Error('The selected component has no native instance.');
      const raw = structuredClone(instance);
      const flag = child(raw, 'on_board');
      if (flag) flag[1] = section === 'hardware' ? 'yes' : 'no';
      else raw.push(['on_board', section === 'hardware' ? 'yes' : 'no']);
      return { ...part, raw };
    }),
  };
}

type SectionVisibility = Record<SchematicSectionView, Set<string>>;
type SectionProjection = { eligibility: SectionVisibility; emphasis: SectionVisibility };
const ownedVisibility = new WeakMap<Circuit, SectionProjection>();
const pointKey = ({ x, y }: { x: number; y: number }) => `${x.toFixed(4)},${y.toFixed(4)}`;
function addPart(target: Set<string>, part: Part) {
  target.add(part.id);
  for (const name of ['Reference', 'Value', 'Sim.Params'] as const)
    target.add(fieldId(part.id, name));
}

function computeVisibility(circuit: Circuit): SectionProjection {
  const result: SectionVisibility = {
    all: new Set(),
    hardware: new Set(),
    simulation: new Set(),
  };
  const sharedConductors = new Set<string>();
  const parts = new Map(circuit.parts.map((part) => [part.id, part]));
  const pins = new Map<string, string[]>();
  for (const part of circuit.parts) {
    addPart(result.all, part);
    addPart(result[partSchematicSection(part)], part);
    for (const point of pinPositions(part, circuit.libraries[part.libId])) {
      const key = pointKey(point);
      const existing = pins.get(key) ?? [];
      existing.push(part.id);
      pins.set(key, existing);
    }
  }
  // Follow physical drawing islands, not remote equal-name labels or global
  // power rails. Shared islands can appear in both views without being rewired.
  for (const group of projectPhysicalNetGroups(circuit)) {
    const members = new Set<string>();
    for (const key of group.pins) {
      if (key.startsWith('physical:')) continue;
      members.add((JSON.parse(key) as [string, string])[0]);
    }
    const sections = new Set<SchematicSection>();
    for (const id of members) {
      const part = parts.get(id);
      if (part) sections.add(partSchematicSection(part));
    }
    if (sections.size > 1) {
      for (const index of group.wires) sharedConductors.add(circuit.wires[index].id);
      for (const index of group.junctions) sharedConductors.add(circuit.junctions[index].id);
    }
    if (!sections.size) {
      sections.add('hardware');
      sections.add('simulation');
    }
    const drawings = [
      ...group.wires.map((index) => circuit.wires[index]),
      ...group.junctions.map((index) => circuit.junctions[index]),
      ...group.labels.map((index) => circuit.labels[index]),
    ];
    for (const drawing of drawings) {
      result.all.add(drawing.id);
      for (const section of sections) result[section].add(drawing.id);
    }
  }
  for (const marker of circuit.noConnects ?? []) {
    const attached = pins.get(pointKey(marker)) ?? [];
    const sections = (['hardware', 'simulation'] as const).filter(
      (section) => !attached.length || attached.some((id) => result[section].has(id)),
    );
    result.all.add(marker.id);
    for (const section of sections) result[section].add(marker.id);
  }
  for (const drawing of [
    ...schematicTexts(circuit.original),
    ...schematicPolylines(circuit.original),
  ])
    for (const section of ['all', 'hardware', 'simulation'] as const)
      result[section].add(drawing.id);
  const emphasis: SectionVisibility = {
    all: new Set(result.all),
    hardware: new Set([...result.hardware].filter((id) => !sharedConductors.has(id))),
    simulation: new Set([...result.simulation].filter((id) => !sharedConductors.has(id))),
  };
  return { eligibility: result, emphasis };
}

function sectionProjection(circuit: Circuit, view: SchematicSectionView): SectionProjection {
  if (!['all', 'hardware', 'simulation'].includes(view))
    throw new Error('Choose All, Real or Virtual for the schematic view.');
  const owned = isOwnedCircuit(circuit);
  let cached = owned ? ownedVisibility.get(circuit) : undefined;
  if (!cached) {
    cached = computeVisibility(circuit);
    if (owned) ownedVisibility.set(circuit, cached);
  }
  return cached;
}

/** View-only eligibility. The complete Circuit remains the edit/export authority. */
export function schematicSectionIds(circuit: Circuit, view: SchematicSectionView): Set<string> {
  return new Set(sectionProjection(circuit, view).eligibility[view]);
}

/** Full-opacity presentation only. Shared Real/Virtual conductor islands stay
 * eligible in both modes while dimmed in each; All retains ordinary rendering. */
export function schematicSectionEmphasisIds(
  circuit: Circuit,
  view: SchematicSectionView,
): Set<string> {
  return new Set(sectionProjection(circuit, view).emphasis[view]);
}
