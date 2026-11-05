import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createModelCadPreviewService } from './model-cad-kernel.mjs';
import { createLibraryService, createStepParserPool } from './libraries.mjs';

/** Development-only geometry previews. No project grants or model imports.
 * @param {{origin?: string, previewFactory?: typeof createModelCadPreviewService,
 * libraryFactory?: (options: Parameters<typeof createLibraryService>[0]) =>
 * Pick<ReturnType<typeof createLibraryService>, 'request' | 'model' | 'close'>}} [options]
 */
export async function startBrowserPreviewServer({
  origin = 'http://127.0.0.1:3000',
  previewFactory = createModelCadPreviewService,
  libraryFactory = createLibraryService,
} = {}) {
  const renderer = new URL(origin);
  if (
    renderer.origin !== origin ||
    renderer.hostname !== '127.0.0.1' ||
    renderer.protocol !== 'http:'
  )
    throw new Error('Browser previews require an exact loopback renderer origin.');
  const token = randomBytes(32).toString('hex');
  const parsers = createStepParserPool();
  // Native services already bound outstanding CAD/model work. Serialize parsing
  // so a component cannot lose its preview while two CAD solids are preparing.
  let parsing = Promise.resolve();
  const sharedParsers = {
    run(bytes, signal) {
      const result = parsing.then(() => {
        signal?.throwIfAborted();
        return parsers.run(bytes, signal);
      });
      parsing = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    close() {},
  };
  const previews = previewFactory({ parseStep: sharedParsers.run });
  const libraries = libraryFactory({ allowModelDownloads: false, stepParserPool: sharedParsers });
  const requests = new Set();
  function requestSignal(res) {
    const control = new AbortController();
    requests.add(control);
    res.on('close', () => {
      requests.delete(control);
      control.abort();
    });
    return control.signal;
  }
  const app = express();
  let host = '';
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      req.get('host') !== host ||
      req.get('origin') !== origin ||
      req.get('sec-fetch-site') !== 'same-origin' ||
      req.get('x-openpe-browser') !== 'preview'
    )
      return res.status(403).json({ error: 'Browser previews require a same-origin request.' });
    next();
  });
  app.post('/api/browser-preview/session', express.json({ limit: '1kb' }), (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length)
      return res.status(400).json({ error: 'Send an empty preview session request.' });
    res.json({ token });
  });
  app.use((req, res, next) => {
    const supplied = req.get('x-openpe-token');
    if (
      typeof supplied !== 'string' ||
      !/^[0-9a-f]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    )
      return res.status(401).json({ error: 'Browser preview session expired. Retry the preview.' });
    next();
  });
  app.post('/api/browser-preview/cad', express.json({ limit: '512kb' }), async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 ||
      !Object.hasOwn(req.body, 'object')
    )
      return res.status(400).json({ error: 'Send one bounded CAD object for preview.' });
    const signal = requestSignal(res);
    try {
      const result = await previews.preview(req.body.object, signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: String(error.message).slice(0, 4000) });
    }
  });
  for (const kind of ['footprint', 'model']) {
    app.post(`/api/browser-preview/${kind}`, express.json({ limit: '1kb' }), async (req, res) => {
      const body = req.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== (kind === 'model' ? 'id,index' : 'id') ||
        typeof body.id !== 'string' ||
        !body.id.length ||
        body.id.length > 256 ||
        (kind === 'model' &&
          (!Number.isSafeInteger(body.index) || body.index < 0 || body.index > 99))
      )
        return res
          .status(400)
          .json({ error: 'Send a library footprint ID and supported model index.' });
      const signal = requestSignal(res);
      try {
        const result =
          kind === 'model'
            ? await libraries.model(body.id, body.index, signal)
            : await libraries.request({ action: 'detail', kind: 'footprints', id: body.id });
        signal.throwIfAborted();
        if (!res.destroyed) res.json(result);
      } catch (error) {
        if (!res.destroyed) res.status(422).json({ error: String(error.message).slice(0, 4000) });
      }
    });
  }
  app.use((_req, res) => res.status(404).json({ error: 'Unknown browser preview route.' }));
  app.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({
      error: status === 413 ? 'Preview request is too large.' : 'Invalid preview request.',
    });
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  }).catch((error) => {
    previews.close();
    libraries.close();
    parsers.close();
    throw error;
  });
  host = `127.0.0.1:${server.address().port}`;
  server.unref();
  return {
    base: `http://${host}`,
    close() {
      for (const request of requests) request.abort();
      previews.close();
      libraries.close();
      parsers.close();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// Next evaluates its configuration more than once. Keep one private host per process.
const key = Symbol.for('openpe.browser-preview');
export function browserPreviewServer() {
  globalThis[key] ??= startBrowserPreviewServer()
    .then((host) => {
      process.once('exit', () => {
        void host.close();
      });
      return host;
    })
    .catch((error) => {
      delete globalThis[key];
      throw error;
    });
  return globalThis[key];
}
