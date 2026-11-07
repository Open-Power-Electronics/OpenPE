import { pinPositions, type Circuit, type Part, type Point } from './circuit';
import { symbolAnnotation, unitGraphics } from './library';
import { documentPinKey, projectPhysicalNetGroups } from './project-net-groups';
import { fieldId } from './schematic-edit';
import { child, children, val } from './sexpr';
import { symbolBodyBounds } from './symbol-bounds';
import { symbolRole } from './symbol-role';

type Bounded<T> = { total: number; items: T[]; truncated: boolean };
const limits = {
  components: 256,
  pinsPerComponent: 256,
  pins: 4096,
  wires: 2048,
  labels: 2048,
  junctions: 2048,
  labelLinks: 256,
  islandsPerLink: 64,
  islandObjects: 64,
  linkObjects: 4096,
} as const;
const bounded = <T>(items: readonly T[], limit: number): Bounded<T> => ({
  total: items.length,
  items: items.slice(0, limit),
  truncated: items.length > limit,
});
const position = ({ x, y }: Point): Point => ({ x, y });
const rounded = (value: number) => Number(value.toFixed(4));

/** Read-only world bounds of the same local body geometry used by selection.
 * The matrix follows pinPositions and partTransform: mirror after rotation. */
function bodyBounds(part: Part, circuit: Circuit) {
  const local = symbolBodyBounds(circuit.libraries[part.libId], part.unit || 1);
  if (!local) return null;
  const angle = (-part.rotation * Math.PI) / 180;
  const cosine = Math.cos(angle),
    sine = Math.sin(angle);
  const corners = [
    { x: local.x, y: local.y },
    { x: local.x + local.width, y: local.y },
    { x: local.x, y: local.y + local.height },
    { x: local.x + local.width, y: local.y + local.height },
  ].map((point) => ({
    x: part.x + (part.mirror === 'y' ? -1 : 1) * (point.x * cosine - point.y * sine),
    y: part.y + (part.mirror === 'x' ? -1 : 1) * (point.x * sine + point.y * cosine),
  }));
  const minX = Math.min(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  return {
    x: rounded(minX),
    y: rounded(minY),
    width: rounded(Math.max(...corners.map((point) => point.x)) - minX),
    height: rounded(Math.max(...corners.map((point) => point.y)) - minY),
  };
}

type PinReference = { partId: string; reference: string; number: string };
type PinMetadata = PinReference & { marker: boolean; power: boolean };

/** Bounded drafting evidence. This never routes, edits or judges electrical
 * correctness. Name-linked islands remain legal native schematic connections. */
export function schematicDrafting(circuit: Circuit) {
  for (const part of circuit.parts) {
    if (!circuit.libraries[part.libId])
      throw new Error(`Cannot inspect drafting geometry: ${part.ref} has no embedded symbol.`);
  }
  const pinsByKey = new Map<string, PinMetadata>();
  const powerNames = new Set<string>();
  let pinCount = 0,
    emittedPins = 0;
  const componentItems = circuit.parts.slice(0, limits.components).map((part) => {
    const library = circuit.libraries[part.libId];
    const definitions = unitGraphics(library, part.unit || 1).flatMap((group) =>
      children(group, 'pin'),
    );
    const locations = pinPositions(part, library);
    const available = Math.min(limits.pinsPerComponent, limits.pins - emittedPins);
    const pins = definitions.map((pin, index) => ({
      number: val(child(pin, 'number')),
      name: val(child(pin, 'name')),
      type: val(pin),
      position: position(locations[index]),
      hidden: pin.includes('hide') || val(child(pin, 'hide')) === 'yes',
    }));
    const observedPins = bounded(pins, available);
    emittedPins += observedPins.items.length;
    const omittedBodyGraphicTypes = [
      ...new Set(
        unitGraphics(library, part.unit || 1)
          .flatMap((group) => group.filter(Array.isArray).map((graphic) => graphic[0]))
          .filter(
            (kind) => !['pin', 'rectangle', 'polyline', 'circle', 'arc'].includes(String(kind)),
          ),
      ),
    ].map(String);
    const annotations = (['Reference', 'Value'] as const).flatMap((field) => {
      const point = symbolAnnotation(part, library, field);
      return point ? [{ id: fieldId(part.id, field), field, position: position(point) }] : [];
    });
    return {
      partId: part.id,
      reference: part.ref,
      value: part.value,
      libraryId: part.libId,
      role: symbolRole(library, part),
      position: position(part),
      rotation: part.rotation,
      ...(part.mirror ? { mirror: part.mirror } : {}),
      unit: part.unit || 1,
      bodyBounds: bodyBounds(part, circuit),
      omittedBodyGraphicTypes,
      annotations,
      pins: observedPins,
    };
  });
  // All physical pins participate in the authoritative grouping, including
  // hidden pins, excluded simulation parts and parts omitted from the packet.
  for (const part of circuit.parts) {
    const library = circuit.libraries[part.libId];
    const marker = symbolRole(library, part) === 'marker';
    const definitions = unitGraphics(library, part.unit || 1).flatMap((group) =>
      children(group, 'pin'),
    );
    pinCount += definitions.length;
    if (marker) powerNames.add(part.value);
    for (const pin of definitions) {
      const type = val(pin);
      const hidden = pin.includes('hide') || val(child(pin, 'hide')) === 'yes';
      if (type === 'power_in' && hidden) powerNames.add(val(child(pin, 'name')));
      pinsByKey.set(documentPinKey(part.id, val(child(pin, 'number'))), {
        partId: part.id,
        reference: part.ref,
        number: val(child(pin, 'number')),
        marker,
        power: type === 'power_in' || type === 'power_out',
      });
    }
  }
  const physicalGroups = projectPhysicalNetGroups(circuit);
  const physical = physicalGroups.map((group, index) => {
    const allPins = group.pins
      .filter((key) => !key.startsWith('physical:'))
      .map((key) => pinsByKey.get(key)!);
    const pins = allPins.filter((pin) => !pin.marker);
    // Multiple symbol units of the same physical terminal are one pin.
    const unique = new Map(pins.map((pin) => [JSON.stringify([pin.reference, pin.number]), pin]));
    const realPins = [...unique.values()];
    const wireLength = group.wires.reduce((length, index) => {
      const wire = circuit.wires[index];
      return length + Math.hypot(wire.b.x - wire.a.x, wire.b.y - wire.a.y);
    }, 0);
    return {
      index,
      group,
      pins: realPins,
      power: allPins.some((pin) => pin.marker || pin.power),
      wireLength,
      singlePinStub: realPins.length === 1 && wireLength <= 1.27 * 4 + 0.0001,
    };
  });
  const byName = new Map<string, Set<number>>();
  for (let index = 0; index < physical.length; index++) {
    for (const label of physical[index].group.labels) {
      const name = circuit.labels[label].text;
      const islands = byName.get(name) ?? new Set();
      islands.add(index);
      byName.set(name, islands);
    }
  }
  let excludedPowerLabelLinks = 0;
  const stubIslands = new Set<number>();
  let remainingLinkObjects: number = limits.linkObjects;
  let candidateCount = 0;
  const linkObjects = <T, R>(items: readonly T[], map: (item: T) => R): Bounded<R> => {
    const count = Math.min(items.length, limits.islandObjects, remainingLinkObjects);
    remainingLinkObjects -= count;
    return {
      total: items.length,
      items: items.slice(0, count).map(map),
      truncated: items.length > count,
    };
  };
  const labelLinks = [...byName].flatMap(([name, indexes]) => {
    const namedIslands = [...indexes].map((index) => physical[index]);
    const islands = namedIslands.filter((island) => island.pins.length);
    const realPinCount = islands.reduce((count, island) => count + island.pins.length, 0);
    if (islands.length < 2 || realPinCount < 2) return [];
    if (powerNames.has(name)) {
      excludedPowerLabelLinks++;
      return [];
    }
    for (const island of islands) if (island.singlePinStub) stubIslands.add(island.index);
    const observed = candidateCount++ < limits.labelLinks;
    const islandItems = (observed ? islands.slice(0, limits.islandsPerLink) : []).map((island) => ({
      pins: linkObjects(island.pins, ({ partId, reference, number }) => ({
        partId,
        reference,
        number,
      })),
      wireIds: linkObjects(island.group.wires, (index) => circuit.wires[index].id),
      labelIds: linkObjects(
        island.group.labels.filter((index) => circuit.labels[index].text === name),
        (index) => circuit.labels[index].id,
      ),
      wireLength: rounded(island.wireLength),
      singlePinStub: island.singlePinStub,
    }));
    return [
      {
        name,
        containsPowerPins: namedIslands.some((island) => island.power),
        physicalIslandCount: islands.length,
        componentPinCount: realPinCount,
        singlePinStubIslandCount: islands.filter((island) => island.singlePinStub).length,
        islands: {
          total: islands.length,
          items: islandItems,
          truncated: !observed || islands.length > limits.islandsPerLink,
        },
      },
    ];
  });
  const components = {
    total: circuit.parts.length,
    items: componentItems,
    truncated: circuit.parts.length > limits.components,
  };
  const wires = bounded(
    circuit.wires.map((wire) => ({ id: wire.id, a: position(wire.a), b: position(wire.b) })),
    limits.wires,
  );
  const labels = bounded(
    circuit.labels.map((label) => ({
      id: label.id,
      text: label.text,
      position: position(label),
      rotation: label.rotation || 0,
      ...(label.scope ? { scope: label.scope } : {}),
    })),
    limits.labels,
  );
  const junctions = bounded(
    circuit.junctions.map((junction) => ({ id: junction.id, position: position(junction) })),
    limits.junctions,
  );
  const observedLinks = bounded(labelLinks, limits.labelLinks);
  const truncated =
    components.truncated ||
    wires.truncated ||
    labels.truncated ||
    junctions.truncated ||
    observedLinks.truncated ||
    componentItems.some((part) => part.pins.truncated) ||
    observedLinks.items.some(
      (link) =>
        link.islands.truncated ||
        link.islands.items.some(
          (island) =>
            island.pins.truncated || island.wireIds.truncated || island.labelIds.truncated,
        ),
    );
  return {
    schematicId: circuit.id,
    units: 'mm' as const,
    grid: 1.27,
    advisory: true as const,
    counts: {
      components: circuit.parts.length,
      pins: pinCount,
      wires: circuit.wires.length,
      labels: circuit.labels.length,
      junctions: circuit.junctions.length,
      physicalIslands: physical.length,
      labelLinkedNets: labelLinks.length,
      singlePinStubIslands: stubIslands.size,
      excludedPowerLabelLinks,
      diagonalWires: circuit.wires.filter(
        (wire) => Math.abs(wire.a.x - wire.b.x) > 0.0001 && Math.abs(wire.a.y - wire.b.y) > 0.0001,
      ).length,
    },
    limits: { ...limits },
    truncated,
    components,
    wires,
    labels,
    junctions,
    labelLinks: observedLinks,
    notes: [
      'Drafting observations are advisory. Label-linked networks remain valid; these findings are not ERC, solver or manufacturing approval.',
      'Pin positions include transforms and hidden pins. Imported off-grid anchors remain exact; the grid is for new placement.',
      'Body bounds exclude pins, text and annotations; omitted body graphic types are listed per component. No text-overlap certification is made.',
      'Label links identify ordinary-label networks split across physical drawing islands. Remote block connections may be intentional.',
      'Power-symbol names and implicit hidden-power names are excluded from label-link candidates. Ordinary rail labels remain observable when they connect power pins; remote supply connections may be intentional.',
      'A single-pin stub is an island with one physical component pin and at most 5.08 mm of total wire; it is evidence, not an electrical error.',
      ...(truncated
        ? [
            'Geometry or label-link details were truncated at the declared collection limits. Counts still describe the validated schematic.',
          ]
        : []),
    ],
  };
}

export type SchematicDraftingReport = ReturnType<typeof schematicDrafting>;
