const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');

const credentialFile = 'cursor-credential.bin';

function credentialPath(directory) {
  return path.join(directory, credentialFile);
}

function normalizeKey(key) {
  if (typeof key !== 'string') throw new Error('Invalid Cursor API key.');
  const trimmed = key.trim();
  if (!/^[A-Za-z0-9_\-.]{20,512}$/.test(trimmed)) throw new Error('Invalid Cursor API key.');
  return trimmed;
}

function statusOf(key) {
  return { configured: true, suffix: key.slice(-4) };
}

function createCursorCredentialStore({ directory, safeStorage, filesystem = fs }) {
  const file = credentialPath(directory);
  const encryption = () => {
    if (typeof safeStorage?.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable())
      throw new Error('Cursor API key encryption is unavailable.');
  };
  return {
    file,
    async status() {
      let bytes;
      try {
        bytes = await filesystem.readFile(file);
      } catch (error) {
        if (error.code === 'ENOENT') return { configured: false };
        throw error;
      }
      encryption();
      let key;
      try {
        key = normalizeKey(safeStorage.decryptString(bytes));
      } catch (error) {
        if (error.message === 'Invalid Cursor API key.') throw error;
        throw new Error('Cursor API key could not be decrypted.');
      }
      return statusOf(key);
    },
    async read() {
      const current = await this.status();
      if (!current.configured) throw new Error('Cursor API key is not configured.');
      encryption();
      return normalizeKey(safeStorage.decryptString(await filesystem.readFile(file)));
    },
    async write(key) {
      encryption();
      const normalized = normalizeKey(key);
      const bytes = safeStorage.encryptString(normalized);
      if (!Buffer.isBuffer(bytes) || bytes.length === 0)
        throw new Error('Cursor API key encryption is unavailable.');
      const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
      const handle = await filesystem.open(temp, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      try {
        await filesystem.rename(temp, file);
      } catch (error) {
        await filesystem.unlink(temp).catch(() => {});
        throw error;
      }
      return statusOf(normalized);
    },
    async remove() {
      try {
        await filesystem.unlink(file);
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('Cursor API key is not configured.');
        throw error;
      }
      return { configured: false };
    },
  };
}

function registerCursorCredential({ ipcMain, authorize, store }) {
  ipcMain.handle('openpe:cursor-credential-status', (event) => {
    authorize(event);
    return store.status();
  });
  ipcMain.handle('openpe:cursor-credential-store', (event, key) => {
    authorize(event);
    return store.write(key);
  });
  ipcMain.handle('openpe:cursor-credential-remove', (event) => {
    authorize(event);
    return store.remove();
  });
}

module.exports = {
  credentialFile,
  createCursorCredentialStore,
  registerCursorCredential,
};
