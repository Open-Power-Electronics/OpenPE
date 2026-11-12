import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProject, serializeProject } from '../lib/project';
import { exportProjectFile } from '../lib/manufacturing-export';
import { projectExportFormats } from '../lib/export-formats';
import { exportProjectFile as exportHostProjectFile } from '../server/manufacturing-format.mjs';
import { manufacturingProject } from './manufacturing-fixture';
import { atomicWrite } from '../server/atomic-write.mjs';
import { newModelCadObject, withModelCad } from '../lib/model-cad';
const { createNativeExport } = createRequire(import.meta.url)('../electron/native-export.cjs');
const { FileGrants } = createRequire(import.meta.url)('../electron/file-grants.cjs');
const source = () => serializeProject(manufacturingProject());
const formats = { parseProject, exportProjectFile: exportHostProjectFile, projectExportFormats };
const request = (format = 'bom') => ({ source: source(), name: 'Power stage.kicad_pro', format });

function setup(result: { canceled: boolean; filePath?: string }) {
  const writes: { file: string; content: Buffer }[] = [],
    dialogs: any[] = [],
    fileGrants = new FileGrants();
  const run = createNativeExport({
    ...formats,
    fileGrants,
    showSaveDialog: async (options: unknown) => {
      dialogs.push(options);
      return result;
    },
    atomicWrite: async (file: string, content: Buffer) => {
      writes.push({ file, content });
    },
  });
  return { run, writes, dialogs, fileGrants };
}

test('Export pickers use format-specific filters and the host writes the same bytes as the browser compiler', async () => {
  for (const format of projectExportFormats.filter((format) => format.id !== 'scad')) {
    const file = path.resolve('manufacturing.' + format.extension),
      state = setup({ canceled: false, filePath: file });
    const options = request(format.id),
      result = await state.run(options);
    assert.equal(state.dialogs[0].title, 'Export ' + format.label);
    assert.deepEqual(state.dialogs[0].filters, [
      { name: format.label, extensions: [format.extension] },
    ]);
    assert.deepEqual(state.writes, [
      {
        file,
        content: Buffer.from(
          exportProjectFile(parseProject(options.source), format.id, options.name).bytes,
        ),
      },
    ]);
    assert.deepEqual(result, { name: path.basename(file), format: format.id });
    assert.equal(state.fileGrants.find(file), undefined);
  }
});

test('Schematic XML exports without a PCB and invalid DXF fails before the picker', async () => {
  const project = manufacturingProject();
  project.pcb!.graphics.pop();
  const dxf = setup({ canceled: true });
  await assert.rejects(
    dxf.run({ ...request('dxf'), source: serializeProject(project) }),
    /outline is open/,
  );
  assert.equal(dxf.dialogs.length, 0);

  const netlist = setup({ canceled: false, filePath: path.resolve('schematic') });
  assert.deepEqual(
    await netlist.run({
      ...request('netlist'),
      source: serializeProject({ ...project, pcb: null }),
    }),
    {
      name: 'schematic.xml',
      format: 'netlist',
    },
  );
  assert.match(netlist.writes[0].content.toString(), /<export version="E">/);
});

test('Export cancellation, invalid formats/snapshots and wrong extensions preserve files', async () => {
  const cancelled = setup({ canceled: true });
  assert.equal(await cancelled.run(request()), null);
  assert.equal(cancelled.writes.length, 0);
  for (const options of [
    { ...request(), format: 'pcb' },
    { ...request(), path: 'arbitrary' },
    { ...request(), source: '{}' },
  ]) {
    const state = setup({ canceled: true });
    await assert.rejects(state.run(options));
    assert.equal(state.dialogs.length, 0);
    assert.equal(state.writes.length, 0);
  }
  const wrong = setup({ canceled: false, filePath: path.resolve('design.kicad_pcb') });
  await assert.rejects(wrong.run(request()), /Choose a .csv/);
  assert.equal(wrong.writes.length, 0);
});

test('Export protects live source files and rechecks the originating frame after the picker', async () => {
  const file = path.resolve('open.csv'),
    state = setup({ canceled: false, filePath: file });
  state.fileGrants.create(file);
  await assert.rejects(state.run(request()), /open project source/);
  assert.equal(state.writes.length, 0);
  let checks = 0;
  const stale = setup({ canceled: false, filePath: path.resolve('export.csv') });
  await assert.rejects(
    stale.run(request(), () => {
      if (++checks > 1) throw new Error('Unauthorized window.');
    }),
    /Unauthorized/,
  );
  assert.equal(stale.writes.length, 0);
});

test('Export prevents overlapping pickers and releases its lock for retry', async () => {
  let finish!: (value: unknown) => void,
    calls = 0;
  const run = createNativeExport({
    ...formats,
    fileGrants: new FileGrants(),
    showSaveDialog: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    atomicWrite: async () => {
      throw new Error('Disk full');
    },
  });
  const first = run(request());
  assert.equal(await run(request()), null);
  assert.equal(calls, 1);
  finish({ canceled: false, filePath: path.resolve('export.csv') });
  await assert.rejects(first, /Disk full/);
  const retry = run(request());
  assert.equal(calls, 2);
  finish({ canceled: true });
  assert.equal(await retry, null);
});

test('Export atomically replaces selected files, rejects links and preserves the old file when the final guard fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-manufacturing-')),
    file = path.join(root, 'bom.csv');
  await writeFile(file, 'previous');
  let valid = true;
  const run = createNativeExport({
    ...formats,
    fileGrants: new FileGrants(),
    showSaveDialog: async () => ({ canceled: false, filePath: file }),
    atomicWrite: async (file: string, bytes: Buffer, check: () => Promise<void>) => {
      await atomicWrite(file, bytes, async () => {
        await check();
        if (!valid) throw new Error('Cancelled');
        valid = false;
      });
    },
  });
  await assert.rejects(run(request()), /Cancelled/);
  assert.equal(await readFile(file, 'utf8'), 'previous');
  const linked = path.join(root, 'linked.csv');
  try {
    await symlink(file, linked);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  const state = setup({ canceled: false, filePath: linked });
  await assert.rejects(state.run(request()), /linked/);
  assert.equal(await readFile(file, 'utf8'), 'previous');
});

test('OpenSCAD remains a separate exchange format and rejects unsupported solids before the picker', async () => {
  const project = manufacturingProject(),
    box = newModelCadObject(project.pcb!, 'box');
  const good = withModelCad(project, { version: 1, objects: [box] });
  const state = setup({ canceled: false, filePath: path.resolve('enclosure.scad') });
  await state.run({ source: serializeProject(good), name: 'enclosure', format: 'scad' });
  assert.match(state.writes[0].content.toString(), /cube\(/);
  const bad = withModelCad(project, {
    version: 1,
    objects: [{ ...box, edgeTreatment: { kind: 'fillet', distanceMm: 1, edges: ['side:0'] } }],
  });
  const rejected = setup({ canceled: true });
  await assert.rejects(
    rejected.run({ source: serializeProject(bad), name: 'enclosure', format: 'scad' }),
    /OpenSCAD/,
  );
  assert.equal(rejected.dialogs.length, 0);
});

test('file grants identify paths by the native canonical path', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-grants-'));
  const file = path.join(directory, 'Board.kicad_pro');
  await writeFile(file, 'project');
  const grants = new FileGrants();
  const id = grants.create(file);
  assert.equal(grants.find(await realpath(file)), id);
  const otherCase = path.join(path.dirname(await realpath(file)), 'board.kicad_pro');
  let nativeSame = false;
  try {
    nativeSame = realpathSync.native(otherCase) === realpathSync.native(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  assert.equal(grants.find(otherCase), process.platform === 'win32' || nativeSame ? id : undefined);
});
