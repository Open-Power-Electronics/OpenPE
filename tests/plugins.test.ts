import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { readPluginMetadata } from '../server/plugin-metadata.mjs';
import os from 'node:os';
import path from 'node:path';
import {
  createPluginService,
  normalizePlugins,
  runPluginCommand,
  validPluginId,
} from '../server/plugins.mjs';
import { startServer } from '../server/index.mjs';
import { setCodexPluginEnabled } from '../server/plugin-toggle.mjs';
import { waitForProcessStopped } from '../scripts/process-test-helpers.mjs';

const installed = {
  pluginId: 'docs@official',
  installed: true,
  enabled: true,
  version: '1.0',
  installPolicy: 'AVAILABLE',
};
const available = {
  pluginId: 'design@official',
  description: 'Design tools',
  installPolicy: 'AVAILABLE',
};
const fixture = path.resolve('tests/fixtures/plugin-cli.mjs');
const signal = () => new AbortController().signal;

test('marketplace display metadata stays within its package and never exposes executable configuration', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-plugin-metadata-'));
  const root = path.join(dir, 'plugin');
  await mkdir(path.join(root, '.codex-plugin'), { recursive: true });
  await writeFile(path.join(dir, 'outside.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const manifest = {
    name: 'demo',
    description: 'Package description',
    mcpServers: { token: 'private' },
    interface: {
      displayName: 'Demo tools',
      shortDescription: 'Helpful tools',
      category: 'Developer Tools',
      logo: './../outside.svg',
    },
  };
  const file = path.join(root, '.codex-plugin', 'plugin.json');
  await writeFile(file, JSON.stringify(manifest));
  const info = await readPluginMetadata(root);
  assert.equal(info.displayName, 'Demo tools');
  assert.equal(info.category, 'Developer Tools');
  assert.equal(info.icon, undefined);
  assert.ok(!JSON.stringify(info).includes('private'));
  manifest.interface.logo = './logo.svg';
  await writeFile(file, JSON.stringify(manifest));
  await writeFile(
    path.join(root, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>',
  );
  assert.match((await readPluginMetadata(root)).icon || '', /^data:image\/svg\+xml;base64,/);
  await writeFile(
    path.join(root, 'logo.svg'),
    '<svg><image href="https://example.com/tracker"/></svg>',
  );
  assert.equal((await readPluginMetadata(root)).icon, undefined);
  await writeFile(file, 'x'.repeat(128_001));
  assert.deepEqual(await readPluginMetadata(root), {});
});

test('configured Codex marketplaces load independently of the online directory and retain partial failures', async () => {
  const calls: string[][] = [];
  const service = createPluginService('.', {
    run: async (_provider: string, args: string[]) => {
      calls.push(args);
      if (args[0] === '--help')
        return { stdout: '  list  List\n  marketplace  Sources\n  add  Install', stderr: '' };
      if (args[0] === 'marketplace')
        return {
          stdout: JSON.stringify({ marketplaces: [{ name: 'official' }, { name: 'offline' }] }),
          stderr: '',
        };
      if (args.includes('offline')) throw new Error('Source unavailable');
      return {
        stdout: JSON.stringify({ installed: [installed], available: [available] }),
        stderr: '',
      };
    },
  });
  const configured = await service.list('codex', signal());
  assert.equal(configured.controlsVersion, 1);
  assert.ok(configured.actions.includes('enable'));
  assert.ok(configured.actions.includes('disable'));
  assert.equal(configured.plugins.length, 1);
  assert.equal(configured.plugins[0].origin, 'agent');
  assert.match(configured.warning, /offline: Source unavailable/);
  assert.ok(!calls.some((args) => args.includes('--available')));
});

test('provider mutations refresh scope and policy instead of trusting a stale installed list', async () => {
  let managed = false;
  let installedNow = true;
  const commands: string[][] = [];
  const service = createPluginService('.', {
    run: async (_provider: string, args: string[]) => {
      commands.push(args);
      if (args[0] === '--help')
        return { stdout: '  list  List\n  add  Install\n  remove  Remove', stderr: '' };
      if (args[0] === 'list')
        return {
          stdout: JSON.stringify({
            installed: installedNow
              ? [{ ...installed, installPolicy: managed ? 'FORCE_INSTALLED' : 'AVAILABLE' }]
              : [],
          }),
          stderr: '',
        };
      throw new Error('Stale uninstall must not invoke a provider mutation');
    },
  });
  await service.list('codex', signal());
  managed = true;
  await assert.rejects(
    service.change('codex', 'uninstall', installed.pluginId, signal()),
    /provider or organization/,
  );
  await assert.rejects(
    service.change('codex', 'install', installed.pluginId, signal()),
    /provider or organization/,
  );
  installedNow = false;
  await assert.rejects(
    service.change('codex', 'uninstall', installed.pluginId, signal()),
    /Refresh the installed plugin list/,
  );
  assert.equal(commands.filter((args) => args[0] === 'list').length, 4);
  assert.equal(
    commands.some((args) => args[0] === 'remove'),
    false,
  );
});

test('plugin catalogs expose only bounded display fields and preserve policy, scope and enabled state', () => {
  const catalog = normalizePlugins('codex', {
    installed: [
      { ...installed, source: { path: '/private' }, mcpServers: { secret: 'never expose' } },
    ],
    available: [available],
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].enabled, true);
  assert.ok(!JSON.stringify(catalog).includes('/private'));
  assert.ok(!JSON.stringify(catalog).includes('secret'));
  assert.equal(
    normalizePlugins('codex', {
      installed: [{ ...installed, installPolicy: 'FORCE_INSTALLED' }],
    })[0].managed,
    true,
  );
  assert.equal(
    normalizePlugins('claude', [{ id: installed.pluginId, scope: 'project', enabled: false }])[0]
      .managed,
    true,
  );
  assert.equal(
    normalizePlugins('claude', [{ id: installed.pluginId, scope: 'user', enabled: false }])[0]
      .enabled,
    false,
  );
  assert.throws(() => normalizePlugins('codex', {}), /unsupported/);
  assert.throws(
    () => normalizePlugins('codex', { installed: [{ pluginId: '../oops' }] }),
    /invalid/,
  );
  for (const id of ['--help', 'x@y;calc', '../x@y', 'https://host/plugin', 'x@y\n', 'x@../y'])
    assert.equal(validPluginId(id), false);
});

test('CLI capabilities govern actions, use argument arrays, and invalidate stale catalogs', async () => {
  const calls: string[][] = [];
  const service = createPluginService('.', {
    dataDir: await mkdtemp(path.join(os.tmpdir(), 'openpe-plugin-records-')),
    run: async (_provider: string, args: string[]) => {
      calls.push(args);
      return {
        stdout:
          args[0] === '--help'
            ? '  list  List plugins\n  add  Install\n  remove  Remove\n'
            : args[0] === 'list'
              ? JSON.stringify({ installed: [installed], available: [available] })
              : '{}',
        stderr: '',
      };
    },
  });
  await service.list('codex', signal());
  await service.change('codex', 'install', 'design@official', signal());
  assert.deepEqual(calls.at(-1), ['add', 'design@official', '--json']);
  await service.change('codex', 'uninstall', 'docs@official', signal());
  assert.deepEqual(calls.at(-2), ['list', '--json']);
  assert.deepEqual(calls.at(-1), ['remove', 'docs@official', '--json']);
  await assert.rejects(service.change('codex', 'install', '--bad', signal()), /Invalid/);
  await assert.rejects(service.list('powershell', signal()), /Unknown/);
});

test('older Claude exposes its limitation and still supports explicit user-scope installs', async () => {
  const calls: string[][] = [];
  const service = createPluginService('.', {
    dataDir: await mkdtemp(path.join(os.tmpdir(), 'openpe-plugin-records-')),
    run: async (_provider: string, args: string[]) => {
      calls.push(args);
      return {
        stdout:
          args[0] === '--help'
            ? '  install|i [options]  Install\n  uninstall|remove [options] Remove\n  enable [options] Enable\n  disable [options] Disable'
            : '',
        stderr: '',
      };
    },
  });
  const catalog = await service.list('claude', signal());
  assert.equal(catalog.browse, false);
  assert.match(catalog.warning, /Update/);
  await service.change('claude', 'install', 'design@official', signal());
  assert.deepEqual(calls.at(-1), ['install', 'design@official', '--scope', 'user']);
});

test('managed plugins cannot be changed and provider list warnings remain visible', async () => {
  const service = createPluginService('.', {
    run: async (_provider: string, args: string[]) => ({
      stdout:
        args[0] === '--help'
          ? '  list  List\n  remove  Remove'
          : JSON.stringify({
              installed: [{ ...installed, installPolicy: 'FORCE_INSTALLED' }],
              available: [],
            }),
      stderr: 'Remote catalog unavailable.',
    }),
  });
  assert.match((await service.list('codex', signal())).warning, /unavailable/);
  await assert.rejects(
    service.change('codex', 'uninstall', installed.pluginId, signal()),
    /organization/,
  );
});

test('OpenPE install origins survive restart, isolate providers and scopes, and follow successful changes only', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-plugin-origins-'));
  let fail = false;
  let present = true;
  let projectScoped = false;
  const run = async (provider: string, args: string[]) => {
    if (args[0] === '--help')
      return {
        stdout:
          '  list  List\n  add  Install\n  install  Install\n  remove  Remove\n  uninstall  Remove',
        stderr: '',
      };
    if (args[0] === 'list')
      return {
        stdout: JSON.stringify(
          provider === 'codex'
            ? { installed: present ? [installed] : [], available: [available] }
            : [
                { id: installed.pluginId, scope: 'user' },
                ...(projectScoped ? [{ id: installed.pluginId, scope: 'project' }] : []),
              ],
        ),
        stderr: '',
      };
    if (fail) throw new Error('Installation failed');
    return { stdout: '{}', stderr: '' };
  };
  let service = createPluginService('.', { dataDir, run });
  assert.equal((await service.list('codex', signal())).plugins[0].origin, 'agent');
  fail = true;
  await assert.rejects(service.change('codex', 'install', installed.pluginId, signal()), /failed/);
  assert.equal((await service.list('codex', signal())).plugins[0].origin, 'agent');
  fail = false;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    service.change('codex', 'install', installed.pluginId, cancelled.signal),
    /cancelled/,
  );
  await Promise.all([
    service.change('codex', 'install', installed.pluginId, signal()),
    service.change('claude', 'install', installed.pluginId, signal()),
  ]);
  service = createPluginService('.', { dataDir, run });
  projectScoped = true;
  assert.equal((await service.list('codex', signal())).plugins[0].origin, 'openpe');
  assert.deepEqual(
    (await service.list('claude', signal())).plugins.map((row: { origin: string }) => row.origin),
    ['openpe', 'agent'],
  );
  fail = true;
  await assert.rejects(
    service.change('codex', 'uninstall', installed.pluginId, signal()),
    /failed/,
  );
  assert.equal((await service.list('codex', signal())).plugins[0].origin, 'openpe');
  fail = false;
  await service.change('codex', 'uninstall', installed.pluginId, signal());
  assert.equal((await service.list('codex', signal())).plugins[0].origin, 'agent');
  await service.change('codex', 'install', installed.pluginId, signal());
  present = false;
  assert.deepEqual((await service.list('codex', signal())).plugins, []);
  const file = path.join(dataDir, 'plugin-installations-v1.json');
  await writeFile(file, '{broken');
  present = true;
  const unknown = await service.list('codex', signal(), true);
  assert.equal(unknown.plugins[0].origin, 'unknown');
  assert.match(unknown.warning, /preserved/);
  await assert.rejects(
    service.change('codex', 'install', installed.pluginId, signal()),
    /preserved/,
  );
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('plugin subprocess closes stdin, bounds output/time, and cancels its process tree', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-plugins-'));
  const options = (mode: string) => ({
    resolve: async () => ({ file: process.execPath, args: [fixture, mode], env: process.env }),
    timeoutMs: 5000,
  });
  const result = await runPluginCommand(
    'codex',
    ['add', 'demo@official'],
    cwd,
    signal(),
    options('ok'),
  );
  assert.deepEqual(JSON.parse(result.stdout), ['plugin', 'add', 'demo@official']);
  await assert.rejects(
    runPluginCommand('codex', ['list'], cwd, signal(), options('error')),
    /Sign in/,
  );
  await assert.rejects(
    runPluginCommand('codex', ['list'], cwd, signal(), { ...options('overflow'), maxBytes: 1000 }),
    /exceeded/,
  );
  const timeoutCwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-plugin-timeout-'));
  const timeoutOptions = options('hang');
  const launchBeforeFixture = await timeoutOptions.resolve();
  launchBeforeFixture.args.unshift(
    '--import',
    'data:text/javascript,' +
      encodeURIComponent('await new Promise((resolve) => setTimeout(resolve, 15000));'),
  );
  await assert.rejects(
    runPluginCommand('codex', ['list'], timeoutCwd, signal(), {
      resolve: async () => launchBeforeFixture,
      timeoutMs: 250,
    }),
    /timed out/,
  );
  await assert.rejects(readFile(path.join(timeoutCwd, 'plugin-pids.json')), { code: 'ENOENT' });

  const control = new AbortController();
  const cancelOptions = options('hang');
  const pending = runPluginCommand('codex', ['list'], cwd, control.signal, cancelOptions);
  let settled = false;
  const finished = pending
    .catch(() => {})
    .then(() => {
      settled = true;
    });
  try {
    const pidFile = path.join(cwd, 'plugin-pids.json');
    const deadline = Date.now() + cancelOptions.timeoutMs;
    let pids: unknown;
    while (!settled && Date.now() < deadline) {
      try {
        pids = JSON.parse(await readFile(pidFile, 'utf8'));
        break;
      } catch (error) {
        // The file can be visible before the fixture has written the complete JSON.
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
      }
      await pause(20);
    }
    assert.ok(
      Array.isArray(pids) &&
        pids.length === 2 &&
        pids.every((pid) => Number.isSafeInteger(pid) && pid > 0),
      'The plugin fixture must report both the parent and descendant PIDs before cancellation.',
    );
    assert.notEqual(pids[0], pids[1]);
    for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0));
    control.abort();
    await assert.rejects(pending, /cancelled/);
    for (const pid of pids) await waitForProcessStopped(pid);
  } finally {
    control.abort();
    await finished;
  }
});

test('plugin API enforces token, origin, bounded actions, concurrency and shutdown cancellation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-plugin-api-'));
  let abortSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const service = await startServer({
    dataDir: dir,
    pluginServiceFactory: () => ({
      list: async (_provider: string, s: AbortSignal) => {
        abortSignal = s;
        await new Promise<void>((resolve) => {
          release = resolve;
          s.addEventListener('abort', () => resolve(), { once: true });
        });
        return { plugins: [], browse: true, marketplaces: false, actions: [], warning: '' };
      },
      change: async () => {
        throw new Error('must not execute');
      },
    }),
  });
  const url = service.base + '/api/plugins';
  const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url + '?provider=codex')).status, 401);
    assert.equal((await fetch(url + '?provider=codex&catalog=directory', { headers })).status, 400);
    assert.equal(
      (
        await fetch(url + '?provider=codex', {
          headers: { ...headers, Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    for (const payload of [
      { provider: 'cmd', action: 'install', id: 'x@y' },
      { provider: 'codex', action: 'install', id: '../x@y' },
      { provider: 'codex', action: 'install', id: 'x@y', path: '/tmp' },
    ])
      assert.equal(
        (await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })).status,
        400,
      );
    const pending = fetch(url + '?provider=codex', { headers });
    while (!abortSignal) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await fetch(url + '?provider=codex', { headers })).status, 409);
    service.close();
    assert.equal(abortSignal.aborted, true);
    await pending;
  } finally {
    release?.();
    service.close();
  }
});

test('plugin cache isolates agents, expires, refreshes and invalidates after mutations', async () => {
  let time = 1000,
    reads = 0,
    enabled = true,
    rejectToggle = false;
  const service = createPluginService('.', {
    now: () => time,
    toggle: async (_id: string, value: boolean) => {
      if (rejectToggle) throw new Error('rejected');
      enabled = value;
    },
    run: async (provider: string, args: string[]) => {
      if (args[0] === '--help')
        return { stdout: '  list  List\n  enable  Enable\n  disable  Disable', stderr: '' };
      if (args[0] === 'list') {
        reads++;
        return {
          stdout: JSON.stringify(
            provider === 'codex'
              ? { installed: [{ ...installed, enabled }] }
              : [{ id: installed.pluginId, scope: 'user', enabled }],
          ),
          stderr: '',
        };
      }
      enabled = args[0] === 'enable';
      return { stdout: '{}', stderr: '' };
    },
  });
  await service.list('codex', signal());
  await service.list('codex', signal());
  assert.equal(reads, 1);
  await service.list('claude', signal());
  assert.equal(reads, 2);
  await service.list('codex', signal(), true);
  assert.equal(reads, 3);
  time += 300001;
  await service.list('codex', signal());
  assert.equal(reads, 4);
  await service.change('codex', 'disable', installed.pluginId, signal());
  assert.equal((await service.list('codex', signal())).plugins[0].enabled, false);
  const afterChange = reads;
  await service.list('codex', signal());
  assert.equal(reads, afterChange);
  await service.change('codex', 'enable', installed.pluginId, signal());
  assert.equal((await service.list('codex', signal())).plugins[0].enabled, true);
  rejectToggle = true;
  await assert.rejects(
    service.change('codex', 'disable', installed.pluginId, signal()),
    /rejected/,
  );
  const failedReads = reads;
  assert.equal((await service.list('codex', signal())).plugins[0].enabled, true);
  assert.equal(reads, failedReads + 1);
  await service.change('claude', 'disable', installed.pluginId, signal());
  assert.equal((await service.list('claude', signal())).plugins[0].enabled, false);
});

test('Codex plugin switches use a narrow config RPC and reject overridden, failed or interactive writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-plugin-switch-'));
  const fixture = path.resolve('tests/fixtures/plugin-toggle.mjs');
  const options = (mode: string) => ({
    resolve: async () => ({ file: process.execPath, args: [fixture, mode], env: process.env }),
    timeoutMs: 2000,
  });
  await setCodexPluginEnabled('demo@fixture.test', false, dir, signal(), options('ok'));
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, 'plugin-toggle-request.json'), 'utf8')),
    { keyPath: 'plugins."demo@fixture.test".enabled', value: false, mergeStrategy: 'upsert' },
  );
  for (const [mode, pattern] of [
    ['managed', /overridden/],
    ['error', /rejected/],
    ['approval', /interactive/],
    ['overflow', /size/],
  ] as const)
    await assert.rejects(
      setCodexPluginEnabled('demo@fixture', true, dir, signal(), options(mode)),
      pattern,
    );
  await assert.rejects(
    setCodexPluginEnabled('demo@fixture', true, dir, signal(), {
      ...options('hang'),
      timeoutMs: 100,
    }),
    /timed out/,
  );
  const control = new AbortController();
  const pending = assert.rejects(
    setCodexPluginEnabled('demo@fixture', false, dir, control.signal, options('hang')),
    /cancelled/,
  );
  setTimeout(() => control.abort(), 100);
  await pending;
  await assert.rejects(
    setCodexPluginEnabled('bad".model', false, dir, signal(), options('ok')),
    /Invalid/,
  );
});

test('plugin switches recheck provider policy and require observed enabled state', async () => {
  let managed = false,
    writes = 0;
  const service = createPluginService('.', {
    toggle: async () => {
      writes++;
    },
    run: async (_provider: string, args: string[]) => ({
      stdout:
        args[0] === '--help'
          ? '  list  List'
          : JSON.stringify({
              installed: [
                { ...installed, installPolicy: managed ? 'FORCE_INSTALLED' : 'AVAILABLE' },
              ],
            }),
      stderr: '',
    }),
  });
  await service.list('codex', signal());
  managed = true;
  await assert.rejects(
    service.change('codex', 'disable', installed.pluginId, signal()),
    /organization/,
  );
  assert.equal(writes, 0);
  managed = false;
  await assert.rejects(
    service.change('codex', 'disable', installed.pluginId, signal()),
    /did not confirm/,
  );
  assert.equal(writes, 1);
});
