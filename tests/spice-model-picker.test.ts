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
import { externalModelBindingFields } from '../lib/simulation-model-binding';
import {
  buildSpiceDeck,
  defaultTransient,
  simulationSupportError,
} from '../plugins/spice-simulation/domain/spice';
import { homeExampleCatalog, homeExampleNativePath } from '../lib/home-examples';
import {
  simulationLibraryPath,
  simulationLibraryDeclaration,
} from '../lib/simulation-model-presentation';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  type KiCadProjectFiles,
} from '../lib/kicad-project';

const require = createRequire(import.meta.url);
const { FileGrants } = require('../electron/file-grants.cjs');
const {
  registerSpiceModelPicker,
} = require('../plugins/spice-simulation/electron/spice-model-picker.cjs');
const {
  readSpiceModelFile,
} = require('../plugins/spice-simulation/electron/spice-model-picker.cjs');
const {
  MAX_MODEL_BYTES,
  spiceModelDeclarations,
} = require('../plugins/spice-simulation/electron/spice-model-declarations.cjs');
const externalModels = [{ name: 'vendor', kind: 'subcircuit', pins: ['1', '2'] }];
const internalModels = [
  { name: 'LM2596_TRANS', kind: 'subcircuit', pins: ['1', '2', '3', '4', '5'] },
];

test('every external model in the ten actual Home schematics is declared in its mapped project library', async () => {
  const { readNativeProject } = require('../electron/native-project.cjs');
  let checked = 0;
  for (const entry of homeExampleCatalog) {
    const filename = path.resolve(homeExampleNativePath(entry.id));
    const project = projectFromNativeFiles(await readNativeProject(filename));
    for (const part of project.schematic.parts) {
      const fields = partFields(part);
      const library = fields['Sim.Library'];
      if (!library) continue;
      const file = path.resolve(path.dirname(filename), simulationLibraryPath(library));
      const catalog = await readSpiceModelFile(file);
      if (entry.file !== 'emc-flyback')
        assert.equal(
          catalog.models.length,
          1,
          `${entry.file}: auxiliary definitions must stay hidden.`,
        );
      assert.ok(
        simulationLibraryDeclaration(library, fields['Sim.Name'], catalog.models),
        `${entry.file}/${part.ref}: ${fields['Sim.Name']} must be declared in ${path.basename(file)}`,
      );
      if (entry.file === 'emc-flyback' && catalog.models.length === 1)
        assert.equal(path.basename(file, '.lib'), catalog.models[0].name);
      checked++;
    }
  }
  assert.ok(checked >= 16, 'The nine Home controllers and seven EMC bindings must be checked.');
});

test('EMC native component bindings open their actual project library and preserve the compiled pin mapping', async () => {
  const { readNativeProject } = require('../electron/native-project.cjs');
  const filename = path.resolve('examples/project/emc-flyback/emc-flyback.kicad_pro');
  const project = projectFromNativeFiles(await readNativeProject(filename));
  const assignments = {
    Q1: ['EMC_IRF520N', 'EMC_IRF520N', '2=D 1=G 3=S'],
    D2: ['EMC_ES2D', 'EMC_ES2D', '2=A 1=K'],
    D3: ['EMC_SS510C', 'EMC_SS510C', '2=A 1=K'],
    D7: ['EMC_SS510C', 'EMC_SS510C', '2=A 1=K'],
    U1: ['EMC_flyback_control', 'UC3845B', '1=1 2=2 3=3 4=4 5=5 6=6 7=7 8=8'],
    U3: ['EMC_flyback_control', 'TL431B', '1=1 3=2 2=3'],
    U4: ['EMC_flyback_control', 'LTV817', '1=1 2=2 4=3 3=4'],
  };
  const grants = new FileGrants();
  const fileId = grants.create(filename);
  let handler: (...args: any[]) => Promise<any>;
  let expectedPath = '';
  registerSpiceModelPicker({
    ipcMain: {
      handle: (_name: string, invoke: typeof handler) => {
        handler = invoke;
      },
    },
    authorize: () => {},
    grants,
    getWindow: () => ({}),
    dialog: {
      showOpenDialog: async (_window: unknown, options: { defaultPath: string }) => {
        assert.equal(options.defaultPath, expectedPath);
        return { canceled: false, filePaths: [expectedPath] };
      },
    },
  });
  const deck = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
  for (const [ref, [library, name, pins]] of Object.entries(assignments)) {
    const part = project.schematic.parts.find((part) => part.ref === ref)!;
    const fields = partFields(part);
    assert.equal(fields['Sim.Library'], `models/${library}.lib`);
    assert.equal(fields['Sim.Name'], name);
    assert.equal(fields['Sim.Pins'], pins);
    expectedPath = path.resolve(path.dirname(filename), fields['Sim.Library']);
    const result = await handler!({}, fileId, fields['Sim.Library']);
    assert.equal(result.path, fields['Sim.Library']);
    const declaration = result.models.find((model: { name: string }) => model.name === name);
    assert.ok(declaration, `${ref}: assigned declaration must be available in Choose model`);
    const binding = externalModelBindingFields(project.schematic, part, declaration);
    assert.equal(binding['Sim.Pins'], pins);
    assert.equal(binding['Sim.Device'], fields['Sim.Device']);
    part.fields = Object.fromEntries(
      Object.entries({ ...fields, ...binding }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  }
  assert.equal(simulationSupportError(project.schematic), '');
  assert.deepEqual(buildSpiceDeck(project.schematic, defaultTransient(project.schematic)), deck);
});

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

test('device entry discovery hides referenced helpers while preserving independent devices and local scope', () => {
  const source = `
.subckt AMP IN OUT
Xgain IN OUT helper PARAMS: GAIN=2
Dclamp IN OUT local
.model local D(Is=1n)
.ends AMP
.subckt HELPER A B
Q1 A B 0 core
.ends HELPER
.model core NPN(Bf=100)
.model local D(Is=2n)
.subckt OTHER A B C
R1 A B 1k
.ends OTHER
.model independent D(Is=3n)
`;
  assert.deepEqual(
    spiceModelDeclarations(Buffer.from(source)).models.map((model: { name: string }) => model.name),
    ['AMP', 'local', 'OTHER', 'independent'],
  );
  const nested =
    '.subckt main A B\nX1 A B nested\n.subckt nested A B\nD1 A B global\n.ends nested\n.ends main\n.model global D\n';
  assert.deepEqual(
    spiceModelDeclarations(Buffer.from(nested)).models.map((model: { name: string }) => model.name),
    ['main'],
  );
  const cycle = '.subckt one A B\nX1 A B two\n.ends one\n.subckt two A B\nX1 A B one\n.ends two\n';
  assert.deepEqual(spiceModelDeclarations(Buffer.from(cycle)).models, []);
});

test('reviewed LM5001 entries hide unused vendor helpers and remain independent of library filenames', async () => {
  const bytes = await readFile('examples/lm5001-soic8-boost/models/LM5001.lib');
  assert.deepEqual(
    spiceModelDeclarations(bytes).models.map((model: { name: string }) => model.name),
    ['LM5001_TRANS'],
  );
  assert.ok(
    spiceModelDeclarations(
      Buffer.from('.subckt BUF_BASIC_GEN A Y\n.ends BUF_BASIC_GEN\n'),
    ).models.some((model: { name: string }) => model.name === 'BUF_BASIC_GEN'),
    'Unreviewed standalone declarations cannot be hidden merely because their names resemble vendor helpers.',
  );
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
  await mkdir(path.join(project, 'models'), { recursive: true });
  await mkdir(vendor);
  const projectFile = path.join(project, 'design.kicad_pro');
  const external = path.join(vendor, 'vendor.lib');
  const internal = path.join(project, 'models', 'LM2596-5.lib');
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
    inspect: (library: unknown, fileId: unknown = id) =>
      handlers.get('openpe:inspect-spice-model')!({}, fileId, library),
    select: (next: typeof choose) => {
      choose = next;
    },
    authorize: (allow: boolean) => {
      authorized = allow;
    },
  };
}

test('automatic inspection lists the current project library without a picker or file writes', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.internal);
  assert.deepEqual(await f.inspect('models/LM2596-5.lib'), {
    path: 'models/LM2596-5.lib',
    models: internalModels,
    issues: [],
  });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readFile(f.internal), before);
  assert.equal(await f.inspect(f.external), null, 'Absolute references require native selection.');
  assert.equal(await f.inspect('models/LM2596-5.lib', f.grants.create()), null);
  for (const invalid of [
    '../vendor.lib',
    'circuits/../vendor.lib',
    'models/LM2596-5.txt',
    '//host/vendor.lib',
    {},
    null,
  ])
    await assert.rejects(f.inspect(invalid));
  await assert.rejects(f.inspect('models/missing.lib'), /not available/);
  await writeFile(f.internal, Buffer.alloc(MAX_MODEL_BYTES + 1, 32));
  await assert.rejects(f.inspect('models/LM2596-5.lib'), /2 MiB/);
  await writeFile(f.internal, before);
  const replaced = f.inspect('models/LM2596-5.lib');
  f.grants.assign(f.id, path.join(f.project, 'replacement.kicad_pro'));
  await assert.rejects(replaced, /location changed|observation expired/);
  f.grants.assign(f.id, f.projectFile);
  const untrusted = f.inspect('models/LM2596-5.lib');
  f.authorize(false);
  await assert.rejects(untrusted, /Unauthorized/);
  f.authorize(true);
  f.authorize(false);
  await assert.rejects(f.inspect('models/LM2596-5.lib'), /Unauthorized/);
  f.authorize(true);
  f.grants.release(f.id);
  await assert.rejects(f.inspect('models/LM2596-5.lib'), /grant/);
});

test('automatic EMC library inspection returns all three top-level controller models', async () => {
  const grants = new FileGrants();
  const fileId = grants.create(path.resolve('examples/project/emc-flyback/emc-flyback.kicad_pro'));
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSpiceModelPicker({
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) },
    authorize: () => {},
    grants,
    dialog: {
      showOpenDialog: () => {
        throw new Error('No picker should open.');
      },
    },
    getWindow: () => null,
  });
  const result = await handlers.get('openpe:inspect-spice-model')!(
    {},
    fileId,
    'models/EMC_flyback_control.lib',
  );
  assert.deepEqual(
    result.models.map((model: { name: string }) => model.name),
    ['UC3845B', 'TL431B', 'LTV817'],
  );
});

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
    path: 'models/LM2596-5.lib',
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
  assert.equal(await f.invoke(f.id, 'models/LM2596-5.lib'), null);
  assert.equal(f.calls.at(-1).defaultPath, f.internal);
  assert.equal(await f.invoke(f.id, 'models\\LM2596-5.lib'), null);
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
  assert.equal(await f.invoke(unsaved, 'models/LM2596-5.lib'), null);
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
    'models/model.lib\0',
    'models/model\r.lib',
    'models/model\n.lib',
    'model.exe',
    '../model.lib',
    './model.lib',
    'circuits/../model.lib',
    'models\\..\\model.lib',
    'circuits//model.lib',
    'models\\\\model.lib',
    'circuits/',
    'C:relative.lib',
    'https://vendor.example/model.lib',
    'file:///models/model.lib',
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
