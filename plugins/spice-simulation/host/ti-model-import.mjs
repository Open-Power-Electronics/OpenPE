import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { atomicWrite } from '../../../server/atomic-write.mjs';
import { assertContainedPath, canonicalDirectory } from '../../../server/host-path.cjs';
import { downloadTiModelArchive } from '../../../server/ti-models.mjs';
import {
  MAX_MODEL_BYTES,
  importedTiPath,
  inspectSpiceModelLibrary,
} from './spice-model-declarations.cjs';

const archiveLimit = 8 * 1024 * 1024;
const safeMember = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,95})\.(?:lib|mod|cir|sp|spice)$/i;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cacheName = (dataDir) => path.join(dataDir, 'ti-model-imports');
const message = 'Use a regular TI model file inside its model directory.';

export class TiEncryptedModelError extends Error {
  constructor() {
    super('This TI package contains encrypted models. Choose an unencrypted package.');
    this.code = 'OPENPE_TI_MODEL_ENCRYPTED';
  }
}

export function importedTiModelPath(file) {
  return typeof file === 'string' && importedTiPath.test(file);
}

export function verifyImportedTiModel(file, bytes) {
  if (
    !bytes.length ||
    bytes.length > MAX_MODEL_BYTES ||
    digest(bytes) !== importedTiPath.exec(file)?.[1]
  )
    throw new Error(
      `The TI model file ${path.posix.basename(file)} has changed. Restore its original bytes.`,
    );
  return bytes;
}

export async function readImportedTiModel(file, directory, cached = false) {
  const match = importedTiPath.exec(file);
  if (!match) return null;
  try {
    const root = await canonicalDirectory(directory, { message });
    const full = await assertContainedPath(
      root,
      path.join(root.canonical, cached ? `${match[1]}.lib` : file),
      { message, kind: 'file' },
    );
    const handle = await open(full, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || !info.size || info.size > MAX_MODEL_BYTES)
        throw new Error('Choose a nonempty TI model library up to 2 MiB.');
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      await assertContainedPath(root, full, { message, kind: 'file' });
      return verifyImportedTiModel(file, bytes.subarray(0, length));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readCachedTiImport(dataDir, file) {
  return readImportedTiModel(file, cacheName(dataDir), true);
}

async function stageTiImport(dataDir, file, bytes, signal) {
  const directory = cacheName(dataDir);
  await mkdir(directory, { recursive: true });
  if (await readCachedTiImport(dataDir, file)) return;
  const root = await canonicalDirectory(directory, { message });
  const target = path.join(root.canonical, `${digest(bytes)}.lib`);
  await atomicWrite(target, bytes, async () => {
    signal.throwIfAborted();
    await assertContainedPath(root, target, { message, kind: 'file', allowMissing: true });
    await readCachedTiImport(dataDir, file);
  });
}

function tiZipDirectory(bytes) {
  const end = bytes.length - 23;
  // Some TI archives append 0xff after an otherwise complete ZIP directory.
  if (
    end >= 0 &&
    bytes.at(-1) === 0xff &&
    bytes.readUInt32LE(end) === 0x06054b50 &&
    bytes.readUInt16LE(end + 20) === 0 &&
    bytes.readUInt32LE(end + 12) + bytes.readUInt32LE(end + 16) === end
  )
    return bytes.subarray(0, -1);
  return bytes;
}

async function readZipMember(zip, entry, signal) {
  const stream = await zip.openReadStreamPromise(entry);
  const abort = () => stream.destroy(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_MODEL_BYTES) throw new Error('A TI library exceeds 2 MiB.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32)
      throw new Error('A TI library failed its ZIP integrity check.');
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy();
  }
}

export async function importTiModelArchive(dataDir, archive, fetcher, signal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const bytes = await downloadTiModelArchive(archive, deadline, fetcher, archiveLimit);
  const zip = await yauzl
    .fromBufferPromise(tiZipDirectory(bytes), { strictFileNames: true })
    .catch(() => {
      throw new Error('TI did not return a supported ZIP archive.');
    });
  const files = new Map();
  let encrypted = false;
  try {
    if (zip.entryCount > 1024) throw new Error('The TI ZIP archive has too many entries.');
    let expanded = 0;
    let declarations = 0;
    for await (const entry of zip.eachEntry()) {
      deadline.throwIfAborted();
      const leaf = safeMember.exec(path.posix.basename(entry.fileName));
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (
        !leaf ||
        entry.fileName.endsWith('/') ||
        (fileType && fileType !== 0x8000) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(leaf[1]) ||
        !entry.uncompressedSize ||
        entry.uncompressedSize > MAX_MODEL_BYTES
      )
        continue;
      if (entry.isEncrypted()) {
        encrypted = true;
        continue;
      }
      expanded += entry.uncompressedSize;
      if (expanded > archiveLimit || files.size >= 16)
        throw new Error('The TI ZIP archive exceeds the supported model limits.');
      const model = await readZipMember(zip, entry, deadline);
      const text = model.toString('latin1');
      if (/^\s*(?:\$CDNENC(?:START|END)\b|\.(?:protect|unprotect|encrypted)\b)/im.test(text)) {
        encrypted = true;
        continue;
      }
      if (/^\s*\.(?:include|inc|lib|control)\b/im.test(text)) continue;
      let catalog;
      const file = `models/ti/${digest(model)}/${leaf[1]}.lib`;
      const key = file.toLowerCase();
      if (files.has(key)) continue;
      try {
        catalog = inspectSpiceModelLibrary(model, file);
      } catch {
        continue;
      }
      if (!catalog.models.length) continue;
      declarations += catalog.models.length;
      if (declarations > 256)
        throw new Error('The TI ZIP archive contains more than 256 model choices.');
      files.set(key, { file, model, catalog });
    }
  } finally {
    zip.close();
  }
  if (!files.size) {
    if (encrypted) throw new TiEncryptedModelError();
    throw new Error('The TI ZIP contains no supported standalone unencrypted SPICE libraries.');
  }
  for (const { file, model } of files.values()) await stageTiImport(dataDir, file, model, deadline);
  return [...files.values()].map(({ file, catalog }) => ({ path: file, ...catalog }));
}
