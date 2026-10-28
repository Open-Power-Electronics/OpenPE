import path from 'node:path';
import { open } from 'node:fs/promises';
import { atomicWrite } from './atomic-write.mjs';
import { validPluginId } from './plugin-id.mjs';

// Receipts describe successful OpenPE installs, never the provider's credentials
// or authoritative installed state. Only CLI-listed plugins can use a receipt.
export function createPluginInstallations(dataDir) {
  const file = dataDir && path.join(dataDir, 'plugin-installations-v1.json');
  let tail = Promise.resolve();
  async function read() {
    if (!file) return [];
    let handle;
    try {
      handle = await open(file, 'r');
      if ((await handle.stat()).size > 1_000_000) throw new Error('Too large');
      const data = JSON.parse(await handle.readFile('utf8'));
      if (
        data.version !== 1 ||
        Object.keys(data).some((key) => !['version', 'installations'].includes(key)) ||
        !Array.isArray(data.installations) ||
        data.installations.length > 2000 ||
        data.installations.some(
          (row) =>
            !row ||
            Object.keys(row).some((key) => !['provider', 'id', 'scope'].includes(key)) ||
            !['codex', 'claude'].includes(row.provider) ||
            row.scope !== 'user' ||
            !validPluginId(row.id),
        )
      )
        throw new Error('Invalid format');
      return data.installations;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(
        'OpenPE plugin installation records could not be read. The original file was preserved.',
      );
    } finally {
      await handle?.close();
    }
  }
  return {
    read: async () => {
      await tail;
      return read();
    },
    async change(provider, id, installed, execute) {
      if (!file) throw new Error('OpenPE plugin installation storage is unavailable.');
      // Serialize the read/command/write transaction across both providers.
      const operation = tail.then(async () => {
        const rows = await read();
        const next = rows.filter(
          (row) => row.provider !== provider || row.id !== id || row.scope !== 'user',
        );
        if (installed) next.push({ provider, id, scope: 'user' });
        if (next.length > 2000) throw new Error('OpenPE plugin installation records are full.');
        await execute();
        try {
          await atomicWrite(file, JSON.stringify({ version: 1, installations: next }));
        } catch {
          throw new Error(
            'The plugin command succeeded, but OpenPE could not save its installation record. Refresh to check the plugin state.',
          );
        }
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
}
