import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { datasheetRecord } from './datasheet-format.mjs';

const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

function verify(bytes, record) {
  const expected = record.datasheet;
  if (
    bytes.length !== expected.bytes ||
    bytes.subarray(0, 5).toString() !== '%PDF-' ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  )
    throw new Error(
      'The PDF differs from the reviewed datasheet revision. It was not used or replaced.',
    );
  return bytes;
}

async function localPdf(file, record) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size !== record.datasheet.bytes ||
    normalize(await realpath(file)) !== normalize(path.resolve(file))
  )
    throw new Error('The local datasheet must be the reviewed regular PDF without links.');
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat(),
      current = await lstat(file);
    if (
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
        (key) => before[key] !== after[key] || before[key] !== current[key],
      )
    )
      throw new Error('The datasheet changed while reading. Try again.');
    return verify(bytes.subarray(0, length), record);
  } finally {
    await handle.close();
  }
}

export async function fetchDatasheet(record, request, signal) {
  const source = new URL(record.datasheet.source_url);
  let url = source;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const prefix = source.hostname === 'www.ti.com' ? '/lit/' : '/resource/en/datasheet/';
    if (
      url.protocol !== 'https:' ||
      url.origin !== source.origin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(prefix)
    )
      throw new Error('Datasheet redirects must stay within the pinned vendor literature origin.');
    const response = await request(url.href, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('Invalid datasheet redirect.');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body)
      throw new Error(`Datasheet download returned HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > record.datasheet.bytes)
          throw new Error('Datasheet exceeds its reviewed byte count.');
        chunks.push(value);
      }
      return verify(Buffer.concat(chunks), record);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  throw new Error('Invalid datasheet redirect.');
}

/** A cancellable worker keeps PDF parsing/rasterization off the service thread. */
export function renderDatasheetPage(bytes, page, image, pageCount, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./datasheet-worker.mjs', import.meta.url), {
      workerData: { bytes: new Uint8Array(bytes), page, image, pageCount },
      execArgv: [],
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(signal.reason ?? new Error('Datasheet read cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (result) =>
      result.error ? finish(new Error(result.error)) : finish(null, result),
    );
    worker.once('error', (error) => finish(error));
    worker.once('exit', () =>
      finish(new Error('The datasheet reader stopped before completing the page.')),
    );
    if (signal.aborted) abort();
  });
}

/** @param {{request?: typeof fetch, roots?: {examples?: string, project?: string}, render?: typeof renderDatasheetPage, resolveRecord?: typeof datasheetRecord}} [options] */
export function createDatasheetService({
  request = fetch,
  roots,
  render = renderDatasheetPage,
  resolveRecord = datasheetRecord,
} = {}) {
  const cache = new Map();
  const lifetime = new AbortController();
  let active = 0;
  async function read(exampleId, page, image, signal) {
    signal = AbortSignal.any([signal, lifetime.signal]);
    const record = resolveRecord(exampleId);
    if (!record || page > record.datasheet.page_count)
      throw new Error('Unknown datasheet or PDF page.');
    signal.throwIfAborted();
    if (active >= 2)
      throw new Error('The datasheet reader is busy. Retry after the current read finishes.');
    active++;
    try {
      let bytes = cache.get(record.example.id);
      if (!bytes) {
        const root = roots?.[record.example.id === 'emc-flyback-demo' ? 'project' : 'examples'];
        bytes = root
          ? await localPdf(
              path.join(root, record.example.file, 'datasheets', record.datasheet.filename),
              record,
            )
          : null;
        signal.throwIfAborted();
        bytes ??= await fetchDatasheet(record, request, signal);
        signal.throwIfAborted();
        cache.set(record.example.id, bytes);
        while (cache.size > 2) cache.delete(cache.keys().next().value);
      }
      const result = await render(bytes, page, image, record.datasheet.page_count, signal);
      signal.throwIfAborted();
      return { exampleId: record.example.id, document: record.datasheet, ...result };
    } finally {
      active--;
    }
  }
  return {
    close() {
      lifetime.abort(new Error('The datasheet service closed.'));
      cache.clear();
    },
    async page(input, signal) {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !['exampleId', 'page', 'image'].includes(key)) ||
        typeof input.exampleId !== 'string' ||
        !Number.isInteger(input.page) ||
        input.page < 1 ||
        (input.image !== undefined && typeof input.image !== 'boolean')
      )
        throw new Error('Choose a reviewed datasheet ID and one-based PDF page.');
      return read(input.exampleId, input.page, input.image ?? true, signal);
    },
  };
}

export function registerDatasheets(app, service) {
  app.post('/api/datasheets/page', async (req, res) => {
    const control = new AbortController();
    const closed = () => {
      if (!res.writableEnded) control.abort();
    };
    res.on('close', closed);
    try {
      const signal = AbortSignal.any([control.signal, AbortSignal.timeout(45000)]);
      const result = await service.page(req.body, signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: String(error.message).slice(0, 1000) });
    } finally {
      res.off('close', closed);
    }
  });
}
