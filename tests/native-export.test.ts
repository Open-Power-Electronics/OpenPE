import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  appendSchematic,
  exportKiCad,
  exportModelCadScad,
  modelCadFromProject,
  parseProject,
  projectFilename,
  serializeProject,
} from '../lib/project';
import { newModelCadObject, withModelCad, type ModelCadObject } from '../lib/model-cad';
import { exampleProject } from '../lib/project-example';

const { createNativeExport } = createRequire(import.meta.url)('../electron/native-export.cjs');
const formats = { parseProject, exportKiCad, modelCadFromProject, exportModelCadScad, projectFilename };
type PickerResult = { canceled: boolean; filePath?: string };
type PickerOptions = {
  title: string;
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
};

function setup(result: PickerResult) {
  const writes: { file: string; content: string }[] = [];
  const dialogs: PickerOptions[] = [];
  const run = createNativeExport({
    ...formats,
    showSaveDialog: async (options: PickerOptions) => {
      dialogs.push(options);
      return result;
    },
    atomicWrite: async (file: string, content: string) => {
      writes.push({ file, content });
    },
  });
  return { run, writes, dialogs };
}

test('native Export uses file types to serialize the selected schematic or PCB', async () => {
  const { project, schematic } = appendSchematic(exampleProject());
  const schematicId = schematic.id;
  const source = serializeProject(project);
  for (const [extension, kind] of [
    ['kicad_sch', 'schematic'],
    ['kicad_pcb', 'pcb'],
  ] as const) {
    const file = path.resolve('export.' + extension);
    const { run, writes, dialogs } = setup({ canceled: false, filePath: file });
    const result = await run({ source, name: 'Output stage', schematicId });
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, 'Export');
    assert.equal(dialogs[0].defaultPath, 'Output stage.kicad_sch');
    assert.deepEqual(
      dialogs[0].filters.map((entry) => entry.extensions),
      [['kicad_sch'], ['kicad_pcb']],
    );
    assert.deepEqual(writes, [
      { file, content: exportKiCad(parseProject(source), kind, schematicId) },
    ]);
    assert.equal(result.kind, kind);
    assert.equal(serializeProject(project), source);
  }
});

test('PCB export prepares its portable assets before writing and preserves the export on preparation failure', async () => {
  const source = serializeProject(exampleProject());
  const file = path.resolve('export.kicad_pcb');
  const actions: string[] = [];
  let fail = false;
  const run = createNativeExport({
    ...formats,
    showSaveDialog: async () => ({ canceled: false, filePath: file }),
    preparePCBFiles: async (project: ReturnType<typeof parseProject>, destination: string) => {
      assert.equal(serializeProject(project), source);
      assert.equal(destination, file);
      actions.push('assets');
      if (fail) throw new Error('Invalid existing model');
    },
    atomicWrite: async () => {
      actions.push('export');
    },
  });
  await run({ source, kind: 'pcb' });
  assert.deepEqual(actions, ['assets', 'export']);
  fail = true;
  await assert.rejects(run({ source, kind: 'pcb' }), /Invalid existing model/);
  assert.deepEqual(actions, ['assets', 'export', 'assets']);
});

test('native Export cancels without writes and rejects unsupported extensions and unavailable PCB', async () => {
  const project = exampleProject();
  project.pcb = null;
  const source = serializeProject(project);
  const cancelled = setup({ canceled: true });
  assert.equal(await cancelled.run({ source }), null);
  assert.equal(cancelled.writes.length, 0);
  assert.deepEqual(cancelled.dialogs[0].filters, [
    { name: 'Schematic', extensions: ['kicad_sch'] },
  ]);
  for (const extension of ['openpe.json', 'txt', 'kicad_pcb', 'scad']) {
    const { run, writes } = setup({
      canceled: false,
      filePath: path.resolve('export.' + extension),
    });
    await assert.rejects(run({ source }), /supported export file type/);
    assert.equal(writes.length, 0);
  }
  const invalid = setup({ canceled: false, filePath: path.resolve('export.kicad_sch') });
  await assert.rejects(invalid.run({ source: '{invalid' }));
  assert.equal(invalid.dialogs.length, 0);
  assert.equal(invalid.writes.length, 0);
});

test('native Export adds a default extension and retains explicitly requested formats', async () => {
  const source = serializeProject(exampleProject());
  const { run, writes, dialogs } = setup({ canceled: false, filePath: path.resolve('export') });
  await run({ source, kind: 'pcb' });
  assert.deepEqual(dialogs[0].filters, [{ name: 'PCB', extensions: ['kicad_pcb'] }]);
  assert.ok(writes[0].file.endsWith('.kicad_pcb'));
  assert.ok(writes[0].content.startsWith('(kicad_pcb'));
});

const modelSource = (edit: (box: ModelCadObject) => ModelCadObject = (box) => box) => {
  const project = exampleProject();
  const box = edit(newModelCadObject(project.pcb!, 'box'));
  return serializeProject(withModelCad(project, { version: 1, objects: [box] }));
};

test('native Export offers Model CAD solids as OpenSCAD without preparing PCB assets', async () => {
  const source = modelSource();
  const file = path.resolve('enclosure.scad');
  const dialogs: PickerOptions[] = [];
  const writes: { file: string; content: string }[] = [];
  const run = createNativeExport({
    ...formats,
    showSaveDialog: async (options: PickerOptions) => {
      dialogs.push(options);
      return { canceled: false, filePath: file };
    },
    preparePCBFiles: async () => {
      throw new Error('OpenSCAD export prepared PCB assets');
    },
    atomicWrite: async (destination: string, content: string) => {
      writes.push({ file: destination, content });
    },
  });
  assert.deepEqual(await run({ source, name: 'Enclosure' }), {
    name: 'enclosure.scad',
    path: file,
    kind: 'scad',
  });
  assert.deepEqual(dialogs[0].filters, [
    { name: 'Schematic', extensions: ['kicad_sch'] },
    { name: 'PCB', extensions: ['kicad_pcb'] },
    { name: 'OpenSCAD model', extensions: ['scad'] },
  ]);
  assert.deepEqual(writes, [
    { file, content: exportModelCadScad(modelCadFromProject(parseProject(source))) },
  ]);
  assert.match(writes[0].content, /\n {4}cube\(\[20, 20, 10\], center = true\);\n/);
  const requested = setup({ canceled: true });
  assert.equal(await requested.run({ source, kind: 'pcb' }), null);
  assert.deepEqual(requested.dialogs[0].filters, [{ name: 'PCB', extensions: ['kicad_pcb'] }]);
});

test('native Export rejects OpenSCAD for edge-treated solids without writing', async () => {
  const source = modelSource((box) => ({
    ...box,
    edgeTreatment: { kind: 'fillet', distanceMm: 1, edges: ['side:0'] },
  }));
  const { run, writes } = setup({ canceled: false, filePath: path.resolve('enclosure.scad') });
  await assert.rejects(
    run({ source }),
    /OpenSCAD export: Box has chamfered or filleted edges, which OpenSCAD cannot represent\./,
  );
  assert.equal(writes.length, 0);
});

test('native Export rejects unsupported snapshot formats before opening a picker or writing', async () => {
  const document = JSON.parse(serializeProject(exampleProject()));
  document.format = 'unsupported-format';
  const { run, writes, dialogs } = setup({
    canceled: false,
    filePath: path.resolve('legacy-export.kicad_sch'),
  });
  await assert.rejects(
    run({ source: JSON.stringify(document) }),
    /unsupported internal snapshot format/i,
  );
  assert.equal(dialogs.length, 0);
  assert.equal(writes.length, 0);
});

test('native Export prevents overlapping pickers and releases its lock after failure', async () => {
  const source = serializeProject(exampleProject());
  let finish: (result: PickerResult) => void = () => {};
  let calls = 0;
  const run = createNativeExport({
    ...formats,
    showSaveDialog: () => {
      calls++;
      return new Promise<PickerResult>((resolve) => {
        finish = resolve;
      });
    },
    atomicWrite: async () => {
      throw new Error('Disk full');
    },
  });
  const first = run({ source });
  assert.equal(await run({ source }), null);
  assert.equal(calls, 1);
  finish({ canceled: false, filePath: path.resolve('export.kicad_sch') });
  await assert.rejects(first, /Disk full/);
  const retry = run({ source });
  assert.equal(calls, 2);
  finish({ canceled: true });
  assert.equal(await retry, null);
});
