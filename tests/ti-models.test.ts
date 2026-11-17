import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTiModelStore, decodeTiModel } from '../server/ti-models.mjs';

test('TI ZIP decoder verifies the archive and model bytes before returning any content', () => {
  const bytes = Buffer.from('test model fixture');
  const name = Buffer.from('fixture.lib');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(name.length, 26);
  const archive = Buffer.concat([header, name, bytes]);
  const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
  const model = { file: 'fixture.lib', sha256: hash(archive), modelSha256: hash(bytes) };
  assert.deepEqual(decodeTiModel(archive, model), bytes);
  assert.throws(() => decodeTiModel(Buffer.concat([archive, bytes]), model), /integrity/);
  assert.throws(
    () => decodeTiModel(archive, { ...model, modelSha256: '0'.repeat(64) }),
    /verified/,
  );
});

test('TI downloader rejects unknown IDs, external redirects, oversized or changed responses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-ti-test-'));
  try {
    let calls = 0;
    const store = createTiModelStore(root, async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.org/model' },
      });
    });
    const signal = new AbortController().signal;
    for (const id of ['../model', 'lm2596-3.3', 'lm2596-12'])
      await assert.rejects(store(id, signal), /Unsupported/);
    assert.equal(calls, 0);
    await assert.rejects(store('lm2596-5', signal), /approved source/);
    assert.equal(calls, 1);
    await assert.rejects(
      createTiModelStore(root, async () => new Response('bad'))('lm2596-5', signal),
      /integrity/,
    );
    await assert.rejects(
      createTiModelStore(root, async () => new Response(new Uint8Array(131073)))(
        'lm2596-5',
        signal,
      ),
      /128 KB/,
    );
    await assert.rejects(
      createTiModelStore(root, async () => new Response(null, { status: 404 }))('lm2596-5', signal),
      /404/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
