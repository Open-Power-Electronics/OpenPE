import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCircuit } from '../lib/circuit';
import { parseSExpr, child, children, val } from '../lib/sexpr';
import { convertExamplePCB } from '../scripts/example-pcb';
import { serializePCB, resolvePCBGraphic } from '../lib/pcb';
import { flipPCBFootprint, movePCBSelection, rotatePCBSelection } from '../lib/pcb-layout';
import { pcbGraphicPath, pcbPadPath } from '../lib/pcb-geometry';

const index = JSON.parse(readFileSync('tests/fixtures/pebench/upstream-index.json', 'utf8')) as {
  id: string;
}[];
const load = (id: string) => {
  const circuit = parseCircuit(
    readFileSync(`tests/fixtures/pebench/converted/${id}.kicad_sch`, 'utf8'),
  );
  const source = readFileSync(`tests/fixtures/pebench/upstream/${id}/board.kicad_pcb`, 'utf8');
  const audit = JSON.parse(
    readFileSync(`tests/fixtures/pebench/upstream/${id}/eagle_source_audit.json`, 'utf8'),
  );
  return { circuit, source, ...convertExamplePCB(source, circuit, id, audit.reference_mapping) };
};

test('all ten curated boards preserve physical pads, copper segments, vias and polygons through native export', () => {
  assert.equal(index.length, 10);
  for (const entry of index) {
    const { board, circuit, source } = load(entry.id),
      before = parseSExpr(source),
      after = parseSExpr(serializePCB(board, circuit));
    assert.equal(board.footprints.length, children(before, 'footprint').length);
    for (const kind of ['segment', 'via', 'zone'])
      assert.equal(
        children(after, kind).length,
        children(before, kind).length,
        `${entry.id}: ${kind}`,
      );
    const pads = (root: ReturnType<typeof parseSExpr>) =>
      children(root, 'footprint')
        .flatMap((f) => children(f, 'pad'))
        .map((p) => {
          const at = child(p, 'at')!;
          return {
            id: val(child(p, 'uuid')),
            number: val(p),
            type: val(p, 2),
            shape: val(p, 3),
            xy: at.slice(1, 3),
            angle: ((Number(val(at, 3) || 0) % 360) + 360) % 360,
            size: child(p, 'size'),
            drill: child(p, 'drill'),
            layers: child(p, 'layers'),
            net: child(p, 'net'),
            rratio: child(p, 'roundrect_rratio'),
            chamfer: child(p, 'chamfer'),
            mask: child(p, 'solder_mask_margin'),
            paste: child(p, 'solder_paste_margin'),
          };
        });
    assert.deepEqual(pads(after), pads(before), `${entry.id}: pad geometry and parameters`);
    for (const kind of ['segment', 'via']) {
      const records = (root: ReturnType<typeof parseSExpr>) =>
        children(root, kind).map((n) =>
          Object.fromEntries(
            ['uuid', 'start', 'end', 'at', 'width', 'size', 'drill', 'layers', 'layer', 'net'].map(
              (k) => [k, child(n, k)],
            ),
          ),
        );
      assert.deepEqual(records(after), records(before), `${entry.id}: ${kind} geometry`);
    }
    const nativeLayers = children(after, 'layers')[0]
      .filter(Array.isArray)
      .filter((l) => val(l).endsWith('.Cu'))
      .map((l) => val(l));
    assert.deepEqual(nativeLayers, board.layers);
  }
});

test('rich board artwork moves and rotates as complete geometry and retains zone holes', () => {
  const { board } = load('pebench-powerboost-1000c');
  const arc = board.graphics.find((g) => g.kind === 'arc')!;
  const moved = movePCBSelection(
    board,
    { kind: 'graphic', id: arc.id },
    { x: 1.27, y: 2.54 },
  ).graphics.find((g) => g.id === arc.id)!;
  assert.ok(Math.abs(moved.mid!.x - arc.mid!.x - 1.27) < 1e-6);
  assert.ok(pcbGraphicPath(moved).includes(' A '));
  const rotated = rotatePCBSelection(board, { kind: 'graphic', id: arc.id }).graphics.find(
    (g) => g.id === arc.id,
  )!;
  assert.notDeepEqual(rotated.mid, arc.mid);
  const footprint = board.footprints.find((f) => f.zones?.some((z) => z.holes?.length))!;
  const flipped = flipPCBFootprint(footprint),
    restored = flipPCBFootprint(flipped);
  assert.deepEqual(restored.zones, footprint.zones);
  assert.deepEqual(restored.pads, footprint.pads);
});

test('rounded and chamfered pads remain distinct from rectangular pads', () => {
  const { board } = load('pebench-motor-shield-v2');
  const pad = board.footprints.flatMap((f) => f.pads).find((p) => p.chamfer?.length)!;
  assert.ok(pad.chamferRatio! > 0);
  assert.ok(pcbPadPath(pad).endsWith(' Z'));
  assert.notEqual(
    pcbPadPath(pad),
    pcbPadPath({ ...pad, chamfer: undefined, chamferRatio: undefined }),
  );
});

test('linked footprint captions follow schematic reference and value edits without duplicating canonical values', () => {
  const { board, circuit } = load('pebench-sunny-buddy');
  const f = board.footprints.find((f) => f.symbolId)!;
  assert.equal(f.reference, undefined);
  assert.equal(f.value, undefined);
  const ref = f.graphics.find((g) => g.text?.property === 'Reference')!,
    value = f.graphics.find((g) => g.text?.property === 'Value')!;
  assert.equal(ref.text!.value, '${REFERENCE}');
  assert.equal(value.text!.value, '${VALUE}');
  const part = circuit.parts.find((p) => p.id === f.symbolId)!;
  part.ref = 'U_RENAMED';
  part.value = 'Updated part';
  const native = children(parseSExpr(serializePCB(board, circuit)), 'footprint').find(
    (n) => val(child(n, 'uuid')) === f.id,
  )!;
  assert.equal(
    val(
      children(native, 'property').find((n) => val(n) === 'Reference'),
      2,
    ),
    part.ref,
  );
  assert.equal(
    val(
      children(native, 'property').find((n) => val(n) === 'Value'),
      2,
    ),
    part.value,
  );
  assert.equal(resolvePCBGraphic(ref, part.ref, part.value).text!.value, part.ref);
  assert.deepEqual(ref.start, resolvePCBGraphic(ref, part.ref, part.value).start);
});

test('ordinary footprint text keeps native macros while its display follows the current part value', () => {
  const { board, circuit } = load('pebench-autodriver-l6470');
  const f = board.footprints.find(
    (f) => f.symbolId && f.graphics.some((g) => !g.text?.property && g.text?.value === '${VALUE}'),
  )!;
  assert.ok(f, 'The source contains an ordinary dynamic Value caption.');
  const g = f.graphics.find((g) => !g.text?.property && g.text?.value === '${VALUE}')!;
  const part = circuit.parts.find((p) => p.id === f.symbolId)!;
  part.value = 'Edited jumper value';
  const exported = children(parseSExpr(serializePCB(board, circuit)), 'footprint').find(
    (n) => val(child(n, 'uuid')) === f.id,
  )!;
  const caption = children(exported, 'fp_text').find((n) => val(child(n, 'uuid')) === g.id)!;
  assert.equal(val(caption, 2), '${VALUE}', 'KiCad retains the dynamic macro after export.');
  assert.equal(
    resolvePCBGraphic(g, part.ref, part.value).text!.value,
    part.value,
    'The OpenPE renderer displays the current value.',
  );
});
