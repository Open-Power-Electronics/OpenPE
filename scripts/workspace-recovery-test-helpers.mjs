// Test-only observation of the launched fixture's real recovery IPC handler.
// Electron 45.0.0 source: lib/browser/ipc-main-impl.ts (_invokeHandlers Map).
// https://github.com/electron/electron/blob/v45.0.0/lib/browser/ipc-main-impl.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForAsync } from './async-browser-test-helpers.mjs';

function installInMain({ app, BrowserWindow, ipcMain }, wanted) {
  const proc = globalThis.process;
  const canonical = proc.getBuiltinModule('node:process');
  const paths = proc.getBuiltinModule('node:path');
  const fs = proc.getBuiltinModule('node:fs');
  const crypto = proc.getBuiltinModule('node:crypto');
  const check = (ok, text) => {
    if (!ok) throw new Error(text);
  };
  check(
    proc.versions.electron === '45.0.0',
    'Review recovery handler access for this Electron version.',
  );
  check(
    proc.pid === canonical.pid && proc.ppid === canonical.ppid,
    'Canonical Main process differs.',
  );
  check(
    wanted.platform === 'win32' ? proc.ppid === wanted.spawnPid : proc.pid === wanted.spawnPid,
    'Main is not the launched fixture process.',
  );
  check(
    proc.env.OPENPE_TEST === '1' && paths.resolve(app.getPath('userData')) === wanted.profile,
    'Not the owned test profile.',
  );
  const metrics = app.getAppMetrics().filter((item) => item.type === 'Browser');
  check(metrics.length === 1 && metrics[0].pid === proc.pid, 'Owned Browser PID differs.');
  const windows = BrowserWindow.getAllWindows();
  check(windows.length === 1, 'Expected one owned fixture window.');
  const contents = windows[0].webContents;
  const channel = 'openpe:workspace-recovery-write';
  check(ipcMain._invokeHandlers instanceof Map, 'Electron recovery handler Map is unavailable.');
  const original = ipcMain._invokeHandlers.get(channel);
  check(
    typeof original === 'function' &&
      typeof ipcMain.handle === 'function' &&
      typeof ipcMain.removeHandler === 'function',
    'Native recovery handler unavailable.',
  );
  check(!globalThis.__openpeRecoveryTest, 'Recovery observer already installed.');
  const stateFile = paths.join(wanted.profile, 'openpe-workspace-v2.json');
  const evidenceFile = paths.join(wanted.profile, 'workspace-recovery-test-trace.json');
  const state = {
    token: wanted.token,
    sequence: 0,
    active: 0,
    completedWrites: 0,
    completedClears: 0,
    failed: 0,
    records: [],
    truncated: false,
    faultArmed: false,
    validationFaultRejected: false,
    faultFileUnchanged: null,
    faultBeforeSha256: null,
    faultAfterSha256: null,
    unexpectedValidationSuccess: false,
    metadataWriteFailed: false,
  };
  const snapshot = () => ({ ...state, records: state.records.map((record) => ({ ...record })) });
  const publish = () => {
    try {
      fs.writeFileSync(evidenceFile, JSON.stringify(snapshot(), null, 2));
    } catch {
      state.metadataWriteFailed = true;
    }
  };
  const bytes = () => {
    const stat = fs.lstatSync(stateFile);
    check(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 96 * 1024 * 1024,
      'Invalid fixture recovery file.',
    );
    const result = fs.readFileSync(stateFile);
    check(result.length <= 96 * 1024 * 1024, 'Fixture recovery exceeds its bound.');
    return result;
  };
  const wrapper = async function (event, ...args) {
    const sequence = ++state.sequence;
    const kind = args[0] === null ? 'clear' : 'write';
    state.active++;
    let ok = false,
      injected = false;
    try {
      if (
        state.faultArmed &&
        args[0] === null &&
        event.sender === contents &&
        event.senderFrame === contents.mainFrame
      ) {
        state.faultArmed = false;
        injected = true;
        const before = bytes();
        let rejected = false;
        try {
          await Reflect.apply(original, this, [event, 'null']);
        } catch {
          rejected = true;
        }
        const after = bytes();
        state.validationFaultRejected = rejected;
        state.unexpectedValidationSuccess = !rejected;
        state.faultFileUnchanged = before.equals(after);
        state.faultBeforeSha256 = crypto.createHash('sha256').update(before).digest('hex');
        state.faultAfterSha256 = crypto.createHash('sha256').update(after).digest('hex');
        check(rejected, 'Encoded null was unexpectedly accepted by native recovery.');
        check(state.faultFileUnchanged, 'Rejected native recovery changed stored bytes.');
        // This is a real validation rejection, deliberately not a disk-I/O fault.
        throw new Error('Test recovery cleanup failure');
      }
      const result = await Reflect.apply(original, this, [event, ...args]);
      check(result === undefined, 'Native recovery must complete without a payload.');
      ok = true;
      if (kind === 'clear') state.completedClears++;
      else state.completedWrites++;
      return result;
    } finally {
      state.active--;
      if (!ok) state.failed++;
      if (state.records.length < 128)
        state.records.push({ sequence, kind, ok, injectedValidationFault: injected });
      else state.truncated = true;
      publish();
    }
  };
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, wrapper);
  const control = {
    snapshot,
    arm() {
      check(
        !state.faultArmed && !state.validationFaultRejected,
        'Recovery fault already armed/used.',
      );
      state.faultArmed = true;
      publish();
      return snapshot();
    },
    restore() {
      const current = ipcMain._invokeHandlers.get(channel);
      if (current === wrapper) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, original);
      }
      if (globalThis.__openpeRecoveryTest === control) delete globalThis.__openpeRecoveryTest;
      return { restored: current === wrapper };
    },
  };
  Object.defineProperty(globalThis, '__openpeRecoveryTest', { configurable: true, value: control });
  publish();
  return { stateFile, evidenceFile, electronVersion: proc.versions.electron };
}

async function completedRecoveryState(snapshot, readState, httpWrites, after, predicate) {
  const before = await snapshot();
  assert.equal(before.metadataWriteFailed || before.truncated, false);
  if (
    before.active ||
    !before.records.some(
      (record) => record.sequence > after && record.kind === 'write' && record.ok,
    )
  )
    return false;
  let state;
  try {
    state = await readState();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const matches = await predicate(state);
  const end = await snapshot();
  if (end.active || end.sequence !== before.sequence || !matches) return false;
  assert.equal(httpWrites(), 0, 'Desktop recovery must use native completion, not HTTP writes.');
  assert.equal(end.metadataWriteFailed || end.truncated, false);
  return { state, observation: end };
}

export async function observeWorkspaceRecovery(application, page, profile) {
  profile = path.resolve(profile);
  const root = path.resolve('test-results');
  assert.ok(profile.startsWith(root + path.sep));
  assert.equal(await realpath(profile), profile);
  const stat = await lstat(profile);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  const token = randomUUID();
  const child = application.process();
  assert.ok(child?.pid);
  const observed = await application.evaluate(installInMain, {
    token,
    profile,
    spawnPid: child.pid,
    platform: process.platform,
  });
  let httpWrites = 0;
  const onRequest = (request) => {
    if (
      ['POST', 'DELETE'].includes(request.method()) &&
      new URL(request.url()).pathname === '/api/state'
    )
      httpWrites++;
  };
  page.on('request', onRequest);
  const snapshot = () =>
    application.evaluate((_electron, token) => {
      const control = globalThis.__openpeRecoveryTest;
      if (!control || control.snapshot().token !== token)
        throw new Error('Recovery observer ownership changed.');
      return control.snapshot();
    }, token);
  const poll = {
    evaluate: async (_unused, { after, predicate }) =>
      completedRecoveryState(
        snapshot,
        async () => JSON.parse(await readFile(observed.stateFile, 'utf8')),
        () => httpWrites,
        after,
        predicate,
      ),
    waitForTimeout: (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  };
  return {
    ...observed,
    snapshot,
    waitForState: (predicate, { after = 0 } = {}) => waitForAsync(poll, null, { after, predicate }),
    armClearValidationFailure: () =>
      application.evaluate((_electron, token) => {
        const control = globalThis.__openpeRecoveryTest;
        if (!control || control.snapshot().token !== token)
          throw new Error('Recovery observer ownership changed.');
        return control.arm();
      }, token),
    async evidence() {
      const state = JSON.parse(await readFile(observed.evidenceFile, 'utf8'));
      assert.equal(state.token, token);
      return { ...state, httpWrites };
    },
    async restore() {
      page.removeListener('request', onRequest);
      return application.evaluate((_electron, token) => {
        const control = globalThis.__openpeRecoveryTest;
        if (!control || control.snapshot().token !== token) return { restored: false };
        return control.restore();
      }, token);
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--test') {
  const { runInNewContext } = await import('node:vm');
  const { createHash } = await import('node:crypto');
  const files = new Map([
    ['/fixture/openpe-workspace-v2.json', Buffer.from('{"retained":"NEVER-LOG"}')],
  ]);
  const fakeFs = {
    writeFileSync: (name, text) => files.set(name, Buffer.from(text)),
    lstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: files.get('/fixture/openpe-workspace-v2.json').length,
    }),
    readFileSync: (name) => files.get(name),
  };
  const originalCalls = [],
    handlers = new Map();
  const contents = { mainFrame: {} },
    event = { sender: contents, senderFrame: contents.mainFrame };
  const original = async (seen, content) => {
    assert.equal(seen, event);
    originalCalls.push(content);
    if (content === 'null') throw new Error('Invalid workspace');
    files.set('/fixture/openpe-workspace-v2.json', Buffer.from(content ?? 'null'));
  };
  handlers.set('openpe:workspace-recovery-write', original);
  const ipcMain = {
    _invokeHandlers: handlers,
    removeHandler: (key) => handlers.delete(key),
    handle: (key, fn) => {
      assert.equal(handlers.has(key), false);
      handlers.set(key, fn);
    },
  };
  const proc = { pid: 10, ppid: 9, env: { OPENPE_TEST: '1' }, versions: { electron: '45.0.0' } };
  proc.getBuiltinModule = (name) =>
    ({
      'node:process': proc,
      'node:path': path.posix,
      'node:fs': fakeFs,
      'node:crypto': { createHash },
    })[name];
  const context = {
    process: proc,
    Map,
    Buffer,
    Electron: {
      ipcMain,
      app: { getPath: () => '/fixture', getAppMetrics: () => [{ type: 'Browser', pid: 10 }] },
      BrowserWindow: { getAllWindows: () => [{ webContents: contents }] },
    },
    wanted: { profile: '/fixture', token: 'test-token', spawnPid: 9, platform: 'win32' },
  };
  runInNewContext(`(${installInMain.toString()})(Electron, wanted)`, context);
  const control = context.__openpeRecoveryTest,
    handler = handlers.get('openpe:workspace-recovery-write');
  await handler(event, '{"retained":"NEVER-LOG"}');
  const before = files.get('/fixture/openpe-workspace-v2.json');
  control.arm();
  await assert.rejects(handler(event, null), /Test recovery cleanup failure/);
  assert.equal(files.get('/fixture/openpe-workspace-v2.json').equals(before), true);
  assert.equal(
    control.snapshot().validationFaultRejected && control.snapshot().faultFileUnchanged,
    true,
  );
  await handler(event, null);
  assert.deepEqual(originalCalls, ['{"retained":"NEVER-LOG"}', 'null', null]);
  assert.equal(control.snapshot().completedClears, 1);
  assert.equal(control.snapshot().failed, 1);
  assert.ok(!JSON.stringify(control.snapshot()).includes('NEVER-LOG'));
  assert.equal(control.restore().restored, true);
  assert.equal(handlers.get('openpe:workspace-recovery-write'), original);
  runInNewContext(`(${installInMain.toString()})(Electron, wanted)`, context);
  const foreign = () => {};
  handlers.set('openpe:workspace-recovery-write', foreign);
  assert.equal(context.__openpeRecoveryTest.restore().restored, false);
  assert.equal(handlers.get('openpe:workspace-recovery-write'), foreign);
  proc.versions.electron = '44.0.0';
  assert.throws(
    () => runInNewContext(`(${installInMain.toString()})(Electron, wanted)`, context),
    /Review recovery handler access/,
  );
  assert.equal(handlers.get('openpe:workspace-recovery-write'), foreign);
  proc.versions.electron = '45.0.0';
  files.set('/fixture/openpe-workspace-v2.json', Buffer.from('{"retained":"NEVER-LOG"}'));
  handlers.set('openpe:workspace-recovery-write', async (_event, content) => {
    files.set('/fixture/openpe-workspace-v2.json', Buffer.from(content ?? 'null'));
  });
  runInNewContext(`(${installInMain.toString()})(Electron, wanted)`, context);
  context.__openpeRecoveryTest.arm();
  await assert.rejects(
    handlers.get('openpe:workspace-recovery-write')(event, null),
    /Encoded null was unexpectedly accepted/,
  );
  assert.equal(context.__openpeRecoveryTest.snapshot().unexpectedValidationSuccess, true);
  assert.equal(context.__openpeRecoveryTest.snapshot().faultFileUnchanged, false);
  context.__openpeRecoveryTest.restore();
  const oldSuccessNewFailure = {
    sequence: 2,
    active: 0,
    completedWrites: 1,
    truncated: false,
    metadataWriteFailed: false,
    records: [
      { sequence: 1, kind: 'write', ok: true },
      { sequence: 2, kind: 'write', ok: false },
    ],
  };
  assert.equal(
    await completedRecoveryState(
      async () => oldSuccessNewFailure,
      async () => ({ expected: true }),
      () => 0,
      1,
      (state) => state.expected,
    ),
    false,
    'A new failed call cannot borrow an older successful completion even if the file matches.',
  );
  const completed = {
    ...oldSuccessNewFailure,
    records: [{ sequence: 2, kind: 'write', ok: true }],
  };
  assert.equal(
    await completedRecoveryState(
      async () => completed,
      async () => ({ expected: true }),
      () => 0,
      1,
      async () => false,
    ),
    false,
  );
  let polls = 0;
  assert.equal(
    await completedRecoveryState(
      async () => ({ ...completed, sequence: ++polls === 1 ? 2 : 3 }),
      async () => ({ expected: true }),
      () => 0,
      1,
      () => true,
    ),
    false,
    'A concurrent native call invalidates the file-read bracket.',
  );
  assert.equal(
    (
      await completedRecoveryState(
        async () => completed,
        async () => ({ expected: true }),
        () => 0,
        1,
        async (state) => state.expected,
      )
    ).observation.sequence,
    2,
  );
  console.log(
    'PASS pure native recovery observer delegation, validation fault/file retention, retry, metadata-only evidence and conditional restoration; no Electron launch.',
  );
}
