import assert from 'node:assert/strict';
import test from 'node:test';
import { writeWorkspaceRecovery } from '../lib/bridge';

function installWindow(openpe: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { openpe } });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  };
}

test('native recovery forwards the encoded snapshot and waits for its durable completion', async (t) => {
  const calls: (string | null)[] = [];
  let release!: () => void;
  const durable = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restore = installWindow({
    writeWorkspaceRecovery: (content: string | null) => {
      calls.push(content);
      return content === null ? Promise.resolve() : durable;
    },
    connection: () => {
      throw new Error('Native recovery must not need HTTP connection details.');
    },
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected HTTP fallback.');
  });
  try {
    const source = '{"version":2,"documents":[],"example":"unchanged \\u4e2d"}';
    let completed = false;
    const pending = writeWorkspaceRecovery(source).then(() => {
      completed = true;
    });
    await Promise.resolve();
    assert.deepEqual(calls, [source]);
    assert.equal(completed, false);
    release();
    await pending;
    assert.equal(completed, true);
    await writeWorkspaceRecovery(null);
    assert.deepEqual(calls, [source, null]);
  } finally {
    release();
    restore();
  }
});

test('a rejected or synchronously failing native recovery never retries through HTTP', async (t) => {
  const failure = new Error('Recovery write failed; retry remains available.');
  let synchronously = false;
  const restore = installWindow({
    writeWorkspaceRecovery: () => {
      if (synchronously) throw failure;
      return Promise.reject(failure);
    },
    connection: () => {
      throw new Error('Unexpected service connection.');
    },
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected HTTP retry.');
  });
  try {
    await assert.rejects(writeWorkspaceRecovery('{}'), (error) => error === failure);
    synchronously = true;
    await assert.rejects(writeWorkspaceRecovery(null), (error) => error === failure);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    restore();
  }
});

test('recovery requires the current native bridge and never falls back to HTTP', async (t) => {
  let connections = 0;
  const restore = installWindow({
    connection: async () => {
      connections++;
      return { base: 'http://127.0.0.1:12345', token: 'fixture-token' };
    },
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected HTTP fallback.');
  });
  try {
    await assert.rejects(writeWorkspaceRecovery('{}'), TypeError);
    await assert.rejects(writeWorkspaceRecovery(null), TypeError);
    assert.equal(connections, 0);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    restore();
  }
  const restoreBrowser = installWindow(undefined);
  try {
    await assert.rejects(writeWorkspaceRecovery('{}'), /Electron desktop app/);
  } finally {
    restoreBrowser();
  }
});
