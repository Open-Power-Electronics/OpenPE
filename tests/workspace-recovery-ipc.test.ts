import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registerWorkspaceRecovery } from '../electron/workspace-recovery.cjs';

const channel = 'openpe:workspace-recovery-write';

function register(write: (content: unknown) => Promise<void>) {
  const owner = {},
    mainFrame = {};
  let handler!: (event: unknown, content: unknown) => Promise<void>;
  registerWorkspaceRecovery({
    ipcMain: {
      handle(name: string, callback: typeof handler) {
        assert.equal(name, channel);
        handler = callback;
      },
    },
    authorize(event: { sender: unknown; senderFrame: unknown }) {
      if (event.sender !== owner || event.senderFrame !== mainFrame)
        throw new Error('Unauthorized window.');
    },
    write,
  });
  return { invoke: handler, event: { sender: owner, senderFrame: mainFrame } };
}

test('recovery IPC authorizes the exact originating window and main frame before any writer call', async () => {
  const writes: unknown[] = [];
  const { invoke, event } = register(async (content) => {
    writes.push(content);
  });
  for (const untrusted of [
    { sender: {}, senderFrame: event.senderFrame },
    { sender: event.sender, senderFrame: {} },
    { sender: {}, senderFrame: {} },
  ])
    assert.throws(() => invoke(untrusted, '{private recovery}'), /Unauthorized window/);
  assert.deepEqual(writes, []);
  assert.equal(await invoke(event, '{encoded recovery}'), undefined);
  assert.equal(await invoke(event, null), undefined);
  assert.deepEqual(writes, ['{encoded recovery}', null]);
});

test('pending quit waits for the recovery writer and failures cannot approve the close', async () => {
  let resolve!: () => void;
  const durable = new Promise<void>((done) => {
    resolve = done;
  });
  const events: string[] = [];
  const { invoke, event } = register(async () => {
    events.push('write');
    await durable;
    events.push('durable');
  });
  // Main must allow the reviewed final write while the close is pending.
  const quit = (async () => {
    await invoke(event, '{final reviewed recovery}');
    events.push('close approved');
  })();
  await Promise.resolve();
  assert.deepEqual(events, ['write']);
  resolve();
  await quit;
  assert.deepEqual(events, ['write', 'durable', 'close approved']);
  const failed = register(async () => {
    throw new Error('disk full');
  });
  await assert.rejects(
    (async () => {
      await failed.invoke(failed.event, null);
      events.push('incorrect close');
    })(),
    /disk full/,
  );
  assert.equal(events.includes('incorrect close'), false);
});

function preload(invoke: (...args: unknown[]) => Promise<unknown>) {
  const source = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const original = 'const maxRecoveryCharacters = 96 * 1024 * 1024;';
  assert.equal(source.split(original).length, 2);
  // Exercise the actual guard with a bounded private test limit, without
  // allocating a 96 MiB string for each malformed preload argument.
  const reduced = source.replace(original, 'const maxRecoveryCharacters = 64;');
  let bridge!: { writeWorkspaceRecovery(content: unknown): Promise<void> };
  vm.runInNewContext(reduced, {
    process: { platform: 'win32' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name: string, value: typeof bridge) {
            assert.equal(name, 'openpe');
            bridge = value;
          },
        },
        ipcRenderer: { invoke },
      };
    },
  });
  return bridge;
}

test('preload rejects nonencoded and oversized arguments before invoking its fixed recovery channel', async () => {
  const calls: unknown[][] = [];
  const bridge = preload(async (...args) => {
    calls.push(args);
  });
  for (const invalid of [undefined, false, 1, {}, [], 'x'.repeat(65)])
    await assert.rejects(bridge.writeWorkspaceRecovery(invalid), /Invalid encoded recovery/);
  assert.deepEqual(calls, []);
  await bridge.writeWorkspaceRecovery('{"version":2}');
  await bridge.writeWorkspaceRecovery(null);
  assert.deepEqual(calls, [
    [channel, '{"version":2}'],
    [channel, null],
  ]);
});

test('preload keeps writer acknowledgement pending and forwards failures without an HTTP retry', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  let calls = 0;
  const bridge = preload(async () => {
    calls++;
    await pending;
  });
  let acknowledged = false;
  const write = bridge.writeWorkspaceRecovery('{}').then(() => {
    acknowledged = true;
  });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  assert.equal(calls, 1);
  resolve();
  await write;
  assert.equal(acknowledged, true);
  const failed = preload(async () => {
    throw new Error('write rejected');
  });
  await assert.rejects(failed.writeWorkspaceRecovery('{}'), /write rejected/);
});
