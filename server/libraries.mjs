import { Worker } from 'node:worker_threads';
import { mkdir, readFile, writeFile, rename, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleFootprintDetail, exampleModelBytes } from './example-footprints.mjs';
import { appendEmcFootprintModels } from './emc-flyback-assets.mjs';
import { createNextPcbLibrary } from './nextpcb-library.mjs';
import { createJlcpcbLibrary } from './jlcpcb-library.mjs';
import { isOnlineLibrary, librarySources, onlineFootprintLibrary } from './library-format.mjs';
import {
  officialModelRelativePath,
  validateOfficialModelPath,
} from './library-model-reference.mjs';

const LIBRARY_VERSION = '10.0.0';

// Keep the parser warm between serialized board requests without retaining an
// unbounded WASM heap or occupying the chooser's second conversion slot.
export function createStepParserPool({
  createWorker = () =>
    new Worker(new URL('./step-worker.mjs', import.meta.url), {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    }),
  timeoutMs = 45000,
  idleMs = 30000,
  maxJobs = 32,
  maxHeapBytes = 128 * 1024 * 1024,
} = {}) {
  const parsers = new Set();
  let closed = false,
    serial = 0;
  function retire(parser) {
    if (parser.retired) return;
    parser.retired = true;
    clearTimeout(parser.idleTimer);
    parsers.delete(parser);
    void parser.worker.terminate();
  }
  function acquire() {
    const available = [...parsers].find((parser) => !parser.pending);
    if (available) return available;
    if (parsers.size >= 2) throw new Error('Two 3D previews are loading. Try again shortly.');
    const parser = {
      worker: createWorker(),
      pending: null,
      idleTimer: undefined,
      jobs: 0,
      retired: false,
    };
    parsers.add(parser);
    parser.worker.on('message', (result) => {
      const pending = parser.pending;
      if (!pending || result.requestId !== pending.requestId) {
        pending?.finish(new Error('The STEP parser returned an unexpected result.'));
        retire(parser);
        return;
      }
      pending.finish(result.error ? new Error(result.error) : null, result);
    });
    parser.worker.on('error', (error) => {
      parser.pending?.finish(error);
      retire(parser);
    });
    parser.worker.on('exit', () => {
      parser.pending?.finish(new Error('The STEP parser stopped before conversion completed.'));
      retire(parser);
    });
    return parser;
  }
  return {
    run(bytes, signal) {
      if (closed || signal?.aborted) return Promise.reject(new Error('Preview cancelled.'));
      let parser;
      try {
        parser = acquire();
      } catch (error) {
        return Promise.reject(error);
      }
      clearTimeout(parser.idleTimer);
      return new Promise((resolve, reject) => {
        const requestId = ++serial;
        const finish = (error, result) => {
          if (parser.pending?.requestId !== requestId) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          parser.pending = null;
          parser.jobs++;
          if (error || parser.jobs >= maxJobs || result.heapBytes > maxHeapBytes) retire(parser);
          else {
            parser.idleTimer = setTimeout(() => retire(parser), idleMs);
            parser.idleTimer.unref?.();
          }
          error ? reject(error) : resolve({ meshes: result.meshes });
        };
        const abort = () => finish(new Error('Preview cancelled.'));
        const timer = setTimeout(() => finish(new Error('3D preview timed out.')), timeoutMs);
        parser.pending = { requestId, finish };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        try {
          parser.worker.postMessage({ requestId, bytes });
        } catch (error) {
          finish(error);
        }
      });
    },
    close() {
      closed = true;
      for (const parser of parsers) {
        parser.pending?.finish(new Error('Preview cancelled.'));
        retire(parser);
      }
    },
  };
}

/** @param {{root?: string, dataDir?: string, allowModelDownloads?: boolean,
 * stepParserPool?: ReturnType<typeof createStepParserPool>, nextpcbFetcher?: typeof fetch,
 * modelFetcher?: typeof fetch, jlcpcbFetcher?: typeof fetch}} options */
export function createLibraryService({
  root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../resources/kicad',
    LIBRARY_VERSION,
  ),
  dataDir,
  allowModelDownloads = true,
  stepParserPool,
  nextpcbFetcher,
  jlcpcbFetcher,
  modelFetcher = fetch,
}) {
  let worker,
    serial = 0,
    closed = false,
    modelJobs = 0;
  const pending = new Map(),
    downloads = new Map();
  const stepParsers = stepParserPool ?? createStepParserPool();
  const shutdown = new AbortController();
  const nextpcb = createNextPcbLibrary({ fetcher: nextpcbFetcher });
  const jlcpcb = createJlcpcbLibrary({ fetcher: jlcpcbFetcher });
  const online = { NextPCB: nextpcb, JLCPCB: jlcpcb };
  /** @param {{signal?: AbortSignal, [key: string]: any}} input */
  function request({ signal, ...message }) {
    if (closed) return Promise.reject(new Error('Library service closed.'));
    if (message.action === 'categories') {
      if (
        !librarySources.includes(message.source) ||
        !['symbols', 'footprints'].includes(message.kind)
      )
        return Promise.reject(new Error('Choose a supported library source and kind.'));
      if (isOnlineLibrary(message.source))
        return online[message.source].request({ ...message, signal });
      return workerRequest({ action: 'search', kind: message.kind }).then(({ libraries }) => ({
        categories: [...libraries]
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ id: name, name, children: [] })),
      }));
    }
    if (message.category && !isOnlineLibrary(message.library))
      return Promise.reject(new Error('Category IDs apply only to online library searches.'));
    const provider =
      message.action === 'detail'
        ? onlineFootprintLibrary(message.id ?? '')
        : message.action === 'search' && isOnlineLibrary(message.library) && message.library;
    if (provider) return online[provider].request({ ...message, signal });
    if (message.action === 'detail' && message.kind === 'footprints')
      return exampleFootprintDetail(message.id).then(async (detail) =>
        appendEmcFootprintModels(message.id, detail ?? (await workerRequest(message))),
      );
    return workerRequest(message);
  }
  function workerRequest(message) {
    if (closed) return Promise.reject(new Error('Library service closed.'));
    if (pending.size >= 64)
      return Promise.reject(new Error('Too many library requests. Try again shortly.'));
    if (!worker) {
      worker = new Worker(new URL('./library-worker.mjs', import.meta.url), {
        workerData: { root },
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      worker.on('message', ({ requestId, result, error }) => {
        const p = pending.get(requestId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(requestId);
        error ? p.reject(new Error(error)) : p.resolve(result);
      });
      worker.on('error', (error) => {
        for (const p of pending.values()) {
          clearTimeout(p.timer);
          p.reject(error);
        }
        pending.clear();
        worker = undefined;
      });
    }
    return new Promise((resolve, reject) => {
      const requestId = ++serial;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Library indexing timed out. Try again.'));
      }, 120000);
      pending.set(requestId, { resolve, reject, timer });
      worker.postMessage({ ...message, requestId });
    });
  }
  async function modelBytes(relative) {
    // Only validated official resource references, never renderer paths or URLs.
    validateOfficialModelPath(relative);
    const cache = dataDir ? path.join(dataDir, 'library-models', LIBRARY_VERSION) : undefined;
    for (const dir of [path.join(root, 'models'), ...(cache ? [cache] : [])]) {
      const file = path.join(dir, relative);
      try {
        const actual = await realpath(file),
          rel = path.relative(await realpath(dir), actual);
        if (rel.startsWith('..') || path.isAbsolute(rel))
          throw new Error('Model escapes its resource directory.');
        if ((await stat(actual)).size > 30_000_000) throw new Error('Model exceeds 30 MB.');
        return await readFile(actual);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    if (!allowModelDownloads || !cache)
      throw new Error('Prepare the bundled KiCad 3D models before previewing this package.');
    if (!downloads.has(relative))
      downloads.set(
        relative,
        (async () => {
          const url = `https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/${LIBRARY_VERSION}/${relative.split('/').map(encodeURIComponent).join('/')}`;
          const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(60000)]);
          let response;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              response = await modelFetcher(url, {
                signal,
                redirect: 'error',
                credentials: 'omit',
              });
              break;
            } catch {
              if (shutdown.signal.aborted) throw new Error('Preview cancelled.');
              if (signal.aborted)
                throw new Error(
                  '3D model download timed out. Check your internet connection and retry. The 2D footprint can still be used.',
                );
              if (attempt === 1)
                throw new Error(
                  '3D model download failed. Check your internet connection and retry. The 2D footprint can still be used.',
                );
            }
          }
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 404)
              throw new Error(
                `The linked 3D model ${relative} is not available in the official KiCad ${LIBRARY_VERSION} library. The 2D footprint can still be used.`,
              );
            throw new Error(`3D model download failed (${response.status}). Retry when online.`);
          }
          const chunks = [];
          let length = 0;
          for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 30_000_000) throw new Error('Model exceeds 30 MB.');
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          if (!bytes.subarray(0, 100).toString().includes('ISO-10303-21'))
            throw new Error('The download is not a STEP model.');
          const dest = path.join(cache, relative);
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest + '.tmp', bytes);
          await rename(dest + '.tmp', dest);
          return bytes;
        })().finally(() => downloads.delete(relative)),
      );
    return downloads.get(relative);
  }
  async function componentModelBytes(id, index, signal) {
    signal?.throwIfAborted();
    const detail = await request({ action: 'detail', kind: 'footprints', id, signal });
    const model = detail.models[index];
    if (!model) throw new Error('No model is assigned to this footprint.');
    if (id.startsWith('JLCPCB:')) {
      if (!allowModelDownloads) throw new Error('EasyEDA model downloads are disabled.');
      return jlcpcb.modelBytes(model.path, signal);
    }
    if (id.startsWith('NextPCB:') && allowModelDownloads) {
      const vendor = await nextpcb.modelBytes(id, index, signal);
      if (vendor) return vendor;
    }
    const relative = model.path
      .replace(/^\$\{KICAD\d+_3DMODEL_DIR\}\//, '')
      .replace(/^\$\{KIPRJMOD\}\/(?:(?:footprints\/)?models|footprints)\//, '')
      .replace(/\.wrl$/i, '.step');
    const bytes = (await exampleModelBytes(id, relative)) ?? (await modelBytes(relative));
    signal?.throwIfAborted();
    return bytes;
  }
  return {
    request,
    componentModelBytes,
    parseStep: (bytes, signal) => stepParsers.run(bytes, signal),
    async modelPath(reference, signal) {
      const relative = officialModelRelativePath(reference);
      return stepParsers.run(await modelBytes(relative), signal);
    },
    async model(id, index, signal) {
      if (closed || signal?.aborted) throw new Error('Preview cancelled.');
      if (modelJobs >= 2) throw new Error('Two 3D previews are loading. Try again shortly.');
      modelJobs++;
      try {
        const detail = await request({ action: 'detail', kind: 'footprints', id });
        const model = detail.models[index];
        if (!model) throw new Error('No model is assigned to this footprint.');
        const bytes = await componentModelBytes(id, index, signal);
        if (signal?.aborted || closed) throw new Error('Preview cancelled.');
        return { ...(await stepParsers.run(bytes, signal)), model };
      } finally {
        modelJobs--;
      }
    },
    close() {
      closed = true;
      shutdown.abort();
      for (const library of Object.values(online)) library.close();
      void worker?.terminate();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Library service closed.'));
      }
      pending.clear();
      if (!stepParserPool) stepParsers.close();
    },
  };
}
