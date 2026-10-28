import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import manifest from '../resources/example-catalog/manifest.json';
import { parseProject, exportKiCad } from '../lib/project';
import { parseSExpr, child, children, val, writeSExpr, type SExpr } from '../lib/sexpr';
import { resolvePCBGraphic, serializePCB } from '../lib/pcb';
import { flipPCBFootprint, movePCBSelection, rotatePCBSelection } from '../lib/pcb-layout';
import { pcbGraphicPath, pcbPadPath } from '../lib/pcb-geometry';
import { convertExamplePCB } from '../scripts/example-pcb';

const load = (index = 0) =>
  parseProject(
    readFileSync(`tests/fixtures/reference/${manifest.examples[index].file}.json`, 'utf8'),
  );
for (const entry of manifest.examples) {
  test(`${entry.id}: native pads and copper retain source geometry and nets`, () => {
    const original = parseSExpr(readFileSync(entry.source.pcb.path, 'utf8'));
    const project = parseProject(
      readFileSync(`tests/fixtures/reference/${entry.file}.json`, 'utf8'),
    );
    const exported = parseSExpr(exportKiCad(project, 'pcb'));
    const records = (root: SExpr, kind: string, keys: string[]) =>
      children(root, kind).map((n) => Object.fromEntries(keys.map((key) => [key, child(n, key)])));
    for (const kind of ['segment', 'via'])
      assert.deepEqual(
        records(exported, kind, [
          'uuid',
          'start',
          'end',
          'at',
          'width',
          'size',
          'drill',
          'layers',
          'layer',
          'net',
        ]),
        records(original, kind, [
          'uuid',
          'start',
          'end',
          'at',
          'width',
          'size',
          'drill',
          'layers',
          'layer',
          'net',
        ]),
      );
    const pads = (root: SExpr) =>
      children(root, 'footprint')
        .flatMap((f) => children(f, 'pad'))
        .map((p) => ({
          number: val(p),
          type: val(p, 2),
          shape: val(p, 3),
          at: child(p, 'at')!.slice(1, 3),
          rotation: ((Number(val(child(p, 'at'), 3) || 0) % 360) + 360) % 360,
          data: Object.fromEntries(
            [
              'uuid',
              'size',
              'drill',
              'layers',
              'net',
              'roundrect_rratio',
              'zone_connect',
              'remove_unused_layers',
            ].map((key) => [key, child(p, key)]),
          ),
        }));
    assert.deepEqual(pads(exported), pads(original));
    for (const footprint of project.pcb!.footprints) {
      assert.ok(
        footprint.symbolId,
        'Every selected source package is linked to a schematic component.',
      );
      const part = project.schematic.parts.find((p) => p.id === footprint.symbolId)!;
      assert.equal(part.fields?.Footprint, footprint.libraryId);
    }
  });
}

test('source PCB rectangles become exact editable polygons, and unsupported content still fails', () => {
  const project = load();
  const rectangle = project.pcb!.graphics.find(
    (g) => g.layer === 'Edge.Cuts' && g.kind === 'polygon',
  )!;
  assert.ok(rectangle);
  assert.equal(rectangle.points!.length, 2);
  const moved = movePCBSelection(
    project.pcb!,
    { kind: 'graphic', id: rectangle.id },
    { x: 1.27, y: 2.54 },
  ).graphics.find((g) => g.id === rectangle.id)!;
  assert.equal(moved.start.x, rectangle.start.x + 1.27);
  assert.ok(pcbGraphicPath(moved).endsWith(' Z'));
  const rotated = rotatePCBSelection(project.pcb!, {
    kind: 'graphic',
    id: rectangle.id,
  }).graphics.find((g) => g.id === rectangle.id)!;
  assert.notDeepEqual(rotated.points, rectangle.points);
  const footprint = project.pcb!.footprints[0];
  assert.deepEqual(flipPCBFootprint(flipPCBFootprint(footprint)), {
    ...footprint,
    rotation: ((footprint.rotation % 360) + 360) % 360,
  });
  const native = parseSExpr(exportKiCad(project, 'pcb'));
  native.splice(
    native.findIndex((n) => Array.isArray(n) && n[0] === 'title_block'),
    1,
  );
  native.push(['unsupported_feature']);
  assert.throws(
    () => convertExamplePCB(writeSExpr(native), project.schematic, 'fixture'),
    /unsupported unsupported_feature/,
  );
});

test('rounded and chamfered pads keep distinct drawing geometry', () => {
  const pad = load()
    .pcb!.footprints.flatMap((f) => f.pads)
    .find((p) => p.shape === 'roundrect')!;
  assert.ok(pad.roundrectRatio! > 0);
  assert.notEqual(
    pcbPadPath(pad),
    pcbPadPath({ ...pad, shape: 'rect', roundrectRatio: undefined }),
  );
  const chamfered = { ...pad, chamfer: ['top_left'] as 'top_left'[], chamferRatio: 0.2 };
  assert.notEqual(pcbPadPath(chamfered), pcbPadPath(pad));
});

test('linked PCB captions follow schematic edits while ordinary text retains its native macros', () => {
  const project = load();
  const f = project.pcb!.footprints.find((f) =>
    f.graphics.some((g) => g.text?.value === '${REFERENCE}' && !g.text.property),
  )!;
  const part = project.schematic.parts.find((p) => p.id === f.symbolId)!;
  part.ref = 'U_RENAMED';
  part.value = 'Edited value';
  assert.equal(f.reference, undefined);
  assert.equal(f.value, undefined);
  const caption = f.graphics.find((g) => g.text?.property === 'Value')!;
  assert.equal(resolvePCBGraphic(caption, part.ref, part.value).text!.value, part.value);
  const native = children(
    parseSExpr(serializePCB(project.pcb!, project.schematic)),
    'footprint',
  ).find((n) => val(child(n, 'uuid')) === f.id)!;
  assert.equal(
    val(
      children(native, 'property').find((n) => val(n) === 'Value'),
      2,
    ),
    part.value,
  );
  const macro = f.graphics.find((g) => g.text?.value === '${REFERENCE}' && !g.text.property)!;
  assert.equal(
    val(
      children(native, 'fp_text').find((n) => val(child(n, 'uuid')) === macro.id),
      2,
    ),
    '${REFERENCE}',
  );
  assert.equal(resolvePCBGraphic(macro, part.ref, part.value).text!.value, part.ref);
});
