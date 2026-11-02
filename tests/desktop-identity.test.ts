import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const mainSource = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const directorySource = readFileSync(
  new URL('../electron/project-directory.cjs', import.meta.url),
  'utf8',
);
const spicePickerSource = readFileSync(
  new URL('../electron/spice-model-picker.cjs', import.meta.url),
  'utf8',
);

test('desktop preload forwards every operation to a registered main channel and releases close listeners', async () => {
  const mainChannels = new Set(
    [
      ...[
        mainSource,
        directorySource,
        spicePickerSource,
        readFileSync(new URL('../electron/component-model-picker.cjs', import.meta.url), 'utf8'),
      ]
        .join('\n')
        .matchAll(/ipcMain\.handle\(\s*'([^']+)'/g),
    ].map((match) => match[1]),
  );
  const closeChannels = [...mainSource.matchAll(/win\.webContents\.send\(\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  const events = new EventEmitter();
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const exposed = new Map<string, Record<string, unknown>>();
  const response = { status: 'accepted' };
  const reply = Promise.resolve(response);
  new vm.Script(preloadSource, { filename: 'electron/preload.cjs' }).runInNewContext({
    process: { platform: 'win32' },
    require: (specifier: string) => {
      assert.equal(specifier, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (name: string, api: Record<string, unknown>) => exposed.set(name, api),
        },
        ipcRenderer: {
          invoke: (channel: string, ...args: unknown[]) => {
            assert.ok(mainChannels.has(channel), `No main handler for ${channel}`);
            calls.push({ channel, args });
            return reply;
          },
          on: (channel: string, listener: (...args: unknown[]) => void) =>
            events.on(channel, listener),
          removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
            events.removeListener(channel, listener),
        },
      };
    },
  });
  assert.deepEqual([...exposed.keys()], ['openpe']);
  const bridge = exposed.get('openpe')!;
  assert.equal(bridge.titleBarOverlay, true);

  const options = { fileId: 'opaque-project-id', source: 'validated native source' };
  const operations: Array<[string, string, unknown[]]> = [
    ['connection', 'connection', []],
    ['chooseComponentModel', 'choose-component-model', ['opaque-project-id']],
    ['open', 'open', []],
    ['acceptOpen', 'accept-open', []],
    ['newFile', 'new', []],
    ['openDefaultExample', 'open-default-example', ['example-id']],
    ['listExamples', 'list-examples', []],
    ['releaseFile', 'release-file', ['opaque-project-id']],
    ['revealFile', 'reveal-file', ['opaque-project-id']],
    ['projectDirectory', 'project-directory', ['opaque-project-id']],
    ['chooseSpiceModel', 'choose-spice-model', ['opaque-project-id', 'circuits/controller.lib']],
    ['inspectSpiceModel', 'inspect-spice-model', ['opaque-project-id', 'circuits/controller.lib']],
    [
      'projectFilePreview',
      'project-file-preview',
      [{ fileId: 'opaque-project-id', id: 'opaque-file-id' }],
    ],
    [
      'projectFileWrite',
      'project-file-write',
      [
        {
          fileId: 'opaque-project-id',
          id: 'opaque-file-id',
          source: 'edited text',
          expectedSource: 'original text',
        },
      ],
    ],
    ['projectFilePdf', 'project-file-pdf', [{ fileId: 'opaque-project-id', id: 'opaque-file-id' }]],
    ['setDirty', 'dirty', [true]],
    ['resolveClose', 'resolve-close', [false]],
    ['save', 'save', [options]],
    ['historyList', 'history-list', [options]],
    ['historyRead', 'history-read', [options]],
    ['historyCreate', 'history-create', [options]],
    ['exportProject', 'export', [options]],
    ['exportImage', 'export-image', [options]],
    ['exportEnclosure', 'export-enclosure', [options]],
  ];
  for (const [method, channel, args] of operations) {
    assert.equal(typeof bridge[method], 'function');
    const result = (bridge[method] as (...args: unknown[]) => unknown)(...args);
    assert.equal(result, reply, `${method} must retain the IPC result`);
    assert.equal(await result, response);
    const call = calls.at(-1)!;
    assert.equal(call.channel, `openpe:${channel}`);
    assert.equal(call.args.length, args.length);
    for (const [index, arg] of args.entries()) assert.equal(call.args[index], arg);
  }
  assert.deepEqual(new Set(calls.map((call) => call.channel)), mainChannels);

  assert.deepEqual(closeChannels, ['openpe:close-requested']);
  let firstCalls = 0;
  let secondCalls = 0;
  const subscribe = bridge.onCloseRequested as (
    callback: (...args: unknown[]) => void,
  ) => () => void;
  const unsubscribeFirst = subscribe((...args) => {
    assert.equal(args.length, 0, 'Electron event objects must stay inside preload');
    firstCalls++;
  });
  const unsubscribeSecond = subscribe(() => secondCalls++);
  const closeChannel = closeChannels[0];
  events.emit(closeChannel, { sender: 'privileged main process' });
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  unsubscribeFirst();
  events.emit(closeChannel, {});
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 2);
  unsubscribeSecond();
  assert.equal(events.listenerCount(closeChannel), 0);
});

test('desktop bootstrap sets its OpenPE data directory before applying the application name and loading services', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.build.appId, 'ai.openpe.desktop');
  for (const override of [undefined, path.join('isolated-test-data', 'desktop')]) {
    const appData = path.resolve('isolated-test-data', 'app-data');
    const actions: Array<[string, string]> = [];
    new vm.Script(mainSource.replaceAll('import(', 'loadModule('), {
      filename: 'electron/main.cjs',
    }).runInNewContext({
      process: { platform: 'win32', env: { OPENPE_DATA_DIR: override } },
      loadModule: async (specifier: string) => {
        actions.push(['module', specifier]);
        return {};
      },
      require: (specifier: string) => {
        if (specifier === 'electron')
          return {
            app: {
              getPath: (name: string) => {
                assert.equal(name, 'appData');
                return appData;
              },
              setPath: (name: string, value: string) => {
                assert.equal(name, 'userData');
                actions.push(['data', value]);
              },
              setName: (name: string) => actions.push(['name', name]),
              // Keep readiness pending: this check creates no native window or service.
              whenReady: () => ({ then: () => {} }),
              on: () => {},
            },
          };
        if (specifier === 'node:path') return path;
        if (specifier === 'node:fs/promises') return {};
        if (specifier === './file-grants.cjs') return { FileGrants: class {} };
        assert.ok(
          [
            './native-save.cjs',
            './native-export.cjs',
            './image-export.cjs',
            './enclosure-export.cjs',
            './native-project.cjs',
            './workspace-recovery.cjs',
            './project-directory.cjs',
            './spice-model-picker.cjs',
            './component-model-picker.cjs',
          ].includes(specifier),
          `Unexpected bootstrap dependency: ${specifier}`,
        );
        return {};
      },
    });
    assert.deepEqual(actions.slice(0, 2), [
      ['data', override ?? path.join(appData, 'OpenPE')],
      ['name', packageJson.build.productName],
    ]);
    const services = actions.slice(2);
    assert.ok(services.length > 0, 'Service modules load before Electron readiness.');
    for (const [kind, specifier] of services) {
      assert.equal(kind, 'module');
      assert.match(specifier, /^\.\.\/server\/[\w-]+\.mjs$/);
    }
    assert.equal(packageJson.build.productName, 'OpenPE');
  }
});
