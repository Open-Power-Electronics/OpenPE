import { pinPositions, type Circuit, type Part, type Point, type Wire } from './circuit';
import type { RuleCheckIssue, RuleCheckResult } from './design-rule-checks';
import { unitGraphics } from './library';
import { documentPinKey, documentPhysicalPinKey, projectNetGroups } from './project-net-groups';
import { child, children, val } from './sexpr';

const rules = [
  'erc.reference-conflict',
  'erc.pin-type-unsupported',
  'erc.pin-type-inconsistent',
  'erc.pin-unconnected',
  'erc.input-undriven',
  'erc.power-undriven',
  'erc.output-conflict',
  'erc.net-name-conflict',
  'erc.wire-dangling',
  'erc.wire-zero-length',
  'erc.label-dangling',
  'erc.no-connect-misplaced',
  'erc.no-connect-connected',
];
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
const signalDrivers = new Set([
  'output',
  'power_out',
  'bidirectional',
  'tri_state',
  'open_collector',
  'open_emitter',
]);
const coordinate = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 0.0001;
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
export function runSchematicERC(circuit: Circuit): RuleCheckResult {
  if (circuit.parts.length > 2000 || circuit.wires.length > 10000)
    throw new Error('ERC supports at most 2,000 components and 10,000 wires per schematic.');
  const result: RuleCheckResult = {
    kind: 'erc',
    complete: true,
    truncated: false,
    checkedRules: [...rules],
    issues: [],
    notes: [
      'Checks one schematic only; separate schematic files have no electrical joins.',
      'Pin electrical types come from embedded libraries. Passive components and external interfaces do not establish a declared driver.',
      'Conditional tri-state and open-collector/open-emitter drive states are not simulated.',
      'Simulation exclusion and footprint assignment do not remove physical ERC connections.',
    ],
  };
  const report = (
    ruleId: string,
    severity: RuleCheckIssue['severity'],
    message: string,
    ids: string[],
    location?: Point,
    token = '',
  ) => {
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
      severity,
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
        'error',
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
    for (let pinIndex = 0; pinIndex < definitions.length; pinIndex++) {
      spend();
      const definition = definitions[pinIndex],
        point = positions[pinIndex];
      assertPoint(point);
      const type = val(definition),
        number = val(child(definition, 'number'));
      const marker = !!child(library, 'power');
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
          'warning',
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
  const touchingWires = (point: Point, except = -1) => {
    const found: number[] = [];
    const candidates = [
      ...(wireBuckets.get(`${Math.floor(point.x / 10)},${Math.floor(point.y / 10)}`) ?? []),
      ...longWires,
    ];
    for (const index of candidates) {
      spend();
      if (index !== except && onSegment(point, circuit.wires[index])) found.push(index);
    }
    return found;
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
    for (let x = Math.floor(point.x) - 1; x <= Math.floor(point.x) + 1; x++)
      for (let y = Math.floor(point.y) - 1; y <= Math.floor(point.y) + 1; y++)
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
      new Set(netPins[index].map((pin) => pin.physical)).size > 1,
  );
  const connected = (index: number) => connections[index];
  for (const marker of circuit.noConnects ?? []) {
    const attached = touchingPoints(marker).flatMap((entry) => (entry.pin ? [entry.pin] : []));
    if (!attached.length) {
      report(
        'erc.no-connect-misplaced',
        'error',
        'No-connect marker is not on a component pin.',
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
        'error',
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
        'warning',
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
          'error',
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
          'warning',
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
        'error',
        `One connected network has conflicting names: ${names.slice(0, 8).join(', ')}.`,
        named.map((item) => item.id),
        members[0]?.point ?? circuit.labels[group.labels[0]],
      );
    const strong = unique.filter((pin) => pin.type === 'output' || pin.type === 'power_out');
    const conditional = unique.filter((pin) =>
      ['tri_state', 'open_collector', 'open_emitter'].includes(pin.type),
    );
    const open = conditional.filter((pin) => pin.type !== 'tri_state');
    if (strong.length > 1 || (strong.length && open.length))
      report(
        'erc.output-conflict',
        'error',
        'Multiple incompatible output drivers share this network. Verify the output types and wiring.',
        [...strong, ...conditional].map((pin) => pin.part.id),
        strong[0].point,
      );
    else if (strong.length && conditional.length)
      report(
        'erc.output-conflict',
        'warning',
        'A driven output shares this network with a tri-state output. Verify that their active drive states cannot conflict.',
        [...strong, ...conditional].map((pin) => pin.part.id),
        strong[0].point,
      );
    else if (
      conditional.some((pin) => pin.type === 'open_collector') &&
      conditional.some((pin) => pin.type === 'open_emitter')
    )
      report(
        'erc.output-conflict',
        'warning',
        'Open-collector and open-emitter outputs share this network. Verify their allowed drive states.',
        conditional.map((pin) => pin.part.id),
        conditional[0].point,
      );
    const inputs = unique.filter((pin) => pin.type === 'input');
    if (
      !ambiguousTypes &&
      connected(index) &&
      inputs.length &&
      !unique.some((pin) => signalDrivers.has(pin.type))
    )
      report(
        'erc.input-undriven',
        'warning',
        'No declared signal driver. Check the input connection.',
        inputs.map((pin) => pin.part.id),
        inputs[0].point,
      );
    const powerInputs = unique.filter((pin) => pin.type === 'power_in' && !pin.marker);
    if (
      !ambiguousTypes &&
      connected(index) &&
      powerInputs.length &&
      !unique.some((pin) => pin.type === 'power_out')
    )
      report(
        'erc.power-undriven',
        'warning',
        'No declared power output. Check the supply and external power flag.',
        powerInputs.map((pin) => pin.part.id),
        powerInputs[0].point,
      );
  });
  circuit.wires.forEach((wire, index) => {
    if (same(wire.a, wire.b))
      report('erc.wire-zero-length', 'warning', 'Wire has zero length.', [wire.id], wire.a);
    else
      for (const [end, point] of [wire.a, wire.b].entries())
        if (!touchingWires(point, index).length && !touchingPoints(point).length)
          report(
            'erc.wire-dangling',
            'warning',
            'Wire endpoint has no pin, label or continuing wire.',
            [wire.id],
            point,
            String(end),
          );
  });
  for (const label of circuit.labels)
    if (!touchingWires(label).length && !touchingPoints(label).some((entry) => entry.pin))
      report(
        'erc.label-dangling',
        'warning',
        `Net label ${label.text} is not attached to a wire or component pin.`,
        [label.id],
        label,
      );
  if (result.truncated)
    result.notes.push(
      'The report is incomplete: at most 1,000 issues and 64 object links per issue are retained.',
    );
  return result;
}
