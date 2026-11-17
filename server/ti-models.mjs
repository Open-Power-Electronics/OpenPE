import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { controllerModelSources } from './reference-model-format.mjs';
import { fetchModelResponse } from './model-download.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const limit = 128 * 1024;

// Only decode our hash-pinned TI archives. Never extract archive paths to disk.
export function decodeTiModel(archive, model) {
  if (archive.length > limit || digest(archive) !== model.sha256)
    throw new Error(
      'TI model archive changed or failed its integrity check. Update OpenPE before using this model.',
    );
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    if (flags & 9 || start + size > archive.length) break;
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (name === model.file) {
      const compressed = archive.subarray(start, start + size);
      const bytes =
        method === 0
          ? compressed
          : method === 8
            ? inflateRawSync(compressed, { maxOutputLength: limit })
            : null;
      if (!bytes || digest(bytes) !== model.modelSha256) break;
      return bytes;
    }
    offset = start + size;
  }
  throw new Error('TI archive does not contain the verified simulation model.');
}

async function download(model, signal, fetcher) {
  let url = `https://www.ti.com/lit/zip/${model.archive}`;
  for (let redirects = 0; redirects < 5; redirects++) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.hostname !== 'www.ti.com' ||
      target.port ||
      target.username ||
      target.password
    )
      throw new Error('TI model download redirected outside the approved source.');
    const response = await fetchModelResponse(fetcher, url, { signal, redirect: 'manual' }, 'TI');
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `TI model download failed (${response.status}). Check your connection and retry.`,
      );
    }
    if (!response.body) break;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('TI model download exceeded 128 KB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('TI model download returned an invalid response.');
}

export function createTiModelStore(dataDir, fetcher = fetch) {
  return async (id, signal) => {
    const model = controllerModelSources.find((item) => item.id === id);
    if (!model) throw new Error('Unsupported TI simulation model.');
    const directory = path.join(dataDir, 'ti-models');
    const file = path.join(directory, `${model.archive}-${model.sha256}.zip`);
    let archive;
    try {
      if ((await stat(file)).size <= limit) archive = await readFile(file);
      if (archive) {
        const bytes = decodeTiModel(archive, model);
        signal.throwIfAborted();
        return bytes;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // A stale/corrupt cache never reaches the solver. Recover from the official source.
    }
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    archive = await download(model, boundedSignal, fetcher);
    const bytes = decodeTiModel(archive, model);
    boundedSignal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, archive);
      boundedSignal.throwIfAborted();
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return bytes;
  };
}
