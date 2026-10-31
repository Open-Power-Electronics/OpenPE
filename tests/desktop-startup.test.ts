import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

test('desktop Home skips example preparation while explicit opens share its checked barrier', async () => {
  const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const opened: unknown[] = [];
  const modelPreparations: unknown[][] = [];
  const exampleRoots: string[] = [];
  let preparations = 0,
    grants = 0,
    bootstrap: Promise<void> | undefined,
    release!: () => void,
    window!: TestWindow;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class TestWindow extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      setWindowOpenHandler: () => {},
    });
    constructor() {
      super();
      window = this;
    }
    async loadURL() {
      this.webContents.emit('did-finish-load');
    }
  }
  const modules: Record<string, unknown> = {
    '../server/index.mjs': { startServer: async () => ({ base: 'http://127.0.0.1:12345' }) },
    '../server/atomic-write.mjs': {},
    '../server/project-model-files.mjs': {
      prepareProjectModelFiles: async (...args: unknown[]) => {
        modelPreparations.push(args);
      },
    },
    '../server/example-models.mjs': { createSimulationModelStore: () => async () => {} },
    '../server/project-spice-files.mjs': {},
    '../server/project-thermal-files.mjs': {},
    '../server/project-history.mjs': { ProjectHistory: class {} },
    '../server/example-projects.mjs': {
      ExampleProjects: class {
        constructor(...args: unknown[]) {
          exampleRoots.push(args[0] as string);
        }
        async prepare() {
          preparations++;
          await gate;
          return ['An unrelated example model is unavailable.'];
        }
        async openDefault(key: unknown) {
          opened.push(key);
          return { key };
        }
      },
    },
    '../server/example-footprints.mjs': { prepareExampleFootprints: async () => {} },
    '../server/project-format.mjs': {},
    '../server/enclosure-step.mjs': {},
    '../server/manufacturing-format.mjs': {},
  };
  const required: Record<string, unknown> = {
    electron: {
      app: {
        getPath: () => path.resolve('isolated-test-data'),
        setPath: () => {},
        setName: () => {},
        whenReady: () => ({
          then: (callback: () => Promise<void>) => (bootstrap = callback()),
        }),
        on: () => {},
      },
      BrowserWindow: TestWindow,
      ipcMain: {
        handle: (name: string, handler: (...args: unknown[]) => unknown) =>
          handlers.set(name, handler),
      },
      Menu: { setApplicationMenu: () => {} },
    },
    'node:path': path,
    'node:fs/promises': {},
    './file-grants.cjs': {
      FileGrants: class {
        create() {
          return `grant-${++grants}`;
        }
      },
    },
    './native-save.cjs': { createNativeSave: () => {} },
    './native-export.cjs': { createNativeExport: () => {} },
    './image-export.cjs': { createImageExport: () => {} },
    './enclosure-export.cjs': { createEnclosureExport: () => {} },
    './native-project.cjs': {},
    './workspace-recovery.cjs': { registerWorkspaceRecovery: () => {} },
    './project-directory.cjs': { registerProjectDirectory: () => ({}) },
    './spice-model-picker.cjs': { registerSpiceModelPicker: () => {} },
  };
  // Redirect the bootstrap's module loading to isolated host adapters. Execute
  // its real window events and IPC handlers without Electron, disk or network I/O.
  new vm.Script(source.replaceAll('import(', 'loadModule('), {
    filename: 'electron/main.cjs',
  }).runInNewContext({
    process: { platform: 'win32', env: {} },
    AbortController,
    __dirname: path.resolve('electron'),
    require: (specifier: string) => {
      assert.ok(Object.hasOwn(required, specifier), `Unexpected native module: ${specifier}`);
      return required[specifier];
    },
    loadModule: async (specifier: string) => {
      assert.ok(Object.hasOwn(modules, specifier), `Unexpected service module: ${specifier}`);
      return modules[specifier];
    },
  });
  await bootstrap;
  assert.equal(modelPreparations.length, 0, 'Home does not read prepared model resources.');
  assert.deepEqual(exampleRoots, [path.resolve('examples')]);
  assert.equal(preparations, 0, 'Loading Home does not prepare or check example assets.');
  assert.equal(handlers.has('openpe:example-preparation'), false);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.equal(await handlers.get('openpe:new')!(event), 'grant-1');
  assert.equal(preparations, 0, 'Creating an ordinary project does not check example assets.');

  const open = handlers.get('openpe:open-default-example')!;
  const first = open(event, 'first') as Promise<unknown>;
  const second = open(event, 'second') as Promise<unknown>;
  assert.equal(preparations, 1);
  assert.deepEqual(opened, [], 'No selected example opens before the preparation barrier.');
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ key: 'first' }, { key: 'second' }]);
  assert.deepEqual(opened, ['first', 'second']);
  assert.deepEqual(await open(event, 'third'), { key: 'third' });
  assert.equal(preparations, 1, 'Later opens reuse the completed shared preparation.');
  assert.equal(modelPreparations.length, 0, 'Opening original examples never rewrites sidecars.');
});
