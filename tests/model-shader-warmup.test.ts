import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareModelShaders } from '../lib/model-shader-warmup';

test('successful shader preparation retains the renderer and removes its cancellation listener', async () => {
  const control = new AbortController();
  let disposed = 0;
  await prepareModelShaders({
    compile: async () => {},
    dispose: () => disposed++,
    signal: control.signal,
  });
  control.abort();
  assert.equal(disposed, 0, 'Scene ownership retains cleanup after a successful preparation.');
});

test('cancelling pending shader preparation disposes once and allows its native polling promise to settle', async () => {
  const control = new AbortController();
  let disposed = 0,
    polling = true,
    checks = 0;
  const native = new Promise<void>((resolve) => {
    const check = () => {
      if (!polling) {
        resolve();
        return;
      }
      checks++;
      setTimeout(check, 1);
    };
    check();
  });
  const pending = prepareModelShaders({
    compile: () => native,
    dispose: () => {
      disposed++;
      polling = false;
    },
    signal: control.signal,
  });
  control.abort();
  await assert.rejects(pending, /Preview cancelled/);
  await native;
  const stopped = checks;
  await new Promise((resolve) => setTimeout(resolve, 4));
  assert.equal(checks, stopped);
  assert.equal(disposed, 1);
});

test('shader preparation has a finite failure path even if a driver never reports completion', async () => {
  let disposed = 0;
  let complete!: () => void;
  const native = new Promise<void>((resolve) => {
    complete = resolve;
  });
  await assert.rejects(
    prepareModelShaders({
      compile: () => native,
      dispose: () => disposed++,
      signal: new AbortController().signal,
      timeoutMs: 5,
    }),
    /timed out.*Retry/,
  );
  assert.equal(disposed, 1);
  complete();
  await native;
  assert.equal(
    disposed,
    1,
    'Late completion cannot dispose again or restore a cancelled preparation.',
  );
});

test('already cancelled and failed shader preparations never publish a usable renderer', async () => {
  const control = new AbortController();
  control.abort();
  let compiled = 0,
    disposed = 0;
  await assert.rejects(
    prepareModelShaders({
      compile: async () => {
        compiled++;
      },
      dispose: () => disposed++,
      signal: control.signal,
    }),
    /cancelled/,
  );
  assert.equal(compiled, 0);
  assert.equal(disposed, 1);
  await assert.rejects(
    prepareModelShaders({
      compile: async () => {
        throw new Error('Shader compile failed');
      },
      dispose: () => disposed++,
      signal: new AbortController().signal,
    }),
    /Shader compile failed/,
  );
  assert.equal(disposed, 2);
});
