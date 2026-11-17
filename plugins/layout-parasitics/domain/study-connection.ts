import { pinPositions, type Circuit, type Part, type Point } from '../../../lib/circuit';
import { partFields, unitGraphics } from '../../../lib/library';
import type { PCB } from '../../../lib/pcb';
import { projectSchematics, type Project } from '../../../lib/project';
import { documentPinKey, projectNetGroups } from '../../../lib/project-net-groups';
import { saveLabel } from '../../../lib/schematic-edit';
import { child, children, val } from '../../../lib/sexpr';
import { onWire, samePoint } from '../../../lib/wiring';

type Terminal = { part: Part; number: string; point: Point; key: string };
const gap = 1.27;

function terminals(circuit: Circuit): Terminal[] {
  return circuit.parts.flatMap((part) => {
    const positions = pinPositions(part, circuit.libraries[part.libId]);
    return unitGraphics(circuit.libraries[part.libId], part.unit || 1)
      .flatMap((unit) => children(unit, 'pin'))
      .map((pin, index) => {
        const number = val(child(pin, 'number'));
        return { part, number, point: positions[index], key: documentPinKey(part.id, number) };
      });
  });
}

function exactTerminal(board: PCB, circuit: Circuit, pins: Terminal[], id: string): Terminal {
  const footprint = board.footprints.find((footprint) =>
    footprint.pads.some((pad) => pad.id === id),
  );
  const pad = footprint?.pads.find((pad) => pad.id === id);
  const owner = circuit.parts.find((part) => part.id === footprint?.symbolId);
  if (!pad || !owner || !pad.number.trim())
    throw new Error(
      'Series insertion requires two PCB pads linked to exact pins in the selected schematic. Vias and unmapped pads cannot be inserted.',
    );
  if (footprint!.pads.filter((candidate) => candidate.number === pad.number).length !== 1)
    throw new Error(
      'Series insertion cannot detach one of several PCB lands sharing the same pad number.',
    );
  const matches = pins.filter(
    ({ part, number }) =>
      part.ref === owner.ref && part.libId === owner.libId && number === pad.number,
  );
  if (matches.length !== 1)
    throw new Error(
      'Series insertion requires one unambiguous schematic pin for each selected PCB pad.',
    );
  return matches[0];
}

function partition(
  groups: ReturnType<typeof projectNetGroups>,
  keys: ReadonlySet<string>,
  omitted: string,
) {
  return groups
    .map((group) =>
      group.pins
        .filter((key) => keys.has(key) && key !== omitted)
        .sort()
        .join('|'),
    )
    .filter(Boolean)
    .sort();
}

/** Prepare a real native terminal-side split. Every other original pin and
 * branch keeps its electrical partition; only the chosen End leaf is detached. */
export function prepareStudyConnection(
  project: Project,
  circuit: Circuit,
  startId: string,
  endId: string,
  labels: { start: string; end: string },
): Circuit {
  const pins = terminals(circuit);
  const start = exactTerminal(project.pcb!, circuit, pins, startId);
  const end = exactTerminal(project.pcb!, circuit, pins, endId);
  if (start.key === end.key || samePoint(start.point, end.point))
    throw new Error('Series insertion requires two distinct, unambiguous schematic terminals.');
  for (const sheet of projectSchematics(project))
    for (const part of sheet.parts) {
      const fields = partFields(part);
      if (fields['OpenPE.Parasitics.BoardId'] !== project.pcb!.id) continue;
      const previousStart = fields['OpenPE.Parasitics.StartId'];
      const previousEnd = fields['OpenPE.Parasitics.EndId'];
      if (
        (previousStart === startId && previousEnd === endId) ||
        (previousStart === endId && previousEnd === startId)
      )
        throw new Error(
          'This terminal pair already has parasitic study components. Remove or undo that study before inserting it again.',
        );
      if (
        fields['OpenPE.Parasitics.Connection'] === 'series' &&
        (previousEnd === startId || previousEnd === endId)
      )
        throw new Error(
          'A selected terminal already has a series parasitic insertion. Choose an untouched terminal.',
        );
    }
  const beforeGroups = projectNetGroups(circuit);
  const before = beforeGroups.find((group) => group.pins.includes(start.key));
  if (!before?.pins.includes(end.key))
    throw new Error(
      'The selected PCB pads must share the same original schematic network before series insertion.',
    );
  const library = circuit.libraries[end.part.libId];
  const definition = unitGraphics(library, end.part.unit || 1)
    .flatMap((unit) => children(unit, 'pin'))
    .find((pin) => val(child(pin, 'number')) === end.number)!;
  if (
    child(library, 'power') ||
    end.part.libId.startsWith('power:') ||
    end.part.libId === 'Simulation_SPICE:0' ||
    (val(definition) === 'power_in' &&
      (definition.includes('hide') || val(child(definition, 'hide')) === 'yes'))
  )
    throw new Error(
      'A global power pin cannot be detached for series insertion. Choose an ordinary terminal.',
    );
  if (
    pins.some((pin) => pin.key !== end.key && samePoint(pin.point, end.point)) ||
    circuit.labels.some((label) => samePoint(label, end.point)) ||
    circuit.junctions.some((point) => samePoint(point, end.point)) ||
    circuit.noConnects?.some((point) => samePoint(point, end.point))
  )
    throw new Error(
      'The End pin must be an exclusive wire leaf without co-located pins, labels, junctions or no-connect markers.',
    );
  const incident = circuit.wires.filter((wire) => onWire(end.point, wire));
  const wire = incident[0];
  if (incident.length !== 1 || (!samePoint(wire.a, end.point) && !samePoint(wire.b, end.point)))
    throw new Error('The End pin needs exactly one unbranched wire lead for series insertion.');
  const atA = samePoint(wire.a, end.point);
  const other = atA ? wire.b : wire.a;
  const dx = other.x - end.point.x,
    dy = other.y - end.point.y;
  if ((Math.abs(dx) > 0.00001 && Math.abs(dy) > 0.00001) || Math.hypot(dx, dy) <= gap + 0.0001)
    throw new Error(
      'The End pin needs an orthogonal wire lead longer than 1.27 mm for series insertion.',
    );
  const cut = {
    x: end.point.x + (Math.abs(dx) > 0.00001 ? Math.sign(dx) * gap : 0),
    y: end.point.y + (Math.abs(dy) > 0.00001 ? Math.sign(dy) * gap : 0),
  };
  const removed = { ...wire, a: end.point, b: cut };
  if (
    pins.some((pin) => pin.key !== end.key && onWire(pin.point, removed)) ||
    [...circuit.labels, ...circuit.junctions, ...(circuit.noConnects ?? [])].some((point) =>
      onWire(point, removed),
    ) ||
    circuit.wires.some((item) => item.id !== wire.id && onWire(cut, item))
  )
    throw new Error(
      'The End lead has another electrical anchor inside the required 1.27 mm gap. Choose a clear terminal.',
    );
  let result: Circuit = {
    ...circuit,
    wires: circuit.wires.map((item) =>
      item.id === wire.id ? { ...item, ...(atA ? { a: cut } : { b: cut }) } : item,
    ),
  };
  const after = projectNetGroups(result);
  const endGroup = after.find((group) => group.pins.includes(end.key));
  const originalKeys = new Set(pins.map((pin) => pin.key));
  if (
    !endGroup ||
    endGroup.pins.some((key) => originalKeys.has(key) && key !== end.key) ||
    endGroup.labels.length ||
    endGroup.wires.length ||
    JSON.stringify(partition(beforeGroups, originalKeys, end.key)) !==
      JSON.stringify(partition(after, originalKeys, end.key))
  )
    throw new Error(
      'The End pin cannot be isolated without changing other schematic connections. No parasitic components were inserted.',
    );
  for (const [text, point, rotation] of [
    [labels.start, start.point, 0],
    [labels.start, cut, 180],
    [labels.end, end.point, 0],
  ] as const) {
    const added = saveLabel(result, { text, position: point });
    // Existing native pin anchors may be off-grid. Labels must retain the exact
    // electrical anchor rather than rounding it onto nearby unrelated geometry.
    result = {
      ...added.circuit,
      labels: added.circuit.labels.map((label) =>
        label.id === added.id ? { ...label, x: point.x, y: point.y, rotation } : label,
      ),
    };
  }
  return result;
}
