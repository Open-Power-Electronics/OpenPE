import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as projectFormat from '../server/project-format.mjs';
import { atomicWrite } from '../server/atomic-write.mjs';
import { createBlankProject } from '../lib/create-blank-project';
import { projectNativeFiles } from '../lib/project';
import homeManifest from '../resources/example-catalog/home-manifest.json';

const require = createRequire(import.meta.url);

test('desktop Recent uses accepted native files, reactivates grants and rejects missing/foreign inputs', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-desktop-recent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projectDir = path.join(dir, 'design');
  await mkdir(projectDir);
  const bundle = projectNativeFiles(createBlankProject(), 'design.kicad_pro');
  for (const file of bundle.files) await writeFile(path.join(projectDir, file.name), file.source);
  const nativePath = path.join(projectDir, bundle.entry);
  const handlers = new Map<string, (...args: any[]) => any>();
  let bootstrap: Promise<void> | undefined;
  let window!: TestWindow;
  let canceled = false;
  let saved: { name: string; path: string } | null = null;
  let selected = nativePath;
  let pauseRecentWrite: (() => Promise<void>) | undefined;
  class TestWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      setWindowOpenHandler() {},
      send() {},
    });
    constructor() {
      super();
      window = this;
    }
    async loadURL() {}
    isDestroyed() {
      return false;
    }
  }
  const required: Record<string, unknown> = {
    electron: {
      app: {
        getPath: () => dir,
        setPath() {},
        setName() {},
        on() {},
        whenReady: () => ({ then: (callback: () => Promise<void>) => (bootstrap = callback()) }),
      },
      BrowserWindow: TestWindow,
      ipcMain: {
        handle: (id: string, handler: (...args: any[]) => any) => handlers.set(id, handler),
      },
      dialog: { showOpenDialog: async () => ({ canceled, filePaths: [selected] }) },
      Menu: { setApplicationMenu() {} },
    },
    'node:path': path,
    'node:fs/promises': {},
    '../resources/example-catalog/home-manifest.json': homeManifest,
    './file-grants.cjs': require('../electron/file-grants.cjs'),
    './recent-projects.cjs': require('../electron/recent-projects.cjs'),
    './native-project.cjs': require('../electron/native-project.cjs'),
    './native-save.cjs': { createNativeSave: () => async () => saved },
    './native-export.cjs': { createNativeExport() {} },
    './image-export.cjs': { createImageExport() {} },
    './enclosure-export.cjs': { createEnclosureExport() {} },
    './workspace-recovery.cjs': { registerWorkspaceRecovery() {} },
    './project-directory.cjs': { registerProjectDirectory: () => ({ clear() {}, release() {} }) },
    './component-model-picker.cjs': { registerComponentModelPicker() {} },
    './spice-model-picker.cjs': { registerSpiceModelPicker() {} },
  };
  const modules: Record<string, unknown> = {
    '../server/index.mjs': { startServer: async () => ({ base: 'http://127.0.0.1:12345' }) },
    '../server/atomic-write.mjs': {
      atomicWrite: async (...args: Parameters<typeof atomicWrite>) => {
        await pauseRecentWrite?.();
        return atomicWrite(...args);
      },
    },
    '../server/project-format.mjs': projectFormat,
    '../server/example-models.mjs': { createSimulationModelStore() {} },
    '../server/project-history.mjs': { ProjectHistory: class {} },
    '../server/example-projects.mjs': { ExampleProjects: class {} },
  };
  new vm.Script(
    readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8').replaceAll(
      'import(',
      'loadModule(',
    ),
  ).runInNewContext({
    process: { platform: 'win32', env: {} },
    AbortController,
    Buffer,
    __dirname: path.resolve('electron'),
    require: (id: string) => {
      assert.ok(Object.hasOwn(required, id), id);
      return required[id];
    },
    loadModule: async (id: string) => modules[id] ?? {},
  });
  await bootstrap;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const call = (id: string, ...args: unknown[]) => handlers.get(`openpe:${id}`)!(event, ...args);
  assert.equal((await call('list-recent')).entries.length, 0);
  canceled = true;
  assert.equal(await call('open'), null);
  assert.equal((await call('list-recent')).entries.length, 0);
  canceled = false;
  selected = path.join(projectDir, 'design.kicad_sch');
  const staged = await call('open');
  assert.equal(staged.name, bundle.entry, 'A sibling schematic resolves to the native project.');
  assert.equal((await call('list-recent')).entries.length, 0, 'Staging is not acceptance.');
  const replacement = await call('open');
  await assert.rejects(call('accept-open', staged.openId), /request changed/);
  assert.equal((await call('list-recent')).entries.length, 0);
  const grant = await call('accept-open', replacement.openId);
  const [entry] = (await call('list-recent')).entries;
  assert.equal(entry.description, nativePath);
  const beforePreview = await call('list-recent');
  const preview = await call('preview-recent', entry.id);
  assert.equal(preview.title, createBlankProject().schematic.title);
  assert.deepEqual(
    await call('list-recent'),
    beforePreview,
    'Thumbnail reads never reorder history.',
  );
  assert.equal((await call('open-recent', entry.id)).fileId, grant);
  assert.equal((await call('list-recent')).entries.length, 1);
  await assert.rejects(call('open-recent', nativePath), /Unknown recent/);
  await assert.rejects(
    handlers.get('openpe:list-recent')!({ ...event, senderFrame: {} }),
    /Unauthorized/,
  );
  let writeStarted!: () => void;
  let resumeWrite!: () => void;
  const started = new Promise<void>((resolve) => (writeStarted = resolve));
  const paused = new Promise<void>((resolve) => (resumeWrite = resolve));
  pauseRecentWrite = async () => {
    writeStarted();
    await paused;
  };
  const reopening = call('open-recent', entry.id);
  await started;
  await call('release-file', grant);
  pauseRecentWrite = undefined;
  resumeWrite();
  const racedOpen = await reopening;
  assert.ok(racedOpen, 'Closing during the Recent write must reopen native files.');
  assert.equal(racedOpen.name, bundle.entry);
  const racedGrant = await call('accept-open', racedOpen.openId);
  assert.notEqual(racedGrant, grant);
  assert.equal(
    (await call('open-recent', entry.id)).fileId,
    racedGrant,
    'An existing editor activates without rereading or replacing its state.',
  );
  await call('release-file', racedGrant);
  const recentOpen = await call('open-recent', entry.id);
  assert.equal(recentOpen.name, bundle.entry);
  const reopened = await call('accept-open', recentOpen.openId);
  assert.notEqual(reopened, grant);
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await unlink(nativePath);
  await assert.rejects(call('open-recent', entry.id), /missing|ENOENT/i);
  assert.equal(
    (await call('list-recent')).entries[0].id,
    entry.id,
    'Failed opens retain the record.',
  );
  await assert.rejects(call('accept-open'), /No validated file/);
  assert.equal(await call('save', {}), null);
  assert.equal((await call('list-recent')).entries.length, 1);
  saved = { name: 'copy.kicad_pro', path: path.join(dir, 'copy.kicad_pro') };
  await call('save', {});
  assert.equal((await call('list-recent')).entries[0].description, saved.path);
  await call('remove-recent', entry.id);
  await assert.rejects(call('open-recent', entry.id), /no longer listed/);
  await assert.rejects(call('preview-recent', entry.id), /no longer listed/);
});
