import { open, readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const inputPolicy = Object.freeze({ intervalMs: 250, overloadMs: 200, timeoutMs: 750 });

export function createRunGuard({ wallClockMs = 90_000 } = {}) {
  const deadlineAtMs = performance.now() + wallClockMs;
  const controller = new AbortController();
  let reason;
  const abort = (error) => {
    if (!reason) {
      reason = error instanceof Error ? error : new Error(String(error));
      controller.abort(reason);
    }
    return reason;
  };
  const check = () => {
    if (reason) throw reason;
  };
  const run = async (operation, { timeoutMs = 5_000, label = 'operation' } = {}) => {
    check();
    let timer;
    let onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => abort(new Error(`${label} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      // The factory is never invoked after cancellation. Promise.race also
      // observes a late rejection from an operation that cannot be cancelled.
      const result = await Promise.race([
        Promise.resolve().then(() => {
          check();
          return operation();
        }),
        stopped,
      ]);
      check();
      return result;
    } catch (error) {
      throw abort(error);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
  const sleep = async (ms) => {
    check();
    let timer;
    try {
      await run(
        () =>
          new Promise((resolve) => {
            timer = setTimeout(resolve, ms);
          }),
        {
          timeoutMs: ms + 1_000,
          label: 'input pacing',
        },
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const watchdog = setTimeout(
    () => abort(new Error(`Benchmark wall-clock budget exceeded (${wallClockMs} ms)`)),
    wallClockMs,
  );
  return {
    run,
    sleep,
    check,
    abort,
    signal: controller.signal,
    deadlineAtMs,
    get reason() {
      return reason;
    },
    dispose() {
      clearTimeout(watchdog);
    },
  };
}

// A nested run rejects its outer guard immediately on abort. Register this gate
// before the operation so owned shutdown can await read-only evidence cleanup,
// while the sticky input guard continues to reject every new send.
export function createFailureEvidenceGate({ graceMs = 4_000 } = {}) {
  let active = null;
  return {
    begin() {
      if (active) throw new Error('Concurrent measurement evidence gates are unsupported.');
      let resolve;
      const ticket = { done: new Promise((complete) => (resolve = complete)) };
      active = ticket;
      return () => {
        if (active === ticket) active = null;
        resolve();
      };
    },
    async beforeShutdown(reason, deadlineAtMs = Infinity) {
      const ticket = active;
      if (!ticket || !reason) return { method: 'no-active-aborted-measurement' };
      const remainingMs = Math.min(graceMs, deadlineAtMs - performance.now());
      if (
        /timed out|wall-clock budget exceeded|Concurrent benchmark input/i.test(reason.message) ||
        remainingMs <= 0
      )
        return { method: 'immediate-owned-shutdown', evidenceGraceMs: 0 };
      const started = performance.now();
      try {
        await bounded(() => ticket.done, remainingMs);
        return {
          method: 'bounded-read-only-evidence-complete',
          evidenceGraceMs: remainingMs,
          waitedMs: performance.now() - started,
        };
      } catch {
        return {
          method: 'evidence-grace-exhausted-owned-shutdown',
          evidenceGraceMs: remainingMs,
          waitedMs: performance.now() - started,
        };
      }
    },
  };
}

// Await acknowledgement before the next input and then wait a full interval.
// A slow acknowledgement ends the entire run; there is no catch-up burst.
export function createInputSender(guard, policy = inputPolicy, { onSettled } = {}) {
  let inFlight = false;
  const samples = [];
  const notify = (result) => {
    try {
      onSettled?.(result);
    } catch {
      /* Diagnostics cannot change input/abort semantics. */
    }
  };
  const send = async (operation, label = 'input') => {
    guard.check();
    if (inFlight) throw guard.abort(new Error(`Concurrent benchmark input rejected: ${label}`));
    inFlight = true;
    const started = performance.now();
    let observed = false;
    try {
      const result = await guard.run(operation, { timeoutMs: policy.timeoutMs, label });
      const acknowledgedMs = performance.now() - started;
      samples.push({ label, acknowledgedMs });
      if (acknowledgedMs > policy.overloadMs) {
        const error = guard.abort(
          new Error(
            `${label} overloaded: acknowledgement ${acknowledgedMs.toFixed(1)} ms exceeds ${policy.overloadMs} ms`,
          ),
        );
        observed = true;
        notify({ completed: true, acknowledgedMs, overloaded: true });
        throw error;
      }
      observed = true;
      notify({ completed: true, acknowledgedMs, overloaded: false });
      return result;
    } catch (error) {
      if (!observed) notify({ completed: false, error });
      throw error;
    } finally {
      // After a timeout this flag may clear while the transport is unresolved,
      // but the sticky guard rejects every subsequent input before invocation.
      inFlight = false;
    }
  };
  return { send, samples };
}

export async function runPacedInputs(
  sender,
  guard,
  count,
  operation,
  intervalMs = inputPolicy.intervalMs,
) {
  const started = performance.now();
  for (let index = 1; index <= count; index++) {
    await sender.send(() => operation(index, count), `navigation input ${index}/${count}`);
    if (index < count) await guard.sleep(intervalMs);
  }
  return {
    requestedInputs: count,
    maximumInFlight: 1,
    minimumIdleAfterAcknowledgementMs: intervalMs,
    acknowledgedMs: performance.now() - started,
  };
}

export async function acquireBenchmarkLock(filename) {
  const token = randomUUID();
  let handle;
  try {
    handle = await open(filename, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `An editor benchmark lock already exists: ${filename}. No other instance was stopped. Remove a stale lock only after verifying that its benchmark has exited.`,
      );
    throw error;
  }
  const ownedFile = await handle.stat();
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
    );
  } catch (error) {
    await handle.close();
    try {
      const current = await stat(filename);
      if (current.dev === ownedFile.dev && current.ino === ownedFile.ino) await unlink(filename);
    } catch {
      /* Keep the original write failure. */
    }
    throw error;
  }
  return () =>
    bounded(async () => {
      await handle.close();
      // Never remove a replacement lock owned by another invocation.
      try {
        if (JSON.parse(await readFile(filename, 'utf8')).token === token) await unlink(filename);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }, 1_000);
}

export const bounded = async (operation, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned application shutdown timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// This accepts only the ChildProcess obtained from this invocation's launch.
// It never enumerates processes, matches executable names or touches another app.
export async function closeOwnedApplication(application, child) {
  if (!application || !child) return { method: 'not-launched' };
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return { method: 'already-exited' };
  try {
    await bounded(() => application.evaluate(({ app }) => app.exit(0)), 1_000);
  } catch {
    /* The renderer/main transport may be blocked. Use the owned handle below. */
  }
  try {
    await bounded(() => application.close(), 1_000);
  } catch {
    /* bounded fallback below */
  }
  if (exited()) return { method: 'main-exit' };
  if (process.platform === 'win32') {
    await bounded(
      () =>
        new Promise((resolve, reject) => {
          execFile(
            'taskkill.exe',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 1_500 },
            (error) => (error && !exited() ? reject(error) : resolve()),
          );
        }),
      2_000,
    );
  } else child.kill('SIGKILL');
  await bounded(
    () => (exited() ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve))),
    1_000,
  );
  return { method: 'owned-process-termination' };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--test') {
  const { default: assert } = await import('node:assert/strict');
  const { mkdtemp, rmdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let inFlight = 0,
    maxInFlight = 0,
    sends = 0;
  const guard = createRunGuard({ wallClockMs: 2_000 });
  const sender = createInputSender(guard, { timeoutMs: 100, overloadMs: 80 });
  await runPacedInputs(
    sender,
    guard,
    4,
    async () => {
      sends++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(8);
      inFlight--;
    },
    5,
  );
  assert.equal(sends, 4);
  assert.equal(maxInFlight, 1);
  guard.dispose();

  for (const mode of ['slow', 'timeout', 'watchdog']) {
    const scoped = createRunGuard({ wallClockMs: mode === 'watchdog' ? 25 : 1_000 });
    const input = createInputSender(scoped, { timeoutMs: 45, overloadMs: 15 });
    let count = 0;
    await assert.rejects(
      runPacedInputs(
        input,
        scoped,
        5,
        async () => {
          count++;
          await delay(mode === 'slow' ? 25 : 90);
        },
        2,
      ),
      mode === 'slow' ? /overloaded/ : /timed out|wall-clock/,
    );
    await delay(100);
    await assert.rejects(
      input.send(() => {
        count++;
      }),
      /overloaded|timed out|wall-clock/,
    );
    assert.equal(
      count,
      1,
      `${mode} must stop all later sends, including after late acknowledgement`,
    );
    scoped.dispose();
  }
  const concurrent = createRunGuard({ wallClockMs: 1_000 });
  const single = createInputSender(concurrent, { timeoutMs: 100, overloadMs: 80 });
  const pending = single.send(() => delay(25));
  await assert.rejects(
    single.send(() => assert.fail('second input must not be invoked')),
    /Concurrent/,
  );
  await assert.rejects(pending, /Concurrent/);
  concurrent.dispose();
  const diagnosticGuard = createRunGuard({ wallClockMs: 1_000 });
  const diagnosticResults = [];
  const diagnosticSender = createInputSender(
    diagnosticGuard,
    { timeoutMs: 20, overloadMs: 15 },
    {
      onSettled(result) {
        diagnosticResults.push(result);
        throw new Error('Diagnostic failure');
      },
    },
  );
  await diagnosticSender.send(async () => 'done');
  assert.equal(diagnosticResults[0].acknowledgedMs, diagnosticSender.samples[0].acknowledgedMs);
  assert.equal(diagnosticResults[0].completed, true);
  await assert.rejects(
    diagnosticSender.send(() => new Promise(() => {})),
    /timed out/,
  );
  assert.equal(diagnosticResults[1].completed, false);
  assert.match(diagnosticGuard.reason.message, /timed out/);
  diagnosticGuard.dispose();

  // Reproduce the real nested-run race: the outer rejection must stop inputs
  // immediately but cannot close the owned page before inner evidence returns.
  const nestedGuard = createRunGuard({ wallClockMs: 1_000 });
  const gate = createFailureEvidenceGate({ graceMs: 100 });
  const order = [];
  let nestedSends = 0;
  let inner;
  const originalFailure = new Error('navigation input overloaded: acknowledgement exceeds budget');
  await assert.rejects(
    nestedGuard.run(async () => {
      const release = gate.begin();
      inner = (async () => {
        try {
          await nestedGuard.run(async () => {
            nestedSends++;
            throw originalFailure;
          });
        } catch (error) {
          assert.equal(error, originalFailure);
          order.push('read-only-start');
          await delay(15);
          order.push('read-only-end');
          throw error;
        } finally {
          release();
        }
      })();
      return await inner;
    }),
    (error) => error === originalFailure,
  );
  await assert.rejects(
    nestedGuard.run(() => {
      nestedSends++;
    }),
    (error) => error === originalFailure,
  );
  const nestedCleanup = await gate.beforeShutdown(nestedGuard.reason, nestedGuard.deadlineAtMs);
  order.push('owned-close');
  await assert.rejects(inner, (error) => error === originalFailure);
  assert.equal(nestedCleanup.method, 'bounded-read-only-evidence-complete');
  assert.deepEqual(order, ['read-only-start', 'read-only-end', 'owned-close']);
  assert.equal(nestedSends, 1);
  assert.equal(nestedGuard.reason, originalFailure);
  nestedGuard.dispose();
  for (const reason of [
    'input timed out after 750 ms',
    'Benchmark wall-clock budget exceeded',
    'Concurrent benchmark input rejected',
  ]) {
    const forced = createFailureEvidenceGate({ graceMs: 100 });
    const release = forced.begin();
    assert.equal(
      (await forced.beforeShutdown(new Error(reason))).method,
      'immediate-owned-shutdown',
    );
    release();
  }
  const hungCleanup = createFailureEvidenceGate({ graceMs: 15 });
  const releaseHung = hungCleanup.begin();
  assert.equal(
    (await hungCleanup.beforeShutdown(originalFailure)).method,
    'evidence-grace-exhausted-owned-shutdown',
  );
  releaseHung();
  const expired = createFailureEvidenceGate();
  const releaseExpired = expired.begin();
  assert.equal(
    (await expired.beforeShutdown(originalFailure, performance.now() - 1)).method,
    'immediate-owned-shutdown',
  );
  releaseExpired();
  const nearDeadline = createFailureEvidenceGate({ graceMs: 100 });
  const releaseNear = nearDeadline.begin();
  const clipped = await nearDeadline.beforeShutdown(originalFailure, performance.now() + 10);
  assert.equal(clipped.method, 'evidence-grace-exhausted-owned-shutdown');
  assert.ok(clipped.evidenceGraceMs <= 10);
  releaseNear();

  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-benchmark-lock-'));
  const filename = path.join(directory, 'benchmark.lock');
  try {
    const release = await acquireBenchmarkLock(filename);
    await assert.rejects(acquireBenchmarkLock(filename), /lock already exists/);
    await release();
    const releaseAgain = await acquireBenchmarkLock(filename);
    await releaseAgain();
  } finally {
    await rmdir(directory);
  }
  console.log(
    'PASS editor benchmark safety: sequential acknowledgement, overload, timeout, watchdog, concurrent-send rejection, bounded failure-evidence shutdown and exclusive lock (no browser)',
  );
}
