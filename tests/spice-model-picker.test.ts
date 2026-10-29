import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectCore } from '../core/project-core';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createProject } from '../lib/project';
import { partFields } from '../lib/library';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  type KiCadProjectFiles,
} from '../lib/kicad-project';

const require = createRequire(import.meta.url);
const { FileGrants } = require('../electron/file-grants.cjs');
const { registerSpiceModelPicker } = require('../electron/spice-model-picker.cjs');
const { readSpiceModelFile } = require('../electron/spice-model-picker.cjs');
const {
  MAX_MODEL_BYTES,
  spiceModelDeclarations,
} = require('../electron/spice-model-declarations.cjs');
const externalModels = [{ name: 'vendor', kind: 'subcircuit', pins: ['1', '2'] }];
const internalModels = [
  { name: 'LM2596_TRANS', kind: 'subcircuit', pins: ['1', '2', '3', '4', '5'] },
];

test('declaration discovery lists actual model names and subcircuit ports without exposing local definitions or controls', () => {
  const source = `\uFEFF* UTF-8 library\n.include never-read.lib\n.MODEL 1N4148 D(Is=2n)\n+ Rs=.2\n.subckt amplifier IN+ IN- V+ V- OUT\n+ PARAMS: GAIN=100k\n.model local NPN(Bf=100)\n.subckt nested 1 2\nR1 1 2 1k\n.ends nested\n.ends amplifier\n.control\n.model ignored NMOS\n.endc\n.model switcher VDMOS(Kp=10)\n`;
  assert.deepEqual(spiceModelDeclarations(Buffer.from(source)), {
    models: [
      { name: '1N4148', kind: 'model', device: 'D', pins: ['A', 'K'] },
      { name: 'amplifier', kind: 'subcircuit', pins: ['IN+', 'IN-', 'V+', 'V-', 'OUT'] },
      { name: 'switcher', kind: 'model', device: 'VDMOS', pins: ['D', 'G', 'S'] },
    ],
    issues: [],
  });
  assert.deepEqual(
    spiceModelDeclarations(Buffer.from('.subckt vendor 1 2 gain=10 ; comment\n.ends\n')),
    { models: externalModels, issues: [] },
  );
});

test('declaration discovery rejects ambiguous, malformed, binary and oversized libraries', () => {
  for (const source of [
    '',
    '* comment only',
    '.include elsewhere.lib',
    '.model repeated D(Is=1n)\n.model REPEATED D(Is=2n)\n',
    '.model repeated D\n.subckt repeated 1 2\n.ends\n',
    '.model invalid@name D\n',
    '.subckt bad 1 1\n.ends\n',
    '.subckt missing-end 1 2\n',
    '.ends missing-start\n',
    '.subckt wrong 1 2\n.ends different\n',
    '.subckt no-ports PARAMS: R=1\n.ends\n',
    '.model bad\0name D\n',
    '.model fine D\n.control\n',
    '.model fine D\n.endc\n',
    '.model fine D\n.control\n.control\n.endc\n',
    '.subckt too-many ' + Array.from({ length: 65 }, (_, i) => String(i)).join(' ') + '\n.ends\n',
    Array.from({ length: 257 }, (_, i) => `.model d${i} D`).join('\n'),
  ])
    assert.throws(() => spiceModelDeclarations(Buffer.from(source)));
  assert.throws(() => spiceModelDeclarations(Buffer.from([0xff, 0xfe, 0x00, 0x01])), /binary/);
  assert.throws(
    () => spiceModelDeclarations(Buffer.from('.model naïve D\n', 'latin1')),
    /Invalid SPICE model/,
  );
  assert.throws(() => spiceModelDeclarations(Buffer.alloc(MAX_MODEL_BYTES + 1, 0x20)), /2 MiB/);
});

test('vendor 8-bit comment bytes remain opaque and only completely identical duplicate definitions are deduplicated', () => {
  const source = Buffer.from(
    '* copyright \xa9 vendor\n.model diode D(Is=1n)\n.model diode D(Is=1n)\n.subckt stage 1 2\nR1 1 2 1k\n.ends\n.subckt stage 1 2\nR1 1 2 1k\n.ends\n',
    'latin1',
  );
  assert.equal(spiceModelDeclarations(source).models.length, 2);
  assert.throws(
    () =>
      spiceModelDeclarations(
        Buffer.from('.subckt stage 1 2\nR1 1 2 1k\n.ends\n.subckt stage 1 2\nR1 1 2 2k\n.ends\n'),
      ),
    /No unambiguous/,
  );
});

test('ambiguous helper names are omitted with bounded issues while the main model remains selectable', () => {
  const result = spiceModelDeclarations(
    Buffer.from(
      '.subckt main IN OUT\nR1 IN OUT 1k\n.ends\n.model helper D(Is=1n)\n.model HELPER D(Is=2n)\n.subckt helper 1 2\n.ends\n',
    ),
  );
  assert.deepEqual(result.models, [{ name: 'main', kind: 'subcircuit', pins: ['IN', 'OUT'] }]);
  assert.deepEqual(result.issues, ['Skipped ambiguous model: helper.']);
});

test('native declaration inspection is bounded and parser failures retain file bytes and allow retry', async (t) => {
  const f = await fixture(t);
  for (const bytes of [
    Buffer.alloc(MAX_MODEL_BYTES + 1, 0x20),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('.include missing.lib\n'),
    Buffer.from('.model bad\0name D\n'),
  ]) {
    await writeFile(f.external, bytes);
    await assert.rejects(f.invoke());
    assert.deepEqual(await readFile(f.external), bytes);
  }
  const content =
    '.include missing.lib\n.model diode D(Is=1n)\n.subckt driver IN OUT params: GAIN=2\n.ends driver\n';
  await writeFile(f.external, content);
  const result = await f.invoke();
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].name, 'diode');
  assert.deepEqual(result.models[1].pins, ['IN', 'OUT']);
  assert.equal(await readFile(f.external, 'utf8'), content);
});

test('native declaration inspection rejects file bytes changed during its bounded read', async (t) => {
  const f = await fixture(t);
  const fileSystem = require('node:fs/promises');
  let changed = false;
  const racing = {
    ...fileSystem,
    open: async (...args: any[]) => {
      const handle = await fileSystem.open(...args);
      return {
        stat: (...args: any[]) => handle.stat(...args),
        close: () => handle.close(),
        read: async (...args: any[]) => {
          const result = await handle.read(...args);
          if (!changed) {
            changed = true;
            await writeFile(f.external, '.subckt edited 1 2\n.ends edited\n');
          }
          return result;
        },
      };
    },
  };
  await assert.rejects(readSpiceModelFile(f.external, racing), /changed/);
  assert.equal(await readFile(f.external, 'utf8'), '.subckt edited 1 2\n.ends edited\n');
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-spice-picker-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('openpe-spice-picker-'));
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project');
  const vendor = path.join(root, 'vendor models');
  await mkdir(path.join(project, 'circuits'), { recursive: true });
  await mkdir(vendor);
  const projectFile = path.join(project, 'design.kicad_pro');
  const external = path.join(vendor, 'vendor.lib');
  const internal = path.join(project, 'circuits', 'LM2596-5.lib');
  await writeFile(projectFile, '{}');
  await writeFile(external, '.subckt vendor 1 2\n.ends vendor\n');
  await writeFile(internal, '.subckt LM2596_TRANS 1 2 3 4 5\n.ends LM2596_TRANS\n');
  const grants = new FileGrants();
  const id = grants.create(projectFile);
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: any[] = [];
  let authorized = true;
  let choose: (options: any) => Promise<any> = async () => ({
    canceled: false,
    filePaths: [external],
  });
  registerSpiceModelPicker({
    ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) },
    authorize: () => {
      if (!authorized) throw new Error('Unauthorized window.');
    },
    grants,
    getWindow: () => 'owner-window',
    dialog: {
      showOpenDialog: async (owner: unknown, options: unknown) => {
        assert.equal(owner, 'owner-window');
        calls.push(options);
        return choose(options);
      },
    },
  });
  return {
    root,
    project,
    projectFile,
    external,
    internal,
    grants,
    id,
    calls,
    invoke: (fileId: unknown = id, currentLibrary?: unknown) =>
      handlers.get('openpe:choose-spice-model')!({}, fileId, currentLibrary),
    select: (next: typeof choose) => {
      choose = next;
    },
    authorize: (allow: boolean) => {
      authorized = allow;
    },
  };
}

test('native SPICE picker selects external files and preserves project-relative circuit identities without copying bytes', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.external);
  assert.deepEqual(await f.invoke(), { path: f.external, models: externalModels, issues: [] });
  assert.equal(f.calls[0].title, 'Choose SPICE model');
  assert.equal(f.calls[0].defaultPath, f.project);
  assert.deepEqual(f.calls[0].properties, ['openFile']);
  assert.deepEqual(f.calls[0].filters[0].extensions, ['lib', 'mod', 'cir', 'sp', 'spice']);
  assert.deepEqual(await readFile(f.external), before);
  assert.equal(await readFile(f.projectFile, 'utf8'), '{}');
  f.select(async () => ({ canceled: false, filePaths: [f.internal] }));
  assert.deepEqual(await f.invoke(), {
    path: 'circuits/LM2596-5.lib',
    models: internalModels,
    issues: [],
  });
  const unsaved = f.grants.create();
  f.select(async () => ({ canceled: false, filePaths: [f.external] }));
  assert.deepEqual(await f.invoke(unsaved), {
    path: f.external,
    models: externalModels,
    issues: [],
  });
  assert.equal(f.calls.at(-1).defaultPath, undefined);
});

test('current library paths only locate the native dialog and never authorize file inspection', async (t) => {
  const f = await fixture(t);
  f.select(async () => ({ canceled: true, filePaths: [] }));
  assert.equal(await f.invoke(), null);
  assert.equal(f.calls.at(-1).defaultPath, f.project);
  assert.equal(await f.invoke(f.id, 'circuits/LM2596-5.lib'), null);
  assert.equal(f.calls.at(-1).defaultPath, f.internal);
  assert.equal(await f.invoke(f.id, 'circuits\\LM2596-5.lib'), null);
  assert.equal(f.calls.at(-1).defaultPath, f.internal);
  assert.equal(await f.invoke(f.id, f.external), null);
  assert.equal(f.calls.at(-1).defaultPath, f.external);

  // This path does not exist: cancellation must not stat, read or resolve it
  // through the filesystem, nor change the project grant.
  const missing = path.join(f.root, 'missing', 'current.LIB');
  assert.equal(await f.invoke(f.id, missing), null);
  assert.equal(f.calls.at(-1).defaultPath, missing);
  assert.equal(f.grants.location(f.id), f.projectFile);
  f.select(async () => ({ canceled: false, filePaths: [f.external] }));
  assert.deepEqual(await f.invoke(f.id, missing), {
    path: f.external,
    models: externalModels,
    issues: [],
  });

  const unsaved = f.grants.create();
  f.select(async () => ({ canceled: true, filePaths: [] }));
  assert.equal(await f.invoke(unsaved), null);
  assert.equal(f.calls.at(-1).defaultPath, undefined);
  assert.equal(await f.invoke(unsaved, 'circuits/LM2596-5.lib'), null);
  assert.equal(f.calls.at(-1).defaultPath, undefined);
  assert.equal(await f.invoke(unsaved, f.external), null);
  assert.equal(f.calls.at(-1).defaultPath, f.external);
  assert.equal(f.grants.location(unsaved), null);
});

test('invalid current-library hints fail before opening the native dialog and remain retryable', async (t) => {
  const f = await fixture(t);
  f.select(async () => ({ canceled: true, filePaths: [] }));
  const invalid: unknown[] = [
    null,
    {},
    [],
    42,
    '',
    'circuits/model.lib\0',
    'circuits/model\r.lib',
    'circuits/model\n.lib',
    'model.exe',
    '../model.lib',
    './model.lib',
    'circuits/../model.lib',
    'circuits\\..\\model.lib',
    'circuits//model.lib',
    'circuits\\\\model.lib',
    'circuits/',
    'C:relative.lib',
    'https://vendor.example/model.lib',
    'file:///circuits/model.lib',
    '//server/share/model.lib',
    '\\\\server\\share\\model.lib',
    'm'.repeat(4097) + '.lib',
  ];
  if (process.platform === 'win32') invalid.push('\\rooted.lib', '/rooted.lib');
  for (const hint of invalid) {
    await assert.rejects(f.invoke(f.id, hint), /Invalid current SPICE model path/);
    assert.equal(f.calls.length, 0);
  }
  const unsaved = f.grants.create();
  await assert.rejects(f.invoke(unsaved, '../model.lib'), /Invalid current SPICE model path/);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.invoke(f.id, f.external), null);
  assert.equal(f.calls.length, 1);
});

test('native SPICE picker cancellation is clean and invalid file selections remain retryable', async (t) => {
  const f = await fixture(t);
  f.select(async () => ({ canceled: true, filePaths: [] }));
  assert.equal(await f.invoke(), null);
  const directory = path.join(f.root, 'directory.lib');
  await mkdir(directory);
  for (const files of [
    [],
    [f.external, f.internal],
    ['relative.lib'],
    [f.external + '.exe'],
    [directory],
    [path.join(f.root, 'missing.lib')],
    [f.external + '\0.lib'],
  ]) {
    f.select(async () => ({ canceled: false, filePaths: files }));
    await assert.rejects(f.invoke());
  }
  f.select(async () => ({ canceled: false, filePaths: [f.external] }));
  assert.deepEqual(await f.invoke(), { path: f.external, models: externalModels, issues: [] });
});

for (const assigned of [false, true]) {
  test(`external model paths survive native round trips, Save as and undo ${assigned ? 'with' : 'without'} an existing model`, async (t) => {
    const f = await fixture(t);
    const circuit = emptyCircuit();
    const part = createPart(circuit, 'R', 0, 0);
    if (assigned)
      part.fields = {
        ...partFields(part),
        'Sim.Library': 'OpenPE:lm2596-adj-derived',
        'Sim.Name': 'OPENPE_DERIVED_LM2596_ADJ_TRANS',
        'Sim.Pins': '1=1 2=2',
      };
    circuit.parts.push(part);
    const core = new ProjectCore(createProject(circuit));
    const original = core.getSnapshot().source;
    const selected = await f.invoke();
    const fields: Record<string, string> = { ...partFields(part), 'Sim.Library': selected.path };
    core.execute('part.properties', {
      schematicId: circuit.id,
      partId: part.id,
      fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
    });
    assert.equal(core.getSnapshot().undoDepth, 1);
    const reopened = projectFromNativeFiles(core.query('source.files') as KiCadProjectFiles);
    const renamed = projectFromNativeFiles(projectNativeFiles(reopened, 'saved-copy.kicad_pro'));
    for (const project of [reopened, renamed]) {
      const actual = partFields(project.schematic.parts[0]);
      assert.equal(actual['Sim.Library'], f.external);
      assert.equal(actual['Sim.Name'], fields['Sim.Name']);
      assert.equal(actual['Sim.Pins'], fields['Sim.Pins']);
      assert.equal(
        project.simulationModels,
        undefined,
        'Selecting a path creates no portable model record.',
      );
    }
    assert.equal(await readFile(f.external, 'utf8'), '.subckt vendor 1 2\n.ends vendor\n');
    core.undo();
    assert.equal(core.getSnapshot().source, original);
    const restored = core.getSnapshot().project;
    assert.ok(restored);
    assert.equal(
      partFields(restored.schematic.parts[0])['Sim.Library'],
      assigned ? 'OpenPE:lm2596-adj-derived' : undefined,
    );
  });
}

test('native SPICE picker checks the frame and grant before and after the native dialog and bounds concurrent dialogs', async (t) => {
  const f = await fixture(t);
  f.authorize(false);
  await assert.rejects(f.invoke(), /Unauthorized/);
  assert.equal(f.calls.length, 0);
  f.authorize(true);
  await assert.rejects(f.invoke(f.external), /grant/);
  assert.equal(f.calls.length, 0);
  let finish!: (result: any) => void;
  f.select(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.invoke();
  await assert.rejects(f.invoke(), /already open/);
  f.authorize(false);
  finish({ canceled: false, filePaths: [f.external] });
  await assert.rejects(pending, /Unauthorized/);
  f.authorize(true);
  const moved = f.invoke();
  f.grants.assign(f.id, path.join(f.root, 'other.kicad_pro'));
  finish({ canceled: false, filePaths: [f.external] });
  await assert.rejects(moved, /location changed/);
  const revoked = f.invoke();
  f.grants.release(f.id);
  finish({ canceled: false, filePaths: [f.external] });
  await assert.rejects(revoked, /grant/);
});

test('native SPICE picker rejects linked models and linked parent directories without changing their targets', async (t) => {
  const f = await fixture(t);
  const linkedFile = path.join(f.root, 'linked.lib');
  const linkedDirectory = path.join(f.root, 'linked-models');
  await symlink(
    path.dirname(f.external),
    linkedDirectory,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const before = await readFile(f.external);
  f.select(async () => ({
    canceled: false,
    filePaths: [path.join(linkedDirectory, path.basename(f.external))],
  }));
  await assert.rejects(f.invoke(), /without links/);
  await t.test('file symlinks', async (t) => {
    try {
      await symlink(f.external, linkedFile, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM')
        return t.skip('Creating file symlinks is unavailable.');
      throw error;
    }
    const file = linkedFile;
    f.select(async () => ({ canceled: false, filePaths: [file] }));
    await assert.rejects(f.invoke(), /without links/);
  });
  assert.deepEqual(await readFile(f.external), before);
});
