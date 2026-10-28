import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clockPrecisionMarginMs } from './editor-experience-clock.mjs';

const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
const powerShell = () => {
  assert.equal(process.platform, 'win32', 'Native wheel diagnostic requires Windows.');
  assert.ok(process.env.SystemRoot && path.isAbsolute(process.env.SystemRoot));
  return path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
};
const workerCommand = (filename, method) => {
  assert.ok(['Run', 'GuardTests'].includes(method));
  return `$ErrorActionPreference='Stop';Add-Type -Path ${quotePowerShell(filename)} -ReferencedAssemblies 'System.Web.Extensions';[OpenPENativeWheelWorker]::${method}()`;
};

// Playwright's UtilityScript evaluates this function in the global main context;
// CommonJS lexical require is unavailable there.
export function readNativeOwnerFromElectron({ app, BrowserWindow }, windowId) {
  if (typeof globalThis.process?.getBuiltinModule !== 'function')
    throw new Error(
      'Electron main does not expose process.getBuiltinModule for canonical ownership checks.',
    );
  const nativeProcess = globalThis.process.getBuiltinModule('node:process');
  const nativePath = globalThis.process.getBuiltinModule('node:path');
  if (!nativeProcess || typeof nativePath?.resolve !== 'function')
    throw new Error(
      'Canonical process/path built-ins are unavailable in the Electron main context.',
    );
  const mainFilename = nativeProcess.mainModule?.filename;
  return {
    selectedWindowId: windowId,
    processPid: process.pid,
    processPpid: process.ppid,
    modulePid: nativeProcess.pid,
    modulePpid: nativeProcess.ppid,
    execPath: nativeProcess.execPath,
    mainFilename: typeof mainFilename === 'string' ? nativePath.resolve(mainFilename) : null,
    appPath: nativePath.resolve(app.getAppPath()),
    userData: nativePath.resolve(app.getPath('userData')),
    builtinLoader: 'process.getBuiltinModule',
    identity: globalThis.__openpeBenchmarkIdentity ?? null,
    browserPids: app
      .getAppMetrics()
      .filter((metric) => metric.type === 'Browser')
      .map((metric) => metric.pid),
    windows: BrowserWindow.getAllWindows().map((window) => {
      const buffer = window.getNativeWindowHandle();
      return {
        id: window.id,
        hwnd: (buffer.length === 8
          ? buffer.readBigUInt64LE()
          : BigInt(buffer.readUInt32LE())
        ).toString(),
        focused: window.isFocused(),
        zoom: window.webContents.getZoomFactor(),
      };
    }),
  };
}

export async function inspectNativeOwnerIdentity(application, page) {
  const handle = await application.browserWindow(page);
  try {
    const selectedWindowId = await handle.evaluate((window) => window.id);
    return await application.evaluate(readNativeOwnerFromElectron, selectedWindowId);
  } finally {
    await handle.dispose();
  }
}

export function validateNativeOwnerIdentity(observed, expected) {
  assert.ok(Number.isSafeInteger(expected.spawnPid) && expected.spawnPid > 0);
  assert.ok(typeof expected.instanceNonce === 'string' && expected.instanceNonce.length >= 32);
  assert.ok(Number.isSafeInteger(observed.processPid) && observed.processPid > 0);
  assert.notEqual(
    observed.processPid,
    expected.spawnPid,
    'Windows shell and Electron main must have distinct process identities.',
  );
  assert.equal(
    observed.processPid,
    observed.modulePid,
    'Electron global/module process IDs differ.',
  );
  assert.equal(
    observed.processPpid,
    observed.modulePpid,
    'Electron global/module parent IDs differ.',
  );
  assert.equal(
    observed.processPpid,
    expected.spawnPid,
    'The actual Electron main must be the direct child of the owned Windows launch shell.',
  );
  assert.deepEqual(
    observed.browserPids,
    [observed.processPid],
    'App metrics must identify this exact browser/main PID.',
  );
  const samePath = (actual, wanted, message) => {
    assert.equal(typeof actual, 'string', message);
    assert.equal(path.resolve(actual), path.resolve(wanted), message);
  };
  samePath(
    observed.mainFilename,
    expected.mainPath,
    'Electron main module differs from the verified adapter source.',
  );
  samePath(
    observed.appPath,
    expected.workspaceRoot,
    'Electron app path differs from the owned workspace.',
  );
  samePath(
    observed.userData,
    expected.profile,
    'Electron userData differs from the isolated profile.',
  );
  assert.equal(observed.identity?.nonce, expected.instanceNonce, 'The fresh launch nonce differs.');
  assert.equal(observed.identity?.pid, observed.processPid, 'Launch nonce PID differs.');
  assert.equal(observed.identity?.ppid, expected.spawnPid, 'Launch nonce parent PID differs.');
  samePath(observed.identity?.mainPath, expected.mainPath, 'Launch nonce main path differs.');
  samePath(
    observed.identity?.workspaceRoot,
    expected.workspaceRoot,
    'Launch nonce workspace differs.',
  );
  samePath(observed.identity?.profile, expected.profile, 'Launch nonce profile differs.');
  samePath(
    observed.identity?.rendererPath,
    expected.rendererPath,
    'Launch nonce renderer differs.',
  );
  assert.equal(
    observed.windows?.length,
    1,
    'Native diagnostic requires exactly the owned BrowserWindow.',
  );
  assert.ok(
    Number.isSafeInteger(observed.selectedWindowId) && observed.selectedWindowId > 0,
    'Selected BrowserWindow identity is invalid.',
  );
  const window = observed.windows[0];
  assert.equal(
    window.id,
    observed.selectedWindowId,
    'The BrowserWindow does not own the selected Playwright page.',
  );
  assert.match(window.hwnd, /^[1-9]\d{0,18}$/);
  assert.equal(
    window.focused,
    true,
    'Native diagnostic requires the already-focused owned window.',
  );
  assert.equal(window.zoom, 1, 'Native DPI verification requires unchanged page zoom.');
  return {
    ...window,
    pid: observed.processPid,
    ppid: observed.processPpid,
    spawnWrapperPid: expected.spawnPid,
  };
}

export function validateNativeRequest(command, data = {}) {
  assert.ok(
    ['init', 'clock', 'move', 'wheel', 'stop'].includes(command),
    'Unknown native command.',
  );
  const fields =
    command === 'init'
      ? ['hwnd', 'pid', 'width', 'height', 'ratio', 'left', 'top', 'right', 'bottom', 'x', 'y']
      : [];
  assert.deepEqual(
    Object.keys(data).sort(),
    [...fields].sort(),
    'Unexpected native command fields.',
  );
  if (command === 'init') {
    assert.match(data.hwnd, /^[1-9]\d{0,18}$/);
    assert.ok(Number.isSafeInteger(data.pid) && data.pid > 0 && data.pid <= 2 ** 31 - 1);
    for (const key of fields.filter((key) => !['hwnd', 'pid'].includes(key)))
      assert.ok(
        Number.isFinite(data[key]) && data[key] >= 0 && data[key] <= 16384,
        `Invalid native ${key}.`,
      );
    assert.ok(data.ratio >= 0.5 && data.ratio <= 8);
    assert.ok(
      data.width >= 100 && data.height >= 100 && data.right > data.left && data.bottom > data.top,
    );
    assert.ok(
      data.x > data.left + 8 &&
        data.x < data.right - 8 &&
        data.y > data.top + 8 &&
        data.y < data.bottom - 8,
    );
  }
}

async function stageWorker(profile) {
  const source = await readFile(new URL('./editor-experience-native-worker.cs', import.meta.url));
  const filename = path.join(profile, 'native-wheel-worker.cs');
  await writeFile(filename, source, { flag: 'wx' });
  const helperSource = await readFile(new URL(import.meta.url));
  const helperSourcePath = path.join(profile, 'native-wheel-helper.mjs');
  await writeFile(helperSourcePath, helperSource, { flag: 'wx' });
  return {
    filename,
    sha256: createHash('sha256').update(source).digest('hex'),
    helperSourcePath,
    helperSha256: createHash('sha256').update(helperSource).digest('hex'),
  };
}

export async function createNativeWheelWorker(profile) {
  const staged = await stageWorker(profile);
  const child = spawn(
    powerShell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', workerCommand(staged.filename, 'Run')],
    { cwd: profile, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const metadata = {
    ...staged,
    pid: child.pid,
    transport: 'owned persistent Windows PowerShell/C# console worker',
    plan: ['move', 'wheel:-120', 'wheel:120', 'wheel:-120', 'wheel:120'],
    scope:
      'OS-injected input; excludes physical device latency and observes two RAFs, not a GPU fence. No keys/buttons or window activation are permitted.',
  };
  let sequence = 0,
    pending,
    buffer = '',
    stderr = '',
    totalBytes = 0,
    stopped = false,
    ready;
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const reject = (error) => {
    pending?.reject(error);
    pending = null;
  };
  const readyPromise = new Promise((resolve, fail) => {
    pending = { resolve, reject: fail };
  });
  child.on('error', reject);
  child.stdin.on('error', reject);
  child.on('exit', () => reject(new Error(`Native wheel worker exited: ${stderr.slice(-1500)}`)));
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 16_384) {
      reject(new Error('Native helper stderr exceeded bound.'));
      child.kill();
    }
  });
  child.stdout.on('data', (chunk) => {
    totalBytes += chunk.length;
    buffer += chunk.toString();
    if (totalBytes > 65_536 || buffer.length > 8192) {
      reject(new Error('Native helper output exceeded bound.'));
      child.kill();
      return;
    }
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'),
        line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const current = pending;
      try {
        const response = JSON.parse(line);
        assert.ok(current, 'Unsolicited native helper response.');
        pending = null;
        if (sequence === 0) {
          assert.equal(response.ready, true);
          assert.equal(response.pid, child.pid);
          assert.equal(response.highResolution, true, 'Native QPC timing is unavailable.');
          assert.ok(Number.isFinite(response.frequency) && response.frequency > 0);
          ready = response;
          current.resolve(response);
        } else {
          assert.equal(response.id, sequence, 'Native response ID differs.');
          if (!response.ok)
            current.reject(new Error(response.error ?? 'Native guard rejected the input.'));
          else current.resolve(response.result ?? { stopped: true });
        }
      } catch (error) {
        current?.reject(error);
        pending = null;
        child.kill();
      }
    }
  });
  const timeout = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, fail) => {
          timer = setTimeout(() => fail(new Error('Owned native worker timed out.')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const watchdog = setTimeout(() => {
    reject(new Error('Native worker wall-clock budget exceeded.'));
    child.kill();
  }, 45_000);
  watchdog.unref();
  const close = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(watchdog);
    child.stdin.end();
    try {
      await timeout(exited, 1000);
    } catch {
      child.kill();
      await timeout(exited, 1000).catch(() => {});
    }
  };
  try {
    await timeout(readyPromise, 10_000);
  } catch (error) {
    await close();
    throw error;
  }
  const request = async (command, data = {}) => {
    validateNativeRequest(command, data);
    assert.ok(
      !stopped && !pending && sequence < 32,
      'Native requests must be sequential and bounded.',
    );
    const id = ++sequence;
    const response = new Promise((resolve, fail) => {
      pending = { resolve, reject: fail };
    });
    const nodeBeforeMs = performance.now();
    child.stdin.write(JSON.stringify({ id, command, ...data }) + '\n');
    try {
      const result = await timeout(response, 750);
      return { ...result, requestId: id, nodeBeforeMs, nodeAfterMs: performance.now() };
    } catch (error) {
      await close();
      throw error;
    }
  };
  return {
    metadata: { ...metadata, frequency: ready.frequency, highResolution: ready.highResolution },
    request,
    close,
  };
}

export function qpcClockBracket(reply) {
  assert.ok(
    [reply.nodeBeforeMs, reply.nodeAfterMs, reply.qpcMs, reply.frequency].every(Number.isFinite),
  );
  assert.ok(reply.nodeAfterMs >= reply.nodeBeforeMs && reply.frequency > 0);
  return {
    ...reply,
    lowerOffsetMs: reply.nodeBeforeMs - reply.qpcMs - clockPrecisionMarginMs,
    upperOffsetMs: reply.nodeAfterMs - reply.qpcMs + clockPrecisionMarginMs,
  };
}

export function nativeWheelSummary(inputs, events, rendererClocks, qpcClocks, targetMs = 50) {
  const reasons = [];
  const fail = (condition, message) => {
    if (!condition) reasons.push(message);
  };
  fail(
    inputs.length === 5 && events.length === 5,
    'Exactly one pointer move and four wheel events are required.',
  );
  const [rendererArm, rendererResult] = rendererClocks;
  const [qpcArm, qpcResult] = qpcClocks;
  const brackets = [rendererArm, rendererResult, qpcArm, qpcResult];
  fail(
    brackets.every(
      (value) =>
        value && Number.isFinite(value.lowerOffsetMs) && Number.isFinite(value.upperOffsetMs),
    ),
    'Missing or invalid clock brackets.',
  );
  const rendererLower = Math.max(
    rendererArm?.lowerOffsetMs ?? Infinity,
    rendererResult?.lowerOffsetMs ?? Infinity,
  );
  const rendererUpper = Math.min(
    rendererArm?.upperOffsetMs ?? -Infinity,
    rendererResult?.upperOffsetMs ?? -Infinity,
  );
  const qpcLower = Math.max(
    qpcArm?.lowerOffsetMs ?? Infinity,
    qpcResult?.lowerOffsetMs ?? Infinity,
  );
  const qpcUpper = Math.min(
    qpcArm?.upperOffsetMs ?? -Infinity,
    qpcResult?.upperOffsetMs ?? -Infinity,
  );
  fail(rendererLower <= rendererUpper && qpcLower <= qpcUpper, 'Clock brackets do not intersect.');
  fail(
    rendererArm?.valid === true &&
      rendererResult?.valid === true &&
      rendererArm?.sampleId === 'layout-native-wheel' &&
      rendererResult?.sampleId === 'layout-native-wheel' &&
      rendererArm?.timeOriginMs === rendererResult?.timeOriginMs,
    'Renderer clock identity changed.',
  );
  fail(
    qpcArm?.frequency > 0 && qpcArm?.frequency === qpcResult?.frequency,
    'Native QPC frequency changed.',
  );
  fail(
    Number.isSafeInteger(qpcArm?.requestId) && qpcResult?.requestId === qpcArm.requestId + 6,
    'Native clock/input request sequence differs.',
  );
  const ratios = [];
  let deltaMode;
  const samples = inputs.map((input, index) => {
    const event = events[index],
      errors = [];
    const check = (ok, message) => {
      if (!ok) errors.push(message);
    };
    const type = index === 0 ? 'pointermove' : 'wheel';
    const rawDelta = index === 0 ? 0 : index % 2 ? -120 : 120;
    check(
      input.inputIndex === index && input.type === type && input.wheelDelta === rawDelta,
      'Native input differs from the fixed plan.',
    );
    check(input.insertedCount === 1, 'Native SendInput insertion count differs.');
    check(
      Number.isSafeInteger(input.requestId) && input.requestId === qpcArm?.requestId + index + 1,
      'Native request identity/order differs.',
    );
    check(
      Number.isFinite(input.nodeBeforeMs) &&
        Number.isFinite(input.nodeAfterMs) &&
        input.nodeAfterMs >= input.nodeBeforeMs &&
        input.nodeBeforeMs >= qpcArm?.nodeAfterMs &&
        input.nodeAfterMs <= qpcResult?.nodeBeforeMs &&
        input.qpcBeforeSendMs + qpcUpper >= input.nodeBeforeMs &&
        input.qpcAfterSendMs + qpcLower <= input.nodeAfterMs,
      'QPC injection is outside its Node request/calibration interval.',
    );
    check(
      event?.sampleId === 'layout-native-wheel' &&
        event?.eventSequence === index &&
        event?.type === type &&
        event?.isTrusted === true,
      'Missing, foreign, untrusted or reordered native event.',
    );
    check(
      ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].every((key) => event?.[key] === false) &&
        event?.buttons === 0,
      'Native event modifiers/buttons differ.',
    );
    const expectedX = type === 'wheel' ? Math.floor(input.clientX) : input.clientX;
    const expectedY = type === 'wheel' ? Math.floor(input.clientY) : input.clientY;
    check(
      Number.isFinite(expectedX) &&
        Number.isFinite(expectedY) &&
        Number.isFinite(event?.clientX) &&
        Number.isFinite(event?.clientY) &&
        Math.abs(expectedX - event.clientX) <= (type === 'wheel' ? 0 : 1e-3) &&
        Math.abs(expectedY - event.clientY) <= (type === 'wheel' ? 0 : 1e-3),
      'DPI-quantized native coordinates differ.',
    );
    if (type === 'wheel') {
      check(
        typeof input.cameraBefore === 'string' &&
          typeof input.cameraAfter === 'string' &&
          input.cameraBefore !== input.cameraAfter,
        'The wheel did not change the observed canvas camera.',
      );
      check(
        event?.deltaX === 0 && event?.wheelDeltaX === 0 && event?.wheelDeltaY === rawDelta,
        'Native legacy wheel ticks differ.',
      );
      const ratio = event?.deltaY / -rawDelta;
      check(
        Number.isFinite(ratio) &&
          ratio > 0 &&
          Number.isSafeInteger(event?.deltaMode) &&
          [0, 1, 2].includes(event.deltaMode),
        'Invalid native DOM wheel units.',
      );
      if (deltaMode === undefined) deltaMode = event?.deltaMode;
      check(event?.deltaMode === deltaMode, 'Native deltaMode changed.');
      ratios.push(ratio);
    }
    check(
      Number.isFinite(input.qpcBeforeSendMs) &&
        Number.isFinite(input.qpcAfterSendMs) &&
        input.qpcAfterSendMs >= input.qpcBeforeSendMs &&
        input.qpcBeforeSendMs >= qpcArm?.qpcMs &&
        input.qpcAfterSendMs <= qpcResult?.qpcMs &&
        (index === 0 || input.qpcBeforeSendMs > inputs[index - 1].qpcAfterSendMs),
      'Native send timestamps are invalid or reordered.',
    );
    check(
      Number.isFinite(event?.inputObservedAtMs) &&
        Number.isFinite(event?.presentedAtMs) &&
        Number.isFinite(event?.fromEventMs) &&
        event.fromEventMs >= 0 &&
        event.presentedAtMs >= event.inputObservedAtMs &&
        event.inputObservedAtMs >= rendererArm?.rendererNowMs &&
        event.presentedAtMs <= rendererResult?.rendererNowMs &&
        (index === 0 || event.inputObservedAtMs >= events[index - 1]?.inputObservedAtMs),
      'Native renderer timestamps are incomplete or reordered.',
    );
    const lowerMs =
      event?.presentedAtMs +
      rendererLower -
      input.qpcBeforeSendMs -
      qpcUpper -
      clockPrecisionMarginMs;
    const upperMs =
      event?.presentedAtMs +
      rendererUpper -
      input.qpcBeforeSendMs -
      qpcLower +
      clockPrecisionMarginMs;
    check(Number.isFinite(upperMs) && upperMs >= 0, 'Native presentation precedes its injection.');
    return {
      index,
      input,
      event,
      pairingErrors: errors,
      osInjectionToSecondFrame: { lowerMs: Math.max(0, lowerMs), upperMs },
      withinTarget: errors.length === 0 && upperMs < targetMs && event.fromEventMs < targetMs,
    };
  });
  fail(
    ratios.length === 4 &&
      ratios.every(
        (value) =>
          Number.isFinite(value) &&
          Math.abs(value - ratios[0]) <= Math.max(1e-9, Math.abs(ratios[0]) * Number.EPSILON * 8),
      ),
    'All four DOM deltas must have the same exact proportional relationship to declared native ticks.',
  );
  const valid =
    reasons.length === 0 &&
    samples.length === 5 &&
    samples.every((sample) => sample.pairingErrors.length === 0);
  return {
    targetMs,
    protocol: 'optional-windows-os-injected-wheel',
    expectedCount: 5,
    inputs,
    events,
    timing:
      'QPC immediately before Win32 SendInput through the unchanged second RAF, with conservative helper/Node/renderer clock brackets. Original event duration must also be strictly below target.',
    scope:
      'Separate diagnostic; does not change CDP acceptance or goal status. Physical device latency and a GPU/display fence are excluded. Pre-JS queue time is not classified as purely protocol overhead.',
    wheelUnits: {
      rawTicks: [-120, 120, -120, 120],
      deltaMode,
      domDeltaPerNativeTick: ratios[0] ?? null,
      ratios,
      normalization:
        'No timing normalization; DOM units are recorded and must stay consistently proportional to exact native ticks.',
    },
    clocks: { rendererClocks, qpcClocks, precisionMarginMs: clockPrecisionMarginMs },
    reasons,
    samples,
    valid,
    withinTarget: valid && samples.every((sample) => sample.withinTarget),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--test') {
  let count = 0;
  const { runInNewContext } = await import('node:vm');
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(100n);
  const electronFacade = {
    app: {
      getAppPath: () => process.cwd(),
      getPath: () => process.cwd(),
      getAppMetrics: () => [{ type: 'Browser', pid: process.pid }],
    },
    BrowserWindow: {
      getAllWindows: () => [
        {
          id: 1,
          getNativeWindowHandle: () => buffer,
          isFocused: () => true,
          webContents: { getZoomFactor: () => 1 },
        },
      ],
    },
  };
  const context = { process, electronFacade };
  assert.equal(runInNewContext('typeof require', context), 'undefined');
  const collected = runInNewContext(
    `(${readNativeOwnerFromElectron.toString()})(electronFacade, 1)`,
    context,
  );
  assert.equal(collected.processPid, process.pid);
  assert.equal(collected.modulePid, process.pid);
  assert.equal(collected.builtinLoader, 'process.getBuiltinModule');
  assert.equal(collected.appPath, path.resolve(process.cwd()));
  count++;
  assert.throws(
    () =>
      runInNewContext(`(${readNativeOwnerFromElectron.toString()})(electronFacade, 1)`, {
        process: { pid: process.pid, ppid: process.ppid },
        electronFacade,
      }),
    /getBuiltinModule/,
  );
  count++;
  const ownerExpected = {
    spawnPid: 42,
    mainPath: path.resolve('electron/main.cjs'),
    workspaceRoot: process.cwd(),
    profile: path.resolve('test-results/private-profile'),
    rendererPath: path.resolve('test-results/private-profile/renderer/1'),
    instanceNonce: '12345678-1234-1234-1234-123456789012',
  };
  const ownerFixture = () => ({
    selectedWindowId: 1,
    processPid: 43,
    modulePid: 43,
    processPpid: 42,
    modulePpid: 42,
    mainFilename: ownerExpected.mainPath,
    appPath: ownerExpected.workspaceRoot,
    userData: ownerExpected.profile,
    browserPids: [43],
    identity: {
      nonce: ownerExpected.instanceNonce,
      pid: 43,
      ppid: 42,
      mainPath: ownerExpected.mainPath,
      workspaceRoot: ownerExpected.workspaceRoot,
      profile: ownerExpected.profile,
      rendererPath: ownerExpected.rendererPath,
    },
    windows: [{ id: 1, hwnd: '100', focused: true, zoom: 1 }],
  });
  assert.equal(validateNativeOwnerIdentity(ownerFixture(), ownerExpected).pid, 43);
  count++;
  for (const mutate of [
    (v) => (v.processPid = 42),
    (v) => (v.modulePid = 44),
    (v) => (v.processPpid = 41),
    (v) => (v.modulePpid = 41),
    (v) => (v.browserPids = [44]),
    (v) => (v.mainFilename = process.cwd()),
    (v) => (v.appPath = ownerExpected.profile),
    (v) => (v.userData = process.cwd()),
    (v) => (v.identity.nonce = 'other'),
    (v) => (v.identity.pid = 44),
    (v) => (v.identity.ppid = 41),
    (v) => (v.identity.rendererPath = process.cwd()),
    (v) => v.windows.push({ ...v.windows[0] }),
    (v) => (v.selectedWindowId = 2),
    (v) => (v.windows[0].focused = false),
    (v) => (v.windows[0].hwnd = 'bad'),
    (v) => (v.windows[0].zoom = 2),
  ]) {
    const observed = ownerFixture();
    mutate(observed);
    assert.throws(() => validateNativeOwnerIdentity(observed, ownerExpected));
    count++;
  }
  const good = {
    hwnd: '100',
    pid: 42,
    width: 1100,
    height: 740,
    ratio: 1.25,
    left: 0,
    top: 100,
    right: 800,
    bottom: 700,
    x: 400,
    y: 400,
  };
  validateNativeRequest('init', good);
  count++;
  for (const [command, data] of [
    ['shell', {}],
    ['wheel', { delta: 120 }],
    ['move', { path: 'unexpected' }],
    ['init', { ...good, pid: 0 }],
    ['init', { ...good, x: NaN }],
    ['init', { ...good, ratio: 20 }],
    ['init', { ...good, hwnd: '100;bad' }],
    ['init', { ...good, x: 900 }],
  ]) {
    assert.throws(() => validateNativeRequest(command, data));
    count++;
  }
  const fixture = () => {
    const rendererClocks = [
      {
        valid: true,
        sampleId: 'layout-native-wheel',
        timeOriginMs: 100000,
        rendererNowMs: 1000,
        lowerOffsetMs: 98,
        upperOffsetMs: 102,
      },
      {
        valid: true,
        sampleId: 'layout-native-wheel',
        timeOriginMs: 100000,
        rendererNowMs: 3000,
        lowerOffsetMs: 98,
        upperOffsetMs: 102,
      },
    ];
    const qpcClocks = [
      {
        requestId: 2,
        qpcMs: 10000,
        frequency: 10000000,
        nodeBeforeMs: 998,
        nodeAfterMs: 1002,
        lowerOffsetMs: -9002,
        upperOffsetMs: -8998,
      },
      {
        requestId: 8,
        qpcMs: 12000,
        frequency: 10000000,
        nodeBeforeMs: 2998,
        nodeAfterMs: 3002,
        lowerOffsetMs: -9002,
        upperOffsetMs: -8998,
      },
    ];
    const inputs = Array.from({ length: 5 }, (_, index) => ({
      inputIndex: index,
      insertedCount: 1,
      type: index ? 'wheel' : 'pointermove',
      wheelDelta: index ? (index % 2 ? -120 : 120) : 0,
      requestId: index + 3,
      nodeBeforeMs: 1198 + index * 250,
      nodeAfterMs: 1202 + index * 250,
      cameraBefore: 'before',
      cameraAfter: 'after',
      clientX: 400.8,
      clientY: 350.4,
      qpcBeforeSendMs: 10200 + index * 250,
      qpcAfterSendMs: 10200.1 + index * 250,
    }));
    const events = inputs.map((input, index) => ({
      sampleId: 'layout-native-wheel',
      eventSequence: index,
      type: input.type,
      isTrusted: true,
      clientX: index ? 400 : 400.8,
      clientY: index ? 350 : 350.4,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      buttons: 0,
      deltaX: 0,
      deltaY: (-input.wheelDelta * 5) / 6,
      wheelDeltaX: 0,
      wheelDeltaY: input.wheelDelta,
      deltaMode: 0,
      inputObservedAtMs: input.qpcBeforeSendMs - 9090,
      presentedAtMs: input.qpcBeforeSendMs - 9070,
      fromEventMs: 25,
    }));
    return { inputs, events, rendererClocks, qpcClocks };
  };
  const measure = (value) =>
    nativeWheelSummary(value.inputs, value.events, value.rendererClocks, value.qpcClocks, 50);
  assert.equal(measure(fixture()).withinTarget, true);
  count++;
  for (const mutate of [
    (v) => v.inputs.pop(),
    (v) => v.events.pop(),
    (v) => v.events.push({ ...v.events[0] }),
    (v) => (v.events[1].wheelDeltaY = 120),
    (v) => (v.events[1].clientX += 1),
    (v) => (v.events[1].ctrlKey = true),
    (v) => (v.events[1].deltaY = 110),
    (v) => (v.events[1].deltaMode = 1),
    (v) => (v.events[1].eventSequence = 0),
    (v) => (v.events[1].isTrusted = false),
    (v) => delete v.events[1].presentedAtMs,
    (v) => (v.qpcClocks[1].frequency = 100),
    (v) => v.rendererClocks[1].timeOriginMs++,
    (v) => (v.qpcClocks[1].lowerOffsetMs = 0),
    (v) => v.inputs[1].requestId++,
    (v) => (v.inputs[1].cameraAfter = 'before'),
    (v) => (v.inputs[1].nodeAfterMs = 0),
    (v) => (v.inputs[1].insertedCount = 0),
  ]) {
    const value = fixture();
    mutate(value);
    assert.equal(measure(value).valid, false);
    count++;
  }
  for (const [duration, expected] of [
    [43, true],
    [44, false],
  ]) {
    const value = fixture();
    value.events.forEach(
      (event, index) =>
        (event.presentedAtMs = value.inputs[index].qpcBeforeSendMs - 9100 + duration),
    );
    assert.equal(measure(value).withinTarget, expected);
    count++;
  }
  const value = fixture();
  value.events[1].fromEventMs = 50;
  assert.equal(measure(value).withinTarget, false);
  count++;
  const directory = await mkdtemp(path.resolve('test-results/native-wheel-guard-test-'));
  const staged = await stageWorker(directory);
  const output = await promisify(execFile)(
    powerShell(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      workerCommand(staged.filename, 'GuardTests'),
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 16384 },
  );
  assert.match(output.stdout, /PASS native worker guard tests/);
  console.log(
    `PASS native wheel diagnostic (${count} JS cases + compiled C# ownership/DPI/cursor/schema guards; no native observation/input calls)`,
  );
}
