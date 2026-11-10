import { pinPositions, type Circuit, type Part, type Point, type Wire } from './circuit';
import {
  schematicRuleDefinitions,
  schematicRuleIds,
  type RuleCheckResult,
  type SchematicRuleId,
  type SchematicRuleSeverities,
} from './design-rule-checks';
import { unitGraphics } from './library';
import { documentPinKey, documentPhysicalPinKey, projectNetGroups } from './project-net-groups';
import { child, children, val } from './sexpr';

const pinTypes = new Set([
  'input',
  'output',
  'bidirectional',
  'tri_state',
  'passive',
  'free',
  'unspecified',
  'power_in',
  'power_out',
  'open_collector',
  'open_emitter',
  'no_connect',
]);
const optionalPins = new Set(['free', 'no_connect']);
const signalDrivers = new Set(['output', 'power_out', 'bidirectional', 'tri_state', 'passive']);
// Supported driver and power pin conflicts, in reporting priority order.
const driverConflicts = [
  ['output', 'output'],
  ['power_out', 'power_out'],
  ['output', 'power_out'],
  ['output', 'open_collector'],
  ['output', 'open_emitter'],
  ['power_out', 'tri_state'],
  ['power_out', 'open_collector'],
  ['power_out', 'open_emitter'],
  ['output', 'tri_state'],
  ['bidirectional', 'power_out'],
  ['bidirectional', 'open_emitter'],
  ['tri_state', 'power_in'],
  ['tri_state', 'open_collector'],
  ['tri_state', 'open_emitter'],
] as const;
const coordinate = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
const pointTolerance = 0.0001;
const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < pointTolerance;
const onSegment = (p: Point, w: Wire) => {
  const length = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  return (
    length > 0 &&
    Math.abs((p.x - w.a.x) * (w.b.y - w.a.y) - (p.y - w.a.y) * (w.b.x - w.a.x)) / length <
      0.00005 &&
    p.x >= Math.min(w.a.x, w.b.x) - 0.00005 &&
    p.x <= Math.max(w.a.x, w.b.x) + 0.00005 &&
    p.y >= Math.min(w.a.y, w.b.y) - 0.00005 &&
    p.y <= Math.max(w.a.y, w.b.y) + 0.00005
  );
};
type Pin = {
  part: Part;
  number: string;
  type: string;
  point: Point;
  physical: string;
  marker: boolean;
  name?: string;
};

/** Read-only ERC of one independent schematic. Connectivity is the same physical
 * topology used by native snapshots and PCB synchronization, not a SPICE netlist. */
export function runSchematicERC(
  circuit: Circuit,
  severities: SchematicRuleSeverities = {},
): RuleCheckResult {
  if (circuit.parts.length > 2000 || circuit.wires.length > 10000)
    throw new Error('ERC supports at most 2,000 components and 10,000 wires per schematic.');
  const checkedRules = schematicRuleIds.filter((id) => severities[id] !== 'ignore');
  const result: RuleCheckResult = {
    kind: 'erc',
    complete: checkedRules.length === schematicRuleIds.length,
    truncated: false,
    checkedRules,
    issues: [],
    notes: [
      'Checks one schematic only; separate schematic files have no electrical joins.',
      'Pin electrical types come from embedded libraries. Signal inputs accept passive pins; power inputs require a power output on the same net.',
      'Conditional tri-state and open-collector/open-emitter drive states are not simulated.',
      'Simulation exclusion and footprint assignment do not remove physical ERC connections.',
    ],
  };
  const report = (
    ruleId: SchematicRuleId,
    message: string,
    ids: string[],
    location?: Point,
    token = '',
  ) => {
    const override = severities[ruleId];
    if (override === 'ignore') return;
    if (result.issues.length >= 1000) {
      result.truncated = true;
      result.complete = false;
      return;
    }
    const objectIds = [...new Set(ids)].sort();
    if (objectIds.length > 64) {
      objectIds.length = 64;
      result.truncated = true;
      result.complete = false;
    }
    result.issues.push({
      id: `${ruleId}:${objectIds.join(',')}:${location ? coordinate(location) : ''}:${token}`,
      ruleId,
      severity: override ?? schematicRuleDefinitions[ruleId][1],
      message: message.slice(0, 2048),
      objectIds,
      ...(location ? { location: { x: location.x, y: location.y } } : {}),
    });
  };
  let work = 0;
  const spend = () => {
    if (++work > 2_000_000)
      throw new Error('ERC exceeds its geometry work limit. Reduce long or overlapping geometry.');
  };
  const assertPoint = (point: Point) => {
    if (![point.x, point.y].every((value) => Number.isFinite(value) && Math.abs(value) <= 100000))
      throw new Error('ERC requires finite schematic coordinates within ±100,000 mm.');
  };
  const references = new Map<string, Part[]>();
  for (const part of circuit.parts) {
    assertPoint(part);
    if (!Number.isFinite(part.rotation))
      throw new Error('ERC requires finite component rotations.');
    const units = references.get(part.ref) ?? [];
    units.push(part);
    references.set(part.ref, units);
  }
  const conflicting = new Set<string>();
  for (const [ref, parts] of references) {
    if (parts.length === 1) continue;
    if (
      new Set(parts.map((part) => part.libId)).size > 1 ||
      new Set(
        parts.map((part) =>
          JSON.stringify([
            part.value,
            Object.entries(part.fields ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ]),
        ),
      ).size > 1 ||
      new Set(parts.map((part) => part.unit || 1)).size !== parts.length
    ) {
      conflicting.add(ref);
      report(
        'erc.reference-conflict',
        `${ref} is assigned to unrelated symbols or repeated units. Assign unique component references.`,
        parts.map((part) => part.id),
        parts[0],
      );
    }
  }
  // A bad duplicate reference must not create fictitious physical pin joins.
  const topology = conflicting.size
    ? {
        ...circuit,
        parts: circuit.parts.map((part) =>
          conflicting.has(part.ref) ? { ...part, ref: JSON.stringify([part.ref, part.id]) } : part,
        ),
      }
    : circuit;
  const pins: Pin[] = [];
  const unknown = new Set<string>();
  for (let index = 0; index < circuit.parts.length; index++) {
    const part = circuit.parts[index],
      library = circuit.libraries[part.libId];
    if (!library) throw new Error(`ERC cannot find embedded symbol ${part.libId}.`);
    const definitions = unitGraphics(library, part.unit || 1).flatMap((unit) =>
      children(unit, 'pin'),
    );
    const positions = pinPositions(part, library);
    const marker = !!child(library, 'power');
    for (let pinIndex = 0; pinIndex < definitions.length; pinIndex++) {
      spend();
      const definition = definitions[pinIndex],
        point = positions[pinIndex];
      assertPoint(point);
      const type = val(definition),
        number = val(child(definition, 'number'));
      const hidden = definition.includes('hide') || val(child(definition, 'hide')) === 'yes';
      pins.push({
        part,
        number,
        type,
        point,
        marker,
        physical: documentPhysicalPinKey(topology.parts[index].ref, number),
        ...(type === 'power_in' && marker && definitions.length === 1
          ? { name: part.value }
          : type === 'power_in' && hidden
            ? { name: val(child(definition, 'name')) }
            : {}),
      });
      if (pins.length > 30000) throw new Error('ERC supports at most 30,000 physical anchors.');
      if (!pinTypes.has(type)) {
        unknown.add(type || '(missing)');
        result.complete = false;
        report(
          'erc.pin-type-unsupported',
          `${part.ref} pin ${number} has unsupported electrical type ${type || '(missing)'}. Driver and unconnected-pin checks cannot classify it.`,
          [part.id],
          point,
          number,
        );
      }
    }
  }
  const anchors =
    circuit.wires.length * 2 + pins.length + circuit.labels.length + circuit.junctions.length;
  if (anchors > 30000 || (circuit.noConnects?.length ?? 0) > 30000)
    throw new Error('ERC supports at most 30,000 physical anchors and 30,000 no-connect markers.');
  for (const point of [...circuit.labels, ...circuit.junctions, ...(circuit.noConnects ?? [])])
    assertPoint(point);
  if (unknown.size)
    result.notes.push(
      `Unchecked pin electrical types: ${[...unknown]
        .sort()
        .slice(0, 16)
        .map((type) => type.slice(0, 100))
        .join(', ')}${unknown.size > 16 ? ', …' : ''}.`,
    );

  const wireBuckets = new Map<string, number[]>(),
    longWires: number[] = [];
  circuit.wires.forEach((wire, index) => {
    assertPoint(wire.a);
    assertPoint(wire.b);
    const minX = Math.floor((Math.min(wire.a.x, wire.b.x) - 0.0001) / 10);
    const maxX = Math.floor((Math.max(wire.a.x, wire.b.x) + 0.0001) / 10);
    const minY = Math.floor((Math.min(wire.a.y, wire.b.y) - 0.0001) / 10);
    const maxY = Math.floor((Math.max(wire.a.y, wire.b.y) + 0.0001) / 10);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 256) {
      longWires.push(index);
      return;
    }
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++) {
        spend();
        const key = `${x},${y}`,
          entries = wireBuckets.get(key) ?? [];
        entries.push(index);
        wireBuckets.set(key, entries);
      }
  });
  const hasTouchingWire = (point: Point, except = -1) => {
    const local = wireBuckets.get(`${Math.floor(point.x / 10)},${Math.floor(point.y / 10)}`);
    for (const candidates of [local, longWires]) {
      if (!candidates) continue;
      for (const index of candidates) {
        spend();
        if (index !== except && onSegment(point, circuit.wires[index])) return true;
      }
    }
    return false;
  };
  const pointBuckets = new Map<string, { point: Point; pin?: Pin; labelId?: string }[]>();
  for (const entry of [
    ...pins.map((pin) => ({ point: pin.point, pin })),
    ...circuit.labels.map((label) => ({ point: label, labelId: label.id })),
  ]) {
    const key = `${Math.floor(entry.point.x)},${Math.floor(entry.point.y)}`;
    const entries = pointBuckets.get(key) ?? [];
    entries.push(entry);
    pointBuckets.set(key, entries);
  }
  const touchingPoints = (point: Point) => {
    const found: { point: Point; pin?: Pin; labelId?: string }[] = [];
    const minX = Math.floor(point.x - pointTolerance);
    const maxX = Math.floor(point.x + pointTolerance);
    const minY = Math.floor(point.y - pointTolerance);
    const maxY = Math.floor(point.y + pointTolerance);
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++)
        for (const entry of pointBuckets.get(`${x},${y}`) ?? []) {
          spend();
          if (same(entry.point, point)) found.push(entry);
        }
    return found;
  };
  const groups = projectNetGroups(topology);
  const groupByPin = new Map<string, number>();
  groups.forEach((group, index) => group.pins.forEach((pin) => groupByPin.set(pin, index)));
  const netPins = groups.map(() => [] as Pin[]);
  for (const pin of pins) {
    const index = groupByPin.get(documentPinKey(pin.part.id, pin.number));
    if (index === undefined) throw new Error('ERC could not resolve a component pin network.');
    netPins[index].push(pin);
  }
  const noConnectPins = new Set<string>();
  const connections = groups.map(
    (group, index) =>
      group.wires.length > 0 ||
      group.labels.length > 0 ||
      netPins[index].some((pin) => pin.physical !== netPins[index][0].physical),
  );
  const connected = (index: number) => connections[index];
  for (const marker of circuit.noConnects ?? []) {
    const nearby = touchingPoints(marker);
    const attached = nearby.flatMap((entry) => (entry.pin ? [entry.pin] : []));
    if (!nearby.length) {
      report(
        'erc.no-connect-misplaced',
        'No-connect marker is not on a component pin or label.',
        [marker.id],
        marker,
      );
      continue;
    }
    const linked = attached.some((pin) =>
      connected(groupByPin.get(documentPinKey(pin.part.id, pin.number))!),
    );
    if (linked)
      report(
        'erc.no-connect-connected',
        'No-connect marker is on an electrically connected pin.',
        [marker.id, ...attached.map((pin) => pin.part.id)],
        marker,
      );
    else attached.forEach((pin) => noConnectPins.add(pin.physical));
  }
  groups.forEach((group, index) => {
    const members = netPins[index];
    const physicalPins = new Map<string, Pin[]>();
    for (const pin of members) {
      const declarations = physicalPins.get(pin.physical) ?? [];
      declarations.push(pin);
      physicalPins.set(pin.physical, declarations);
    }
    const unique: Pin[] = [];
    let ambiguousTypes = false;
    for (const [, declarations] of [...physicalPins].sort(([a], [b]) => a.localeCompare(b))) {
      declarations.sort(
        (a, b) => a.part.id.localeCompare(b.part.id) || a.type.localeCompare(b.type),
      );
      const types = [...new Set(declarations.map((pin) => pin.type))].sort();
      if (types.length === 1) {
        unique.push(declarations[0]);
        continue;
      }
      ambiguousTypes = true;
      result.complete = false;
      const pin = declarations[0];
      report(
        'erc.pin-type-inconsistent',
        `${pin.part.ref} pin ${pin.number} has inconsistent electrical types across its symbol declarations: ${types.join(', ')}. Its driver and unconnected-pin checks are incomplete.`,
        declarations.map((item) => item.part.id),
        pin.point,
        pin.number,
      );
      // Preserve the shared physical network without choosing a declaration's
      // electrical type. A declared NC remains meaningful despite that ambiguity.
      const noConnect = declarations.find((item) => item.type === 'no_connect');
      if (noConnect) unique.push(noConnect);
    }
    if (
      ambiguousTypes &&
      !result.notes.includes(
        'Inconsistent physical pin electrical types prevent complete driver classification.',
      )
    )
      result.notes.push(
        'Inconsistent physical pin electrical types prevent complete driver classification.',
      );
    for (const pin of unique) {
      if (pin.type === 'no_connect' && connected(index))
        report(
          'erc.no-connect-connected',
          `${pin.part.ref} pin ${pin.number} is declared no-connect but is electrically connected.`,
          [pin.part.id],
          pin.point,
          pin.number,
        );
      else if (
        !connected(index) &&
        !pin.marker &&
        pinTypes.has(pin.type) &&
        !optionalPins.has(pin.type) &&
        !noConnectPins.has(pin.physical)
      )
        report(
          'erc.pin-unconnected',
          `${pin.part.ref} pin ${pin.number} (${pin.type}) is unconnected. Wire it or place a no-connect marker.`,
          [pin.part.id],
          pin.point,
          pin.number,
        );
    }
    const explicitNames = [
      ...group.labels.map((label) => ({
        name: circuit.labels[label].text,
        id: circuit.labels[label].id,
      })),
      ...members.flatMap((pin) =>
        pin.marker && pin.name !== undefined ? [{ name: pin.name, id: pin.part.id }] : [],
      ),
    ];
    // Hidden power pin names are defaults. The topology still joins their
    // physical aliases, but an explicit net label/power marker owns the name.
    const named = explicitNames.length
      ? explicitNames
      : members.flatMap((pin) =>
          pin.name === undefined ? [] : [{ name: pin.name, id: pin.part.id }],
        );
    const names = [...new Set(named.map((item) => item.name))];
    if (names.length > 1)
      report(
        'erc.net-name-conflict',
        `One connected network has conflicting names: ${names.slice(0, 8).join(', ')}.`,
        named.map((item) => item.id),
        members[0]?.point ?? circuit.labels[group.labels[0]],
      );
    const byType = new Map<string, Pin[]>();
    for (const pin of unique) {
      const typed = byType.get(pin.type) ?? [];
      if (typed.length < 2) typed.push(pin);
      byType.set(pin.type, typed);
    }
    for (const [first, second] of driverConflicts) {
      const a = byType.get(first)?.[0];
      const b = byType.get(second)?.[first === second ? 1 : 0];
      if (!a || !b) continue;
      report(
        'erc.output-conflict',
        `${a.part.ref} pin ${a.number} (${first}) and ${b.part.ref} pin ${b.number} (${second}) share this network.`,
        [a.part.id, b.part.id],
        a.point,
      );
      break;
    }
    const unspecified = byType.get('unspecified')?.[0];
    const other = unique.find(
      (pin) => pin !== unspecified && pinTypes.has(pin.type) && !optionalPins.has(pin.type),
    );
    if (unspecified && other)
      report(
        'erc.pin-conflict',
        `${unspecified.part.ref} pin ${unspecified.number} has unspecified electrical type and shares a network with ${other.part.ref} pin ${other.number}.`,
        [unspecified.part.id, other.part.id],
        unspecified.point,
      );
    if (ambiguousTypes || !connected(index)) return;
    const powerInput =
      unique.find((pin) => pin.type === 'power_in' && !pin.marker) ?? byType.get('power_in')?.[0];
    const input = byType.get('input')?.[0];
    if (powerInput && !byType.has('power_out')) {
      const name = names.length === 1 ? ` on ${names[0]}` : '';
      report(
        'erc.power-undriven',
        `${powerInput.part.ref} pin ${powerInput.number}${name} has no power output on its network.`,
        [powerInput.part.id],
        powerInput.point,
      );
    } else if (!powerInput && input && !unique.some((pin) => signalDrivers.has(pin.type))) {
      report(
        'erc.input-undriven',
        `${input.part.ref} pin ${input.number} has no signal driver on its network.`,
        [input.part.id],
        input.point,
      );
    }
  });
  circuit.wires.forEach((wire, index) => {
    if (same(wire.a, wire.b))
      report('erc.wire-zero-length', 'Wire has zero length.', [wire.id], wire.a);
    else
      for (const [end, point] of [wire.a, wire.b].entries())
        if (!hasTouchingWire(point, index) && !touchingPoints(point).length)
          report(
            'erc.wire-dangling',
            'Wire endpoint has no pin, label or continuing wire.',
            [wire.id],
            point,
            String(end),
          );
  });
  for (const label of circuit.labels)
    if (
      !hasTouchingWire(label) &&
      !touchingPoints(label).some((entry) => entry.pin || entry.labelId !== label.id)
    )
      report(
        'erc.label-dangling',
        `Net label ${label.text} is not attached to a wire, component pin or another label.`,
        [label.id],
        label,
      );
  if (result.truncated)
    result.notes.push(
      'The report is incomplete: at most 1,000 issues and 64 object links per issue are retained.',
    );
  return result;
}
