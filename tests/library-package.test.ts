import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { createBlankProject } from '../lib/create-blank-project';
import { createPart } from '../lib/circuit';
import { registerLibraryCapabilities } from '../lib/library-capabilities';
import { loadLibraryFootprint } from '../lib/library-package';
import { parseSExpr } from '../lib/sexpr';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { attachOnlineFootprint } from '../lib/library-project-assets';
import { PCBProjectSync } from '../lib/pcb-project-sync';
import { appendSchematic, parseProject, serializeProject } from '../lib/project';
import { createComponentModelStore, prepareLibraryPackage } from '../server/component-models.mjs';
import { atomicWrite } from '../server/atomic-write.mjs';

const require = createRequire(import.meta.url);
const { createNativeSave } = require('../electron/native-save.cjs');
const { FileGrants } = require('../electron/file-grants.cjs');
const { readNativeProject } = require('../electron/native-project.cjs');

const prepared = {
  id: 'NextPCB:123_fixture',
  projectAssets: true,
  footprint: parseSExpr(`(footprint "123_fixture" (layer "F.Cu")
    (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask"))
    (pad "2" thru_hole circle (at 2.54 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask"))
    (model "\u0024{KIPRJMOD}/models/${'a'.repeat(64)}.step"
      (offset (xyz 1 2 3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90))))`),
};

function fixture() {
  const project = createBlankProject();
  project.schematic.parts.push(createPart(project.schematic, 'R', 0, 0));
  return project;
}

test('committed package transport is distinct from read-only catalog detail', async () => {
  const previousWindow = (globalThis as any).window,
    previousFetch = globalThis.fetch;
  const requests: { url: string; options: RequestInit }[] = [];
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://fixture', token: 'test' }) },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options: options! });
    return Response.json(
      requests.length === 1 ? prepared : { id: 'KiCad:Fixture', footprint: prepared.footprint },
    );
  };
  try {
    const signal = new AbortController().signal;
    await loadLibraryFootprint(prepared.id, signal);
    await loadLibraryFootprint('KiCad:Fixture', signal);
    assert.equal(requests[0].url, 'http://fixture/api/library-package');
    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].options.body as string), { id: prepared.id });
    assert.equal(requests[0].options.signal, signal);
    assert.equal(requests[1].url, 'http://fixture/api/libraries/footprints?id=KiCad%3AFixture');
  } finally {
    globalThis.fetch = previousFetch;
    (globalThis as any).window = previousWindow;
  }
});

test('Agent package placement retains resources, assignment and pose in one undo', async () => {
  const core = new ProjectCore(fixture()),
    baseline = core.getNativeFiles();
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const previousWindow = (globalThis as any).window,
    previousFetch = globalThis.fetch;
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://fixture', token: 'test' }) },
  };
  globalThis.fetch = async () => Response.json(prepared);
  const dispose = registerLibraryCapabilities(host, core);
  try {
    const project = core.getSnapshot().project!;
    await host.execute(
      'layout.place',
      {
        boardId: project.pcb!.id,
        partId: project.schematic.parts[0].id,
        libraryId: prepared.id,
        position: { x: 10, y: 10 },
      },
      { actor: 'agent' },
    );
    const current = core.getSnapshot();
    assert.equal(current.undoDepth, 1);
    assert.equal(current.project!.schematic.parts[0].fields?.Footprint, prepared.id);
    const model = current.project!.pcb!.footprints[0].models![0];
    assert.equal(model.path, '${KIPRJMOD}/models/' + 'a'.repeat(64) + '.step');
    assert.deepEqual(model.offset, { x: 1, y: 2, z: 3 });
    assert.equal(model.rotation.z, 90);
    assert.ok(core.getNativeFiles().files.some((file) => file.name === 'fp-lib-table'));
    assert.ok(
      core
        .getNativeFiles()
        .files.some((file) => file.name === 'footprints/NextPCB.pretty/123_fixture.kicad_mod'),
    );
    core.undo();
    assert.deepEqual(core.getNativeFiles(), baseline);
  } finally {
    dispose();
    host.dispose();
    globalThis.fetch = previousFetch;
    (globalThis as any).window = previousWindow;
  }
});

test('online symbol placement adopts packages on additional sheets and reuses them offline', async () => {
  const { project, schematic: sheet } = appendSchematic(fixture());
  const core = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const previousWindow = (globalThis as any).window;
  const previousFetch = globalThis.fetch;
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://fixture', token: 'test' }) },
  };
  const dispose = registerLibraryCapabilities(host, core);
  const baseline = core.getNativeFiles();
  try {
    for (const id of [prepared.id, 'JLCPCB:C7593']) {
      const [library, name] = id.split(':');
      const symbol = parseSExpr(`(symbol "${id}" (property "Reference" "U")
        (property "Value" "Fixture") (property "Footprint" "${id}"))`);
      const footprint = structuredClone(prepared.footprint);
      footprint[1] = JSON.stringify(name);
      let downloads = 0;
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/library-package')) {
          downloads++;
          return Response.json({ ...prepared, id, footprint });
        }
        assert.equal(new URL(String(url)).searchParams.get('id'), id);
        return Response.json({ id, symbol, units: 1, footprint: id });
      };
      const input = { schematicId: sheet.id, libraryId: id, x: 0, y: 0 };
      await host.execute('schematic.place', input, { actor: 'agent' });
      const current = core.getSnapshot();
      assert.equal(current.undoDepth, 1);
      assert.equal(current.project!.additionalSchematics![0].parts[0].fields?.Footprint, id);
      assert.equal(current.project!.pcb!.footprints.length, 0);
      assert.ok(core.getNativeFiles().files.some((file) => file.name === `footprints/${library}.pretty/${name}.kicad_mod`));
      await host.execute('schematic.place', { ...input, x: 6.35 }, { actor: 'agent' });
      assert.equal(core.getSnapshot().project!.additionalSchematics![0].parts.length, 2);
      assert.equal(downloads, 1);
      core.undo();
      core.undo();
      assert.deepEqual(core.getNativeFiles(), baseline);
    }
  } finally {
    dispose();
    host.dispose();
    globalThis.fetch = previousFetch;
    (globalThis as any).window = previousWindow;
  }
});

test('invalid prepared native files reject the complete Core edit', () => {
  const core = new ProjectCore(fixture()),
    before = core.getSnapshot();
  const files = core.getNativeFiles();
  assert.throws(() =>
    core.replaceBoard(
      { ...before.project!.pcb! },
      { ...files, files: [...files.files, { name: '../invalid', source: '' }] },
    ),
  );
  assert.equal(core.getSnapshot(), before);
});

test('assignment staging joins the Core edit and restores its cache after rejection', async () => {
  const sync = new PCBProjectSync();
  const core = new ProjectCore(fixture(), {
    prepare: (next) => sync.prepare(next)?.project ?? next,
  });
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const previousWindow = (globalThis as any).window,
    previousFetch = globalThis.fetch;
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://fixture', token: 'test' }) },
  };
  let hold: Promise<void> | undefined, loaded: (() => void) | undefined;
  globalThis.fetch = async () => {
    loaded?.();
    await hold;
    return Response.json(prepared);
  };
  const dispose = registerLibraryCapabilities(host, core, {
    stageFootprint(source) {
      const previous = sync.sources.get(source.id);
      sync.sources.set(source.id, source);
      return () => {
        if (previous) sync.sources.set(source.id, previous);
        else sync.sources.delete(source.id);
      };
    },
  });
  try {
    const before = core.getNativeFiles(),
      part = core.getSnapshot().project!.schematic.parts[0];
    const args = {
      schematicId: core.getSnapshot().project!.schematic.id,
      partId: part.id,
      libraryId: prepared.id,
    };
    await host.execute('part.footprint', args, { actor: 'agent' });
    assert.equal(core.getSnapshot().undoDepth, 1);
    assert.equal(core.getSnapshot().project!.pcb!.footprints.length, 1);
    assert.ok(
      core
        .getNativeFiles()
        .files.some((file) => file.name === 'footprints/NextPCB.pretty/123_fixture.kicad_mod'),
    );
    core.undo();
    assert.deepEqual(core.getNativeFiles(), before);
    const retained = sync.sources.get(prepared.id);
    let release!: () => void;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const pending = host.execute('part.footprint', args, { actor: 'agent' });
    await started;
    core.setEditingBlocked('Closing');
    release();
    await assert.rejects(pending, /Closing/);
    assert.equal(sync.sources.get(prepared.id), retained);
    assert.equal(core.getSnapshot().undoDepth, 0);
  } finally {
    dispose();
    host.dispose();
    globalThis.fetch = previousFetch;
    (globalThis as any).window = previousWindow;
  }
});

async function directory(t: TestContext) {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  assert.equal(path.relative(parent, await realpath(parent)), '');
  const root = await mkdtemp(path.join(parent, 'library-package-'));
  t.after(async () => {
    assert.equal(path.relative(root, await realpath(root)), '');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('adopted package files and STEP survive native Save, Source reopening and offline Save as', async (t) => {
  const root = await directory(t);
  const bytes = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const localPath = '${KIPRJMOD}/models/' + hash + '.step';
  const detail = { ...prepared, models: [] as { path: string }[], pads: ['1', '2'] };
  detail.footprint = parseSExpr(`(footprint "123_fixture" (version 20240108) (layer "F.Cu")
    (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask"))
    (pad "2" thru_hole circle (at 2.54 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask"))
    (model "\u0024{KICAD10_3DMODEL_DIR}/Package_Test.3dshapes/Fixture.step"
      (offset (xyz 1 2 3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90))))`);
  detail.models = [{ path: '${KICAD10_3DMODEL_DIR}/Package_Test.3dshapes/Fixture.step' }];
  let imports = 0;
  const store = createComponentModelStore(path.join(root, 'private'), async (input: Buffer) => {
    assert.deepEqual(input, bytes);
    imports++;
    return { meshes: [] };
  });
  const source = await prepareLibraryPackage(
    {
      request: async () => structuredClone(detail),
      componentModelBytes: async () => bytes,
    },
    store,
    detail.id,
    new AbortController().signal,
  );
  const initial = fixture();
  const sync = new PCBProjectSync(initial);
  const core = new ProjectCore(initial, { prepare: (next) => sync.prepare(next)?.project ?? next });
  sync.sources.set(source.id, source);
  const candidate = { ...initial, schematic: { ...initial.schematic } };
  candidate.schematic.parts = candidate.schematic.parts.map((part) => ({ fields: {}, ...part }));
  candidate.schematic.parts[0].fields = {
    ...candidate.schematic.parts[0].fields,
    Footprint: source.id,
  };
  core.commitProject(candidate);
  assert.equal(core.getSnapshot().undoDepth, 1);
  assert.equal(
    attachOnlineFootprint(core.getSnapshot().project!, source),
    core.getSnapshot().project,
  );
  const packageName = 'footprints/NextPCB.pretty/123_fixture.kicad_mod';
  const fileGrants = new FileGrants();
  const fileId = fileGrants.create();
  const target = path.join(root, 'project', 'design.kicad_pro');
  await mkdir(path.dirname(target));
  const save = createNativeSave({
    parseProject,
    projectNativeFiles,
    fileGrants,
    showSaveDialog: async () => ({ canceled: false, filePath: target }),
    prepareProjectFiles: store.prepare,
    atomicWrite,
  });
  await save({ source: core.getSnapshot().source, fileId });
  const reopened = projectFromNativeFiles(await readNativeProject(target));
  const reopenedCore = new ProjectCore(reopened);
  assert.equal(reopened.pcb!.footprints[0].models![0].path, localPath);
  assert.deepEqual(reopened.pcb!.footprints[0].models![0].offset, { x: 1, y: 2, z: 3 });
  assert.deepEqual(await store.read(localPath, target), bytes);
  assert.equal(imports, 1);
  const packageText = await readFile(path.join(path.dirname(target), packageName), 'utf8');
  const table = await readFile(path.join(path.dirname(target), 'fp-lib-table'), 'utf8');
  assert.match(table, /\$\{KIPRJMOD\}\/footprints\/NextPCB.pretty/);
  assert.match(packageText, new RegExp(hash));
  assert.doesNotMatch(packageText, /KICAD10_3DMODEL_DIR/);
  assert.equal(
    reopenedCore.getNativeFiles().files.find((f) => f.name === packageName)?.source,
    packageText,
  );
  const freshStore = createComponentModelStore(path.join(root, 'empty-private'), async () =>
    assert.fail('Offline Save as does not parse or download.'),
  );
  const copy = path.join(root, 'copy', 'copied.kicad_pro');
  await mkdir(path.dirname(copy));
  const saveCopy = createNativeSave({
    parseProject,
    projectNativeFiles,
    fileGrants,
    showSaveDialog: async () => ({ canceled: false, filePath: copy }),
    prepareProjectFiles: freshStore.prepare,
    atomicWrite,
  });
  await saveCopy({ source: serializeProject(reopened), fileId, saveAs: true });
  assert.deepEqual(await freshStore.read(localPath, copy), bytes);
  assert.equal(await readFile(path.join(path.dirname(copy), packageName), 'utf8'), packageText);
  assert.equal(await readFile(path.join(path.dirname(copy), 'fp-lib-table'), 'utf8'), table);
  const copied = projectFromNativeFiles(await readNativeProject(copy));
  assert.deepEqual(copied.pcb!.footprints[0].models, reopened.pcb!.footprints[0].models);
  const schematicOnly = attachOnlineFootprint(fixture(), source);
  const unlinkedTarget = path.join(root, 'unlinked', 'design.kicad_pro');
  await mkdir(path.dirname(unlinkedTarget));
  await store.prepare(schematicOnly, unlinkedTarget);
  assert.deepEqual(await freshStore.read(localPath, unlinkedTarget), bytes);
  core.undo();
  assert.equal(core.getSnapshot().project!.pcb!.footprints.length, 0);
});
