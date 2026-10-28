import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createExample } from '../lib/examples';
import { exportKiCad, importDocument, parseProject, serializeProject } from '../lib/project';
import { child, children, parseSExpr, val, writeSExpr, type SExpr } from '../lib/sexpr';
import { pinPositions, serializeCircuit } from '../lib/circuit';
import { schematicTexts } from '../lib/schematic-text';
import manifest from './fixtures/kicad/manifest.json';
import snapshot from '../lib/kicad-examples.json';
import { displayPartValue, extraSymbolAnnotations, symbolAnnotation } from '../lib/library';
import { arrangeExampleText } from '../lib/example-layout';

for (const entry of manifest.examples) {
  test(`${entry.id}: upstream provenance, geometry and native content survive independent copies`, () => {
    const id = entry.id as keyof typeof snapshot;
    const source = readFileSync(`tests/fixtures/kicad/upstream/${entry.file}`, 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), entry.sha256);
    const canvasSource = parseSExpr(source).filter(
      (node) => !Array.isArray(node) || node[0] !== 'paper',
    );
    assert.deepEqual(parseSExpr(snapshot[id]), canvasSource);
    const original = importDocument(source);
    const a = createExample(id);
    const b = createExample(id);
    const arranged = serializeProject(a);
    arrangeExampleText(a.schematic, id);
    assert.equal(serializeProject(a), arranged, 'Example text layout must be idempotent.');
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.schematic.id, b.schematic.id);
    const uuidSet = (root: SExpr) => {
      const result = new Set<string>();
      const walk = (n: SExpr) => {
        if (n[0] === 'uuid') result.add(val(n));
        for (const v of n) if (Array.isArray(v)) walk(v);
      };
      walk(root);
      return result;
    };
    const oldIds = uuidSet(original.schematic.original!);
    const aIds = uuidSet(a.schematic.original!);
    for (const id of uuidSet(b.schematic.original!)) {
      assert.ok(!aIds.has(id));
      assert.ok(!oldIds.has(id));
    }
    const native = exportKiCad(a, 'schematic');
    for (const id of oldIds)
      assert.ok(!native.includes(id), 'Instance paths must use fresh UUIDs.');
    const reopened = importDocument(native);
    const geometry = (p: typeof a) => ({
      parts: p.schematic.parts.map((part) => ({
        ref: part.ref,
        value: part.value,
        libId: part.libId,
        x: part.x,
        y: part.y,
        rotation: part.rotation,
        pins: pinPositions(part, p.schematic.libraries[part.libId]),
      })),
      wires: p.schematic.wires.map((w) => [w.a, w.b]),
      texts: schematicTexts(p.schematic.original).map(({ id: _id, ...text }) => text),
    });
    assert.deepEqual(geometry(a), geometry(original));
    assert.deepEqual(geometry(reopened), geometry(original));
    const properties = (root: SExpr) =>
      children(root, 'symbol').map((s) => children(s, 'property').map((p) => [val(p), val(p, 2)]));
    assert.deepEqual(
      properties(parseSExpr(native)),
      properties(parseSExpr(serializeCircuit(original.schematic))),
    );
    assert.equal(serializeProject(parseProject(serializeProject(a))), serializeProject(a));
    assert.equal(a.pcb, null);
    assert.match(JSON.stringify(a.extensions), /CC-BY-SA-4.0/);
    b.schematic.parts[0].value = 'changed';
    assert.notEqual(a.schematic.parts[0].value, 'changed');

    // Text cleanup must agree across canvas anchors and native instance fields.
    const nativeParts = children(parseSExpr(native), 'symbol');
    for (const part of a.schematic.parts) {
      const exported = nativeParts.find((s) => val(child(s, 'uuid')) === part.id)!;
      for (const name of ['Reference', 'Value'] as const) {
        if (part.ref.startsWith('#')) continue;
        const at = child(
          children(exported, 'property').find((f) => val(f) === name)!,
          'at',
        )!;
        const position = symbolAnnotation(part, a.schematic.libraries[part.libId], name)!;
        assert.equal(Number(at[3]), 0, `${part.ref} ${name} must be upright`);
        assert.ok(Math.abs(Number(at[1]) - position.x) < 0.0001);
        assert.ok(Math.abs(Number(at[2]) - position.y) < 0.0001);
      }
      assert.ok(!displayPartValue(part).includes('${SIM.PARAMS}'));
      for (const extra of extraSymbolAnnotations(part)) assert.equal(extra.rotation, 0);
    }
    assert.ok(reopened.schematic.labels.every((l) => !l.rotation));
  });
}

test('the retained KiCad simulation catalog has nine official examples', () => {
  assert.equal(manifest.examples.length, 9);
  assert.equal(new Set(manifest.examples.map((entry) => entry.id)).size, 9);
  assert.deepEqual(
    manifest.examples.slice(0, 6).map((entry) => entry.id),
    [
      'kicad-rectifier',
      'kicad-buck',
      'kicad-boost',
      'kicad-royer',
      'kicad-high-voltage',
      'kicad-lm317',
    ],
  );
});

test('power examples retain local symbol variants, catalog links and active-sheet references', () => {
  const project = createExample('kicad-high-voltage');
  const file = JSON.parse(serializeProject(project));
  const diodes = file.schematic.components.filter(
    (p: { libraryId?: string }) => p.libraryId === 'Simulation_SPICE:DIODE',
  );
  assert.equal(diodes.length, 9);
  assert.equal(new Set(diodes.map((p: { symbol: string }) => p.symbol)).size, 5);
  const recovered = parseProject(JSON.stringify(file));
  assert.deepEqual(recovered.schematic.libraries, project.schematic.libraries);
  const exported = parseSExpr(exportKiCad(recovered, 'schematic'));
  for (const part of diodes) {
    const native = children(exported, 'symbol').find((s) => val(child(s, 'uuid')) === part.id)!;
    assert.equal(val(child(native, 'lib_name')), part.symbol);
    assert.equal(val(child(native, 'lib_id')), part.libraryId);
  }
  const broken = structuredClone(file);
  broken.schematic.components.find((p: { libraryId?: string }) => p.libraryId).symbol = 'missing';
  assert.throws(() => parseProject(JSON.stringify(broken)), /missing embedded symbol/);
  const duplicated = structuredClone(file);
  duplicated.schematic.components[0].kicad.push(['lib_name', '"other"']);
  assert.throws(() => parseProject(JSON.stringify(duplicated)), /Invalid OpenPE project/);

  const boost = createExample('kicad-boost');
  const refs = boost.schematic.parts.map((p) => p.ref);
  assert.equal(new Set(refs).size, refs.length);
  const original = parseSExpr(readFileSync('tests/fixtures/kicad/upstream/smps-com.kicad_sch', 'utf8'));
  const rootId = val(child(original, 'uuid'));
  assert.deepEqual(
    refs,
    children(original, 'symbol').map((s) => {
      const paths = children(child(s, 'instances')!, 'project').flatMap((p) => children(p, 'path'));
      return val(
        child(
          paths.find((p) => val(p) === '/' + rootId)!,
          'reference',
        ),
      );
    }),
  );
  const first = children(original, 'symbol')[0];
  const owner = children(child(first, 'instances')!, 'project').find((project) =>
    children(project, 'path').some((path) => val(path) === '/' + rootId),
  )!;
  const conflict = structuredClone(
    children(owner, 'path').find((path) => val(path) === '/' + rootId)!,
  );
  child(conflict, 'reference')![1] = '"conflicting-reference"';
  owner.push(conflict);
  assert.throws(() => importDocument(writeSExpr(original)), /Conflicting symbol instances/);
});

test('LM317 annotation color survives JSON and native exports with bounded RGBA validation', () => {
  const project = createExample('kicad-lm317');
  const file = JSON.parse(serializeProject(project));
  const text = file.schematic.texts.find((t: { color?: number[] }) => t.color);
  assert.deepEqual(text.color, [255, 0, 0, 1]);
  const recovered = importDocument(exportKiCad(parseProject(JSON.stringify(file)), 'schematic'));
  assert.deepEqual(
    schematicTexts(recovered.schematic.original).find((t) => t.id === text.id)?.color,
    text.color,
  );
  for (const color of [
    [256, 0, 0, 1],
    [255, 0, 0, -1],
    [0, 0, 0],
    ['red', 0, 0, 1],
  ]) {
    text.color = color;
    assert.throws(() => parseProject(JSON.stringify(file)), /Invalid OpenPE project/);
  }
});

test('example text layout is repeatable and keeps simulation field contents unchanged', () => {
  const p = createExample('kicad-rectifier');
  const before = serializeProject(p);
  arrangeExampleText(p.schematic, 'kicad-rectifier');
  assert.equal(serializeProject(p), before);
  const rectifier = createExample('kicad-rectifier');
  const source = rectifier.schematic.parts.find((part) => part.ref === 'V1')!;
  assert.equal(displayPartValue(source), 'dc=0 ampl=1 f=1k ac=1');
  assert.equal(extraSymbolAnnotations(source).length, 0);
  assert.equal(source.value, '${SIM.PARAMS}');
});

test('free text rejects unsupported rendering and duplicate object IDs before saving', () => {
  const p = createExample('kicad-rectifier');
  const text = children(p.schematic.original!, 'text')[0];
  child(text, 'uuid')![1] = JSON.stringify(p.schematic.parts[0].id);
  assert.throws(() => serializeProject(p), /duplicate UUID/);
  const q = createExample('kicad-rectifier');
  child(children(q.schematic.original!, 'text')[0], 'at')![3] = '90';
  assert.throws(() => serializeProject(q), /Unsupported schematic text/);
  const r = createExample('kicad-rectifier');
  child(child(children(r.schematic.original!, 'text')[0], 'effects')!, 'font')!.push([
    'face',
    '"missing font"',
  ]);
  assert.throws(() => serializeProject(r), /Unsupported schematic text/);
});
