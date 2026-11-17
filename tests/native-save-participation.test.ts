import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createProject, parseProject, serializeProject } from '../lib/project';
import { toProjectDocument } from '../lib/project-document';
import { participatesInSimulation } from '../lib/simulation-participation';
import { child, children, parseSExpr, val, type SExpr } from '../lib/sexpr';

const filename = 'lm2596-to220-5-buck.kicad_pro';
const lm2596 = JSON.parse(
  readFileSync(new URL('../lib/reference-examples.json', import.meta.url), 'utf8'),
)['reference-lm2596-to220-5-buck'] as string;

for (const nativeBacked of [false, true]) {
  test(`native Save packets retain LM2596 participation toggles and captions (${nativeBacked ? 'native' : 'private'} input)`, () => {
    const initial = parseProject(lm2596);
    const core = new ProjectCore(
      nativeBacked ? projectFromNativeFiles(projectNativeFiles(initial, filename)) : initial,
      { nativeEntryName: filename },
    );
    const original = core.getNativeFiles();
    const partId = core
      .getSnapshot()
      .project!.schematic.parts.find((part) => part.ref === 'R1')!.id;
    for (const included of [false, true]) {
      const before = core.getSnapshot();
      core.execute('part.properties', {
        schematicId: before.project!.schematic.id,
        partId,
        value: '22k',
      });
      core.execute('part.participation', {
        schematicId: before.project!.schematic.id,
        partId,
        included,
      });
      const edited = core.getSnapshot();
      const snapshot = edited.project!;
      const packet = projectNativeFiles(snapshot, filename);
      // Save carries the exact current native packet through the private IPC
      // adapter. The host validates it and independently prepares its output.
      const payload = { ...snapshot, nativeFiles: packet };
      const written = projectNativeFiles(parseProject(serializeProject(payload)), filename);
      assert.deepEqual(written, packet, 'The private adapter retains every current native byte.');
      const rendererFiles = projectNativeFiles(payload, filename);
      assert.deepEqual(rendererFiles, written, 'Renderer materialization agrees with the host.');
      const schematic = parseSExpr(
        written.files.find((file) => file.name.endsWith('.kicad_sch'))!.source,
      );
      const symbol = children(schematic, 'symbol').find(
        (node) => val(child(node, 'uuid')) === partId,
      )!;
      assert.equal(val(child(symbol, 'exclude_from_sim')), included ? 'no' : 'yes');
      assert.equal(
        val(
          children(symbol, 'property').find((node) => val(node) === 'Value'),
          2,
        ),
        '22k',
      );
      const board = parseSExpr(
        written.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source,
      );
      const footprint = children(board, 'footprint').find(
        (node) => val(child(node, 'path')).split('/').at(-1) === partId,
      )!;
      assert.equal(
        val(
          children(footprint, 'property').find((node) => val(node) === 'Value'),
          2,
        ),
        '22k',
      );
      assert.equal(core.materialize(snapshot, { ...snapshot, nativeFiles: rendererFiles }), true);
      const saved = core.getSnapshot();
      assert.equal(saved.undoDepth, edited.undoDepth, 'Save creates no extra undo edit.');
      assert.deepEqual(core.getNativeFiles(), written);
      assert.deepEqual(projectNativeFiles(parseProject(saved.source), filename), written);
      const reopened = projectFromNativeFiles(written);
      assert.equal(
        participatesInSimulation(reopened.schematic.parts.find((part) => part.id === partId)!),
        included,
      );
    }
    // Both accepted participation changes and the Value edit remain ordinary
    // project edits despite the intervening Save materializations.
    while (core.getSnapshot().canUndo) core.undo();
    assert.deepEqual(core.getNativeFiles(), original);
  });
}

test('native hide comparison retains private layout syntax and detects custom field edits', () => {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 25.4, 25.4);
  circuit.parts.push(part);
  const project = parseProject(serializeProject(createProject(circuit)));
  const owner = project.schematic.parts[0];
  const reference = children(owner.raw!, 'property').find((node) => val(node) === 'Reference')!;
  const effects = child(reference, 'effects')!;
  const font = child(effects, 'font')!;
  child(reference, 'at')![1] = '29.21';
  font.push('bold');
  effects.push('hide');
  reference.push(['show_name', 'yes']);
  const before = structuredClone(reference);
  const document = toProjectDocument(project);
  const layout = document.schematic.components![0].fieldLayout!.Reference;
  assert.deepEqual(child(layout as SExpr, 'at'), child(before, 'at'));
  assert.ok(child(child(layout as SExpr, 'effects')!, 'font')!.includes('bold'));
  assert.deepEqual(child(layout as SExpr, 'show_name'), ['show_name', 'yes']);
  assert.ok(child(layout as SExpr, 'effects')!.includes('hide'));
  assert.equal(child(layout as SExpr, 'hide'), undefined);
  assert.deepEqual(reference, before, 'Native comparison never changes private field syntax.');

  const duplicate = structuredClone(project);
  const duplicateReference = children(duplicate.schematic.parts[0].raw!, 'property').find(
    (node) => val(node) === 'Reference',
  )!;
  duplicateReference.push(['hide', 'yes']);
  const duplicateLayout =
    toProjectDocument(duplicate).schematic.components![0].fieldLayout!.Reference;
  assert.ok(child(duplicateLayout as SExpr, 'effects')!.includes('hide'));
  assert.deepEqual(child(duplicateLayout as SExpr, 'hide'), ['hide', 'yes']);

  const packet = projectNativeFiles(project, filename);
  const native = projectFromNativeFiles(packet);
  assert.deepEqual(
    projectNativeFiles(parseProject(serializeProject(native)), filename),
    packet,
    'Equivalent native hidden syntax retains the exact imported source.',
  );
  const schematicSource = (files: typeof packet) =>
    files.files.find((file) => file.name.endsWith('.kicad_sch'))!.source;
  const field = (owner: typeof native) =>
    children(owner.schematic.parts[0].raw!, 'property').find((node) => val(node) === 'Reference')!;
  const mutations: ((property: SExpr) => void)[] = [
    (property) => {
      child(property, 'at')![1] = '30.48';
    },
    (property) => {
      child(child(property, 'effects')!, 'font')!.push('italic');
    },
    (property) => {
      child(property, 'show_name')![1] = 'no';
    },
    (property) => {
      property.push(['hide', 'yes']);
    },
    (property) => {
      child(property, 'hide')!.push('unknown');
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(native);
    mutate(field(changed));
    const files = projectNativeFiles(changed, filename);
    assert.notEqual(
      schematicSource(files),
      schematicSource(packet),
      'Position, style, other attributes and non-singleton hide records cannot reuse stale bytes.',
    );
  }
});
