import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAsync } from '../scripts/async-browser-test-helpers.mjs';

test('browser polling waits for resolved async truthiness and forwards the argument', async () => {
  let attempts = 0;
  const page = {
    evaluate: async (predicate: (arg: number) => Promise<boolean>, arg: number) => predicate(arg),
    waitForTimeout: async () => {},
  };
  const ready = await waitForAsync(page, async (target: number) => ++attempts === target, 3);
  assert.equal(ready, true);
  assert.equal(attempts, 3, 'A Promise resolving false must not complete the wait.');
});

test('browser polling bounds an asynchronous evaluation that never settles', async () => {
  const page = {
    evaluate: () => new Promise(() => {}),
    waitForTimeout: async () => {},
  };
  await assert.rejects(
    waitForAsync(page, () => true, undefined, { timeout: 20 }),
    /timed out/,
  );
});

test('browser polling propagates evaluation failures instead of counting them as readiness', async () => {
  const failure = new Error('The test document was replaced.');
  const page = {
    evaluate: async () => {
      throw failure;
    },
    waitForTimeout: async () => {},
  };
  await assert.rejects(
    waitForAsync(page, () => true, undefined),
    (error: unknown) => error === failure,
  );
});
