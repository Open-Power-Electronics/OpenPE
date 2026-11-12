import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCursorCredentialStore, credentialFile } = require('../electron/cursor-credential.cjs');

const key = 'cursor_test_key_value_0001';

function memoryStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(Buffer.from(value).toString('base64')),
    decryptString: (bytes: Buffer) => {
      const text = Buffer.from(bytes).toString();
      if (!/^[A-Za-z0-9+/=]+$/.test(text)) throw new Error('mac mismatch');
      return Buffer.from(text, 'base64').toString();
    },
  };
}

test('Cursor API key storage encrypts one file and reports only its suffix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-cursor-key-'));
  try {
    const store = createCursorCredentialStore({
      directory,
      safeStorage: memoryStorage(),
    });
    assert.equal(store.file, path.join(directory, credentialFile));
    assert.deepEqual(await store.status(), { configured: false });
    await assert.rejects(store.read(), /not configured/);
    await assert.rejects(store.remove(), /not configured/);
    const saved = await store.write(`  ${key}\n`);
    assert.deepEqual(saved, { configured: true, suffix: '0001' });
    assert.equal(JSON.stringify(saved).includes(key), false);
    assert.deepEqual(await store.status(), saved);
    assert.equal(await store.read(), key);
    const bytes = await readFile(store.file);
    assert.equal(bytes.includes(Buffer.from(key)), false);
    assert.equal(bytes.toString(), Buffer.from(key).toString('base64'));
    await assert.rejects(store.write('short'), /Invalid Cursor API key/);
    assert.equal(await store.read(), key);
    const unavailable = createCursorCredentialStore({
      directory: path.join(directory, 'unavailable'),
      safeStorage: memoryStorage(false),
    });
    await assert.rejects(unavailable.write(key), /encryption is unavailable/);
    await writeFile(store.file, Buffer.from('not-encrypted'));
    await assert.rejects(store.status(), /could not be decrypted/);
    await assert.rejects(store.read(), /could not be decrypted/);
    await writeFile(store.file, Buffer.from(`enc:${key}`));
    assert.deepEqual(await store.remove(), { configured: false });
    await assert.rejects(store.read(), /not configured/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
