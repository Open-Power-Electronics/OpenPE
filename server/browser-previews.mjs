import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createModelCadPreviewService } from './model-cad-kernel.mjs';
import { createLibraryService, createStepParserPool } from './libraries.mjs';
import { libraryAssetFailure } from './library-asset-error.mjs';
import { isLibraryPriceRequest } from './library-prices.mjs';
import { createWorkbenchPlugins, registerWorkbenchPlugins } from './workbench-plugins.mjs';

import {
  createPcbDesignGuidance,
  registerPcbDesignGuidance,
} from '../plugins/pe-layout-skill/host/guidance.mjs';
import { registerSpice } from '../plugins/spice-simulation/host/spice.mjs';
import { registerThermal } from '../plugins/layout-thermal/host/thermal.mjs';
import { createPluginService, registerPlugins } from './plugins.mjs';

function browserProviderPlugins() {
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  const dataDir = process.env.OPENPE_DATA_DIR || path.join(appData, 'OpenPE');
  const cwd = path.join(dataDir, 'agent-workspace');
  const service = createPluginService(cwd, { dataDir });
  return {
    async list(...args) {
      await mkdir(cwd, { recursive: true });
      return service.list(...args);
    },
    async change(...args) {
      await mkdir(cwd, { recursive: true });
      return service.change(...args);
    },
  };
}

function mountBrowserPlugins(app, providerService) {
  const router = express.Router();
  const plugins = createWorkbenchPlugins(null);
  const guidance = createPcbDesignGuidance(plugins);
  const simulations = registerSpice(
    router,
    undefined,
    undefined,
    fileURLToPath(new URL('../.openpe/example-model-preparation/', import.meta.url)),
    async () => {
      throw new Error('Prepare the required SPICE model before running in the browser.');
    },
    undefined,
    plugins,
    undefined,
    undefined,
    undefined,
    fileURLToPath(new URL('../resources/example-catalog/simulation/models/', import.meta.url)),
  );
  const thermal = registerThermal(router, { plugins });
  registerWorkbenchPlugins(router, plugins);
  registerPcbDesignGuidance(router, guidance, plugins);
  const providerPlugins = registerPlugins(router, undefined, { service: providerService });
  const endpoints = new Map([
    ['catalog', ['GET', '/api/workbench-plugins']],
    ['change', ['POST', '/api/workbench-plugins']],
    ['guide', ['GET', '/api/pcb-design/guide']],
    ['spice-status', ['GET', '/api/simulation/status']],
    ['spice-run', ['POST', '/api/simulation/transient']],
    ['thermal-status', ['GET', '/api/thermal/status']],
    ['thermal-run', ['POST', '/api/thermal/run']],
    ['provider-list', ['GET', '/api/plugins']],
    ['provider-change', ['POST', '/api/plugins']],
  ]);
  app.post('/api/browser-preview/plugin/:action', (req, res, next) => {
    const endpoint = endpoints.get(req.params.action);
    if (!endpoint) return next();
    const [method, route] = endpoint;
    const search = new URL(req.originalUrl, 'http://127.0.0.1').search;
    if (search && req.params.action !== 'guide' && req.params.action !== 'provider-list')
      return res.status(400).json({ error: 'Plugin endpoint does not accept query parameters.' });
    const running = req.params.action === 'spice-run' || req.params.action === 'thermal-run';
    express.json({ limit: running ? '24mb' : '1kb' })(req, res, (error) => {
      if (error) return next(error);
      if (
        (method === 'GET' &&
          (!req.body || Array.isArray(req.body) || Object.keys(req.body).length)) ||
        (running && Object.hasOwn(req.body ?? {}, 'fileId'))
      )
        return res.status(400).json({ error: 'Browser plugins do not accept this request data.' });
      req.method = method;
      req.url = route + search;
      router(req, res, next);
    });
  });
  return () => {
    thermal.close();
    simulations.close();
    guidance.close();
    providerPlugins.close();
  };
}

/** Development-only geometry previews and bundled plugins.
 * @param {{origin?: string, previewFactory?: typeof createModelCadPreviewService,
 * providerPluginService?: ReturnType<typeof createPluginService>,
 * libraryFactory?: (options: Parameters<typeof createLibraryService>[0]) =>
 * Pick<ReturnType<typeof createLibraryService>, 'request' | 'model' | 'price' | 'close'>}} [options]
 */
export async function startBrowserPreviewServer({
  origin = 'http://127.0.0.1:3000',
  previewFactory = createModelCadPreviewService,
  libraryFactory = createLibraryService,
  providerPluginService = browserProviderPlugins(),
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
  const libraries = libraryFactory({
    allowModelDownloads: false,
    stepParserPool: sharedParsers,
  });
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
  app.post('/api/browser-preview/price', express.json({ limit: '2kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isLibraryPriceRequest(req.body))
      return res.status(400).json({ error: 'Send a component ID, library kind and price source.' });
    const signal = requestSignal(res);
    try {
      const result = await libraries.price(req.body, signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(422).json(libraryAssetFailure(error));
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
        if (!res.destroyed) res.status(422).json(libraryAssetFailure(error));
      }
    });
  }
  const closePlugins = mountBrowserPlugins(app, providerPluginService);
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
    closePlugins();
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
      closePlugins();
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
