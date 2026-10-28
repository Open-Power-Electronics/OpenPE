import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const intervalMs = 20;
const maxHeartbeats = 2048;
const maxInputs = 1024;
const maxErrors = 16;
const defaultRuntime = {
  now: () => performance.now(),
  cpuUsage: () => process.cpuUsage(),
  threadCpuUsage:
    typeof process.threadCpuUsage === 'function' ? () => process.threadCpuUsage() : null,
  elu:
    typeof performance.eventLoopUtilization === 'function'
      ? () => performance.eventLoopUtilization()
      : null,
  schedule: (callback) => setInterval(callback, intervalMs),
  cancel: (timer) => clearInterval(timer),
};

const unavailable = (reason) => ({ available: false, value: null, reason });
const message = (error) => String(error?.message ?? error).slice(0, 240);

/** Test-only observations of this benchmark/Playwright Node process. No input,
 * browser request, presentation marker or acceptance result is produced here. */
export function createNodeInputDiagnostics({ enabled = false, runtime = defaultRuntime } = {}) {
  let timer = null,
    stopped = false,
    active = null,
    nextHeartbeat = 0,
    heartbeatCount = 0,
    droppedHeartbeats = 0,
    droppedInputs = 0;
  const heartbeats = [],
    inputs = [],
    errors = [];
  const features = enabled
    ? Object.fromEntries(
        ['cpuUsage', 'threadCpuUsage', 'elu'].map((key) => [
          key,
          typeof runtime[key] === 'function',
        ]),
      )
    : null;
  const recordError = (error) => {
    if (errors.length < maxErrors) errors.push(message(error));
  };
  const read = (kind) => {
    if (!features[kind]) return unavailable(`${kind} is unavailable in this Node runtime.`);
    try {
      const value = runtime[kind]();
      const fields = kind === 'elu' ? ['active', 'idle'] : ['user', 'system'];
      if (!fields.every((key) => Number.isFinite(value?.[key]) && value[key] >= 0))
        return unavailable(`${kind} returned invalid counters.`);
      return { available: true, value: Object.fromEntries(fields.map((key) => [key, value[key]])) };
    } catch (error) {
      return unavailable(message(error));
    }
  };
  const capture = () => ({
    cpuUsage: read('cpuUsage'),
    threadCpuUsage: read('threadCpuUsage'),
    elu: read('elu'),
  });
  const delta = (kind, before, after) => {
    if (!before.available || !after.available) return unavailable(before.reason ?? after.reason);
    const fields = kind === 'elu' ? ['active', 'idle'] : ['user', 'system'];
    const value = Object.fromEntries(
      fields.map((key) => [key, after.value[key] - before.value[key]]),
    );
    if (!fields.every((key) => Number.isFinite(value[key]) && value[key] >= 0))
      return unavailable(`${kind} counters moved backwards.`);
    if (kind === 'elu')
      value.utilization =
        value.active + value.idle ? value.active / (value.active + value.idle) : 0;
    return { available: true, value };
  };
  let previousHeartbeatAtMs;
  const tick = (kind = 'timer') => {
    if (!enabled || stopped) return;
    try {
      const atMs = runtime.now();
      const gapMs = atMs - previousHeartbeatAtMs;
      if (!Number.isFinite(gapMs) || gapMs < 0) throw new Error('Invalid Node heartbeat clock.');
      const sample = { kind, atMs, gapMs, delayedByMs: Math.max(0, gapMs - intervalMs) };
      previousHeartbeatAtMs = atMs;
      heartbeats[nextHeartbeat] = sample;
      nextHeartbeat = (nextHeartbeat + 1) % maxHeartbeats;
      if (heartbeatCount < maxHeartbeats) heartbeatCount++;
      else droppedHeartbeats++;
    } catch (error) {
      recordError(error);
    }
  };
  if (enabled) {
    previousHeartbeatAtMs = runtime.now();
    timer = runtime.schedule(() => tick());
    timer?.unref?.();
  }
  const finish = ({
    completed = true,
    acknowledgedMs = null,
    overloaded = false,
    error = null,
  } = {}) => {
    if (!enabled || stopped || !active) return;
    const { record, before } = active;
    active = null;
    const after = capture();
    Object.assign(record, {
      observedReturnAtMs: runtime.now(),
      status: completed ? (overloaded ? 'acknowledged-overload' : 'acknowledged') : 'failed',
      acknowledgedMs: Number.isFinite(acknowledgedMs) ? acknowledgedMs : null,
      error: error ? message(error) : null,
      counters: Object.fromEntries(
        ['cpuUsage', 'threadCpuUsage', 'elu'].map((kind) => [
          kind,
          delta(kind, before[kind], after[kind]),
        ]),
      ),
    });
  };
  return {
    begin(invocation) {
      if (!enabled || stopped) return;
      if (active) {
        active.record.status = 'unfinished-before-next-invocation';
        active.record.counters = unavailable('No original API return was observed.');
        active = null;
      }
      if (inputs.length >= maxInputs) {
        droppedInputs++;
        return;
      }
      const record = {
        sampleId: invocation.sampleId,
        index: invocation.actionIndex ?? invocation.inputIndex,
        transport: invocation.transport,
        method: invocation.method ?? invocation.type,
        originalNodeInvokedAtMs: invocation.nodeInvokedAtMs,
        diagnosticStartedAtMs: runtime.now(),
        status: 'in-flight',
        counters: unavailable('The original API has not returned.'),
      };
      inputs.push(record);
      active = { record, before: capture() };
    },
    finish,
    stop() {
      if (!enabled || stopped) return;
      // A final observation is explicit; it is not a timer callback or a wait.
      tick('stop-snapshot');
      stopped = true;
      try {
        runtime.cancel(timer);
      } catch (error) {
        recordError(error);
      }
      if (active) {
        active.record.status = 'unfinished-at-stop';
        active.record.counters = unavailable('Stopped without waiting for an original API return.');
        active = null;
      }
    },
    snapshot() {
      if (!enabled) return { enabled: false };
      const ordered =
        heartbeatCount < maxHeartbeats
          ? heartbeats.slice(0, heartbeatCount)
          : [...heartbeats.slice(nextHeartbeat), ...heartbeats.slice(0, nextHeartbeat)];
      return {
        enabled: true,
        protocol: 'node-input-diagnostics-v1',
        scope:
          'Benchmark Node process including its in-process Playwright driver; excludes Electron main and renderer CPU. Only paired Layout navigation/track APIs are sampled. Sampling begins after the unchanged original invocation clock and finishes after the unchanged acknowledgement clock; it does not redefine latency or acceptance.',
        units: {
          cpuUsage: 'microseconds',
          threadCpuUsage: 'microseconds',
          elu: 'milliseconds',
          heartbeat: 'milliseconds',
        },
        intervalMs,
        maxHeartbeats,
        maxInputs,
        features,
        stopped,
        heartbeats: ordered.map((sample) => ({ ...sample })),
        droppedHeartbeats,
        droppedInputs,
        inputs: structuredClone(inputs),
        errors: [...errors],
      };
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--test') {
  const { default: assert } = await import('node:assert/strict');
  let now = 0,
    callback,
    unrefs = 0,
    cancels = 0,
    reads = 0;
  const runtime = {
    now: () => now,
    cpuUsage: () => {
      reads++;
      return { user: now * 2, system: now };
    },
    threadCpuUsage: () => ({ user: now, system: now / 2 }),
    elu: () => ({ active: now * 0.75, idle: now * 0.25 }),
    schedule: (value) => {
      callback = value;
      return {
        unref() {
          unrefs++;
        },
      };
    },
    cancel: () => {
      cancels++;
    },
  };
  const invocation = (index) => ({
    sampleId: 'layout-track-paced-preview',
    actionIndex: index,
    transport: 'playwright.mouse.move',
    method: 'move',
    nodeInvokedAtMs: now - 1,
  });
  const disabled = createNodeInputDiagnostics({ runtime });
  disabled.begin(invocation(0));
  disabled.finish();
  disabled.stop();
  assert.deepEqual(disabled.snapshot(), { enabled: false });
  assert.equal(reads, 0);
  assert.equal(unrefs, 0);
  assert.equal(cancels, 0);
  const monitor = createNodeInputDiagnostics({ enabled: true, runtime });
  assert.equal(unrefs, 1);
  monitor.begin(invocation(0));
  now = 200;
  callback();
  monitor.finish({ acknowledgedMs: 199, overloaded: true });
  const measured = monitor.snapshot();
  assert.equal(measured.inputs[0].originalNodeInvokedAtMs, -1);
  assert.equal(measured.inputs[0].status, 'acknowledged-overload');
  assert.equal(measured.inputs[0].acknowledgedMs, 199);
  assert.deepEqual(measured.inputs[0].counters.cpuUsage, {
    available: true,
    value: { user: 400, system: 200 },
  });
  assert.deepEqual(measured.inputs[0].counters.threadCpuUsage.value, { user: 200, system: 100 });
  assert.deepEqual(measured.inputs[0].counters.elu.value, {
    active: 150,
    idle: 50,
    utilization: 0.75,
  });
  assert.equal(measured.heartbeats[0].delayedByMs, 180);
  measured.inputs[0].counters.cpuUsage.value.user = -1;
  measured.heartbeats[0].gapMs = -1;
  assert.equal(monitor.snapshot().inputs[0].counters.cpuUsage.value.user, 400);
  assert.equal(monitor.snapshot().heartbeats[0].gapMs, 200);
  for (let index = 0; index < maxHeartbeats + 3; index++) {
    now += 20;
    callback();
  }
  for (let index = 1; index < maxInputs + 3; index++) {
    monitor.begin(invocation(index));
    monitor.finish({ completed: false, error: new Error('timed out') });
  }
  monitor.begin(invocation(maxInputs + 4));
  monitor.stop();
  monitor.stop();
  callback();
  const bounded = monitor.snapshot();
  assert.equal(bounded.heartbeats.length, maxHeartbeats);
  assert.equal(bounded.inputs.length, maxInputs);
  assert.equal(bounded.droppedInputs, 4);
  assert.ok(bounded.droppedHeartbeats > 0);
  assert.ok(
    bounded.heartbeats.every((sample, index, all) => !index || sample.atMs >= all[index - 1].atMs),
  );
  assert.equal(cancels, 1);
  assert.equal(bounded.stopped, true);
  assert.equal(bounded.inputs[1].status, 'failed');
  const unavailableMonitor = createNodeInputDiagnostics({
    enabled: true,
    runtime: {
      ...runtime,
      threadCpuUsage: null,
      cpuUsage: () => {
        throw new Error('CPU unavailable');
      },
      elu: null,
    },
  });
  unavailableMonitor.begin(invocation(0));
  unavailableMonitor.finish();
  const missing = unavailableMonitor.snapshot();
  for (const counter of Object.values(missing.inputs[0].counters)) {
    assert.equal(counter.available, false);
    assert.equal(counter.value, null);
  }
  assert.equal(missing.features.threadCpuUsage, false);
  unavailableMonitor.begin(invocation(1));
  unavailableMonitor.stop();
  assert.equal(unavailableMonitor.snapshot().inputs[1].status, 'unfinished-at-stop');
  assert.equal(unavailableMonitor.snapshot().inputs[1].counters.value, null);
  assert.equal(cancels, 2);
  console.log(
    'PASS Node input diagnostics: disabled/no sampling, exact counter deltas, unavailable features, bounded rings, detached results, overload/timeout retention and idempotent synchronous cleanup (no browser)',
  );
}
