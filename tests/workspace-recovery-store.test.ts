import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createWorkspaceRecoveryStore,
  maxWorkspaceRecoveryBytes,
  workspaceFilename,
} from '../server/workspace-storage.mjs';
import { atomicWrite } from '../server/atomic-write.mjs';
import { startServer } from '../server/index.mjs';
import { createProject, serializeProject } from '../lib/project';
import { createSession } from '../lib/chat-sessions';
import { defaultAgentPreferences } from '../lib/workspace-state';

function workspace(source = serializeProject(createProject())) {
  const session = createSession();
  const document = {
    id: crypto.randomUUID(),
    source,
    sourceDraft: '{unfinished',
    dirty: true,
    filename: 'project.kicad_pro',
    sessions: [session],
    activeSessionId: session.id,
  };
  return {
    version: 2,
    documents: [document],
    activeDocumentId: document.id,
    ...defaultAgentPreferences,
  };
}

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-recovery-store-'));
  try {
    await run(directory);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('openpe-recovery-store-'));
    await rm(directory, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('encoded, parsed, reads and clear share one recovery queue with durable acknowledgements', () =>
  temporary(async (directory) => {
    const first = workspace(),
      second = workspace(first.documents[0].source),
      last = workspace(first.documents[0].source);
    const gate = deferred(),
      entered = deferred();
    const writes: string[] = [];
    const store = createWorkspaceRecoveryStore(directory, {
      write: async (file: string, content: string) => {
        assert.equal(file, path.join(directory, workspaceFilename));
        writes.push(content);
        if (writes.length === 1) {
          entered.resolve();
          await gate.promise;
        }
        await atomicWrite(file, content);
      },
    });
    await writeFile(path.join(directory, 'workspace.json'), '{retired}');
    let acknowledged = false;
    const initial = store.writeEncoded(JSON.stringify(first)).then(() => {
      acknowledged = true;
    });
    const readFirst = store.read();
    const changed = store.writeParsed(second);
    const cleared = store.clear();
    const readClear = store.read();
    const final = store.writeEncoded(JSON.stringify(last));
    await entered.promise;
    assert.equal(acknowledged, false);
    assert.equal(writes.length, 1);
    gate.resolve();
    assert.equal(await initial, undefined);
    assert.deepEqual(await readFirst, first);
    assert.equal(await changed, undefined);
    assert.equal(await cleared, undefined);
    assert.equal(await readClear, null);
    assert.equal(await final, undefined);
    assert.equal(await store.settle(), undefined);
    assert.deepEqual(
      writes.map((content) => JSON.parse(content)),
      [first, second, null, last],
    );
    assert.equal(
      await readFile(path.join(directory, workspaceFilename), 'utf8'),
      JSON.stringify(last),
    );
    await assert.rejects(stat(path.join(directory, 'workspace.json')), { code: 'ENOENT' });
  }));

test('invalid encoded recovery never enters or corrupts an already accepted write', () =>
  temporary(async (directory) => {
    const payload = workspace();
    const gate = deferred(),
      entered = deferred();
    let calls = 0;
    const store = createWorkspaceRecoveryStore(directory, {
      write: async (file: string, content: string) => {
        calls++;
        entered.resolve();
        await gate.promise;
        await atomicWrite(file, content);
      },
    });
    const pending = store.writeParsed(payload);
    await entered.promise;
    for (const encoded of ['null', '{broken', JSON.stringify(workspace('{bad source'))])
      assert.throws(() => store.writeEncoded(encoded));
    assert.throws(
      () => store.writeParsed({ ...payload, appearance: {} }),
      /Unsupported workspace recovery field/,
    );
    for (const field of ['fileId', 'destination', 'ordinaryFileDrafts', 'simulationResult'])
      assert.throws(
        () =>
          store.writeEncoded(
            JSON.stringify({
              ...payload,
              documents: [{ ...payload.documents[0], [field]: 'private' }],
            }),
          ),
        /Unsupported project recovery field/,
      );
    assert.throws(() => store.writeEncoded({}), /encoded JSON/);
    assert.equal(calls, 1);
    gate.resolve();
    await pending;
    assert.deepEqual(await store.read(), payload);
  }));

test('encoded recovery keeps both character and UTF-8 envelope bounds before parsing', () =>
  temporary(async (directory) => {
    const payload = workspace();
    payload.documents[0].sourceDraft = 'é'.repeat(32);
    const encoded = JSON.stringify(payload);
    assert.ok(Buffer.byteLength(encoded, 'utf8') > encoded.length);
    let writes = 0;
    const store = createWorkspaceRecoveryStore(directory, {
      maxBytes: encoded.length,
      write: async () => {
        writes++;
      },
    });
    assert.throws(() => store.writeEncoded(encoded), /size limit/);
    assert.throws(() => store.writeEncoded('x'.repeat(encoded.length + 1)), /size limit/);
    assert.equal(writes, 0);
    assert.equal(await store.settle(), undefined);
    assert.throws(() =>
      createWorkspaceRecoveryStore(directory, { maxBytes: maxWorkspaceRecoveryBytes + 1 }),
    );
    assert.throws(() => createWorkspaceRecoveryStore(directory, { maxBytes: 0 }));
  }));

test('canonical recovery output cannot exceed the limit after raw surrogate input expands', () =>
  temporary(async (directory) => {
    const payload = workspace();
    const encoded = JSON.stringify(payload).replace('{unfinished', '\ud800'.repeat(16));
    const canonical = JSON.stringify(JSON.parse(encoded));
    const limit = Buffer.byteLength(encoded, 'utf8');
    assert.ok(Buffer.byteLength(canonical, 'utf8') > limit);
    let writes = 0;
    const store = createWorkspaceRecoveryStore(directory, {
      maxBytes: limit,
      write: async () => {
        writes++;
      },
    });
    assert.throws(() => store.writeEncoded(encoded), /size limit/);
    assert.equal(writes, 0);
    assert.equal(await store.settle(), undefined);
  }));

test('failed recovery writes preserve the previous file, propagate and allow later retries', () =>
  temporary(async (directory) => {
    const before = workspace(),
      after = workspace(before.documents[0].source);
    const file = path.join(directory, workspaceFilename);
    const bytes = JSON.stringify(before);
    await writeFile(file, bytes);
    let fail = true;
    const store = createWorkspaceRecoveryStore(directory, {
      write: async (target: string, content: string) => {
        if (fail) {
          fail = false;
          throw new Error('replacement failed');
        }
        await atomicWrite(target, content);
      },
    });
    await assert.rejects(store.writeParsed(after), /replacement failed/);
    await assert.rejects(store.settle(), /replacement failed/);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.deepEqual(await store.read(), before);
    await store.writeEncoded(JSON.stringify(after));
    assert.deepEqual(await store.read(), after);
    await store.clear();
    assert.equal(await store.read(), null);
  }));

test('the native writer and authenticated HTTP state routes use the same store and canonical bytes', () =>
  temporary(async (directory) => {
    const service = await startServer({ dataDir: directory });
    const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
    const first = workspace(),
      second = workspace(first.documents[0].source);
    try {
      const native = service.writeWorkspaceRecovery(JSON.stringify(first, null, 2));
      const observed = fetch(service.base + '/api/state', { headers });
      assert.equal(await native, undefined);
      assert.deepEqual(await (await observed).json(), first);
      assert.equal(
        await readFile(path.join(directory, workspaceFilename), 'utf8'),
        JSON.stringify(first),
      );
      const posted = await fetch(service.base + '/api/state', {
        method: 'POST',
        headers,
        body: JSON.stringify(second),
      });
      assert.equal(posted.status, 200);
      assert.deepEqual(await posted.json(), { ok: true });
      assert.deepEqual(
        await (await fetch(service.base + '/api/state', { headers })).json(),
        second,
      );
      assert.throws(() => service.writeWorkspaceRecovery('null'));
      assert.equal(await service.writeWorkspaceRecovery(null), undefined);
      assert.equal(await (await fetch(service.base + '/api/state', { headers })).json(), null);
      assert.equal((await fetch(service.base + '/api/state')).status, 401);
      assert.equal(
        (
          await fetch(service.base + '/api/state', {
            method: 'POST',
            headers: { ...headers, Origin: 'https://foreign.example' },
            body: JSON.stringify(first),
          })
        ).status,
        403,
      );
      assert.equal(await (await fetch(service.base + '/api/state', { headers })).json(), null);
    } finally {
      service.close();
    }
  }));
