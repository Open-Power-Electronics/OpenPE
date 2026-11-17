import { readFileSync } from 'node:fs';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import type { BoardZone } from '../lib/pcb';
import { fillCopperZones } from '../lib/pcb-polygons';
import { createProject } from '../lib/project';
import { child, children, num, parseSExpr, val } from '../lib/sexpr';

const referencePath = process.argv[2];
if (!referencePath || process.argv.length !== 3)
  throw new Error('Pass the path to a KiCad reference copy of the LM25017 PCB.');

const sourcePath = 'examples/lm25017-wson8-flybuck/lm25017-wson8-flybuck.kicad_pcb';
const { board } = parseKiCadPCB(
  readFileSync(sourcePath, 'utf8'),
  createProject().schematic,
  'lm25017-fill-parity',
);
const reference = parseSExpr(readFileSync(referencePath, 'utf8'));
if (reference[0] !== 'kicad_pcb' || val(child(reference, 'version')) !== '20260206')
  throw new Error('Expected a KiCad 10 reference board.');

function contourKey({ points, island }: NonNullable<BoardZone['filledPolygons']>[number]) {
  const vertices = points.map(({ x, y }) => `${x},${y}`);
  const edges = vertices.flatMap((start, index) => {
    const end = vertices[(index + 1) % vertices.length];
    if (start === end) return [];
    return [start < end ? `${start}:${end}` : `${end}:${start}`];
  });
  return JSON.stringify([Boolean(island), edges.sort()]);
}

const nativeZones = children(reference, 'zone');
const refilled = fillCopperZones(board);
let different = 0;
for (const zone of refilled.zones) {
  if (zone.keepout || zone.fillEnabled === false) continue;
  const matches = nativeZones.filter((candidate) => val(child(candidate, 'uuid')) === zone.id);
  if (matches.length !== 1 || val(child(matches[0], 'layer')) !== zone.layer)
    throw new Error(`Expected exactly one KiCad reference zone for ${zone.id} on ${zone.layer}.`);

  const native = children(matches[0], 'filled_polygon').map((polygon) => {
    const points = child(polygon, 'pts');
    if (!points || val(child(polygon, 'layer')) !== zone.layer)
      throw new Error(`Invalid KiCad fill contour for ${zone.id} on ${zone.layer}.`);
    return {
      points: children(points, 'xy').map((point) => ({ x: num(point), y: num(point, 2) })),
      ...(child(polygon, 'island') ? { island: true as const } : {}),
    };
  });
  const openpe = zone.filledPolygons ?? [];
  const equal =
    JSON.stringify(native.map(contourKey).sort()) === JSON.stringify(openpe.map(contourKey).sort());
  if (!equal) different++;
  const net = board.nets.find(({ id }) => id === zone.netId)?.name;
  console.log(
    `${net} ${zone.layer} ${equal ? 'match' : 'different'} ` +
      `(KiCad reference/OpenPE contours ${native.length}/${openpe.length}, ` +
      `islands ${native.filter(({ island }) => island).length}/${openpe.filter(({ island }) => island).length})`,
  );
}
if (different) process.exitCode = 1;
