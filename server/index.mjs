import {
  createRuntimePlugins,
  registerRuntimePlugins,
  readPluginPackage,
} from '../plugins/runtime/host.mjs';
import express from 'express';
import { createComponentModelStore, registerComponentModels } from './component-models.mjs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { atomicWrite } from './atomic-write.mjs';
import { createWorkspaceRecoveryStore } from './workspace-storage.mjs';
import { validateAnnotations, validateLayoutAnnotationContext } from './annotation-format.mjs';
import { validateAgentWorkspaceContext } from './agent-context-format.mjs';
import { detectAgents, runAgent, runRawAgent } from './agents.mjs';
import {
  isAgentProvider,
  isProviderReasoningEffort,
  validAgentModelId,
} from './agent-provider-format.mjs';
import { createAgentCapabilityBridge } from './agent-capabilities.mjs';
import { agentQuestions, createAgentQuestionBridge } from './agent-questions.mjs';
import { createAgentInputBridge } from './agent-input.mjs';
import { listAgentModels } from './agent-models.mjs';
import { createPluginService, registerPlugins } from './plugins.mjs';
import { createWorkbenchPlugins, registerWorkbenchPlugins } from './workbench-plugins.mjs';
import { PCB_DESIGN_PLUGIN_ID as pcbDesignPluginId } from '../plugins/catalog.mjs';
import {
  createPcbDesignGuidance,
  registerPcbDesignGuidance,
} from '../plugins/pe-layout-skill/host/guidance.mjs';
import { validCursorRequestParameters } from './agent-cursor.mjs';
import { createLibraryService } from './libraries.mjs';
import { libraryAssetFailure } from './library-asset-error.mjs';
import { isOnlineLibrary, librarySources } from './library-format.mjs';
import { registerAppearance } from './appearance.mjs';
import { registerAgentSettings } from './agent-settings.mjs';
import {
  registerSpice,
  runSimulation,
  detectSpice,
  findSimulationResult,
} from '../plugins/spice-simulation/host/spice.mjs';
import { registerThermal } from '../plugins/layout-thermal/host/thermal.mjs';
import {
  detectThermal,
  runThermalSimulation,
} from '../plugins/layout-thermal/host/thermal-runtime.mjs';
import { createModelCadPreviewService } from './model-cad-kernel.mjs';
import { createDatasheetService, registerDatasheets } from './datasheets.mjs';
import { createRawKiCadSession, rawKiCadExtensions } from './raw-kicad-chat.mjs';
export async function startServer({
  dataDir,
  staticDir = /** @type {string | undefined} */ (undefined),
  port = 0,
  devOrigin = undefined,
  agentRunner = runAgent,
  rawAgentRunner = runRawAgent,
  modelLister = listAgentModels,
  pluginServiceFactory = createPluginService,
  libraryRoot = '',
  nextpcbFetcher = fetch,
  jlcpcbFetcher = fetch,
  libraryModelFetcher = fetch,
  simulationRunner = runSimulation,
  simulationDetector = detectSpice,
  simulationResultLoader = findSimulationResult,
  simulationRoot = undefined,
  thermalRoot = undefined,
  thermalRunner = runThermalSimulation,
  thermalDetector = detectThermal,
  modelCadPreviewFactory = createModelCadPreviewService,
  datasheetFetcher = fetch,
  datasheetRoots = undefined,
  datasheetServiceFactory = createDatasheetService,
  simulationModelFetcher = fetch,
  simulationModelFiles = undefined,
  componentModelFiles = undefined,
  simulationProjectRoot = undefined,
  simulationResultFiles = /** @type {{ forProject(fileId: string): ReturnType<typeof import('./project-spice-files.mjs').createProjectSpiceStore> | null } | undefined} */ (
    undefined
  ),
  thermalResultFiles = /** @type {{ forProject(fileId: string): ReturnType<typeof import('./project-thermal-files.mjs').createProjectThermalStore> | null } | undefined} */ (
    undefined
  ),
  cursorCredential = undefined,
}) {
  await mkdir(dataDir, { recursive: true });
  const cwd = path.join(dataDir, 'agent-workspace');
  await mkdir(cwd, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const app = express();
  const libraries = createLibraryService({
    root: libraryRoot || undefined,
    dataDir,
    nextpcbFetcher,
    jlcpcbFetcher,
    modelFetcher: libraryModelFetcher,
  });
  const modelCadPreviews = modelCadPreviewFactory({ resourceRoot: thermalRoot });
  const componentModels = createComponentModelStore(dataDir, libraries.parseStep);
  let base = '';
  const active = new Map();
  const agentBridges = new Map();
  const questionBridges = new Map();
  const inputBridges = new Map();
  const apiResponses = new Set();
  const rawKiCad = createRawKiCadSession();
  const recovery = createWorkspaceRecoveryStore(dataDir);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!devOrigin)
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      );
    next();
  });
  app.use((req, res, next) => {
    if (!['127.0.0.1', 'localhost'].includes(req.hostname))
      return res.status(403).json({ error: 'Invalid host.' });
    const origin = req.get('origin');
    if (origin && origin !== base && origin !== devOrigin)
      return res.status(403).json({ error: 'Cross-origin request rejected.' });
    if (origin && origin === devOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-OpenPE-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', (req, res, next) => {
    const isRawChat = req.path === '/raw-kicad/chat' && req.method === 'POST';
    const isAgentDiscovery = req.method === 'GET' && ['/agents', '/models'].includes(req.path);
    if (rawKiCad.active() ? !isRawChat && !isAgentDiscovery : isRawChat) {
      if (req.get('x-openpe-token') !== token)
        return res.status(401).json({ error: 'Session expired. Restart OpenPE.' });
      return res.status(409).json({ error: 'This action is unavailable in the current mode.' });
    }
    apiResponses.add(res);
    res.once('close', () => apiResponses.delete(res));
    next();
  });
  // CLI adapters receive only a per-turn capability token, never the service token.
  app.post('/api/agent-tools/:bridgeId', express.json({ limit: '32mb' }), async (req, res) => {
    const bridge = agentBridges.get(req.params.bridgeId);
    if (!bridge?.authorized(req.get('x-openpe-agent-token')))
      return res.status(401).json({ error: 'Agent capability connection expired.' });
    try {
      const result = await bridge.call(req.body?.tool, req.body?.arguments);
      if (!res.destroyed) res.json({ result });
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: String(error.message).slice(0, 4000) });
    }
  });
  app.post('/api/agent-questions/:bridgeId', express.json({ limit: '256kb' }), async (req, res) => {
    const bridge = questionBridges.get(req.params.bridgeId);
    if (!bridge?.authorized(req.get('x-openpe-agent-token')))
      return res.status(401).json({ error: 'Agent question connection expired.' });
    try {
      const answers = await bridge.ask(agentQuestions(bridge.provider, req.body?.questions));
      if (!res.destroyed) res.json({ answers });
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: String(error.message).slice(0, 4000) });
    }
  });
  app.use('/api', (req, res, next) => {
    if (req.get('x-openpe-token') !== token)
      return res.status(401).json({ error: 'Session expired. Restart OpenPE.' });
    next();
  });
  // Recovery envelopes JSON-escape an already bounded project source string.
  app.use('/api/state', express.json({ limit: '96mb' }));
  // Simulation also wraps a bounded project string in a JSON request envelope.
  app.use(['/api/simulation/transient', '/api/simulation/result'], express.json({ limit: '24mb' }));
  app.use(
    ['/api/thermal/run', '/api/thermal/result', '/api/thermal/spice-sources'],
    express.json({ limit: '24mb' }),
  );
  app.use('/api/chat/tool-result', express.json({ limit: '40mb' }));
  app.use(['/api/chat/steer', '/api/agent-settings'], express.json({ limit: '128kb' }));
  app.use('/api/raw-kicad/chat', express.json({ limit: '256kb' }));
  app.use('/api/chat', express.json({ limit: '32mb' }));
  app.use('/api/model-cad/preview', express.json({ limit: '512kb' }));
  app.use('/api/component-model', express.json({ limit: '24mb' }));
  app.use('/api/runtime-plugins/run', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '8mb' }));
  app.use('/api', (_req, res, next) => {
    if (!res.destroyed) next();
  });
  registerComponentModels(app, componentModels, libraries, componentModelFiles);
  registerAppearance(app, dataDir, atomicWrite);
  registerAgentSettings(app, dataDir, atomicWrite);
  const datasheets = datasheetServiceFactory({ request: datasheetFetcher, roots: datasheetRoots });
  registerDatasheets(app, datasheets);
  const plugins = registerPlugins(app, cwd, { service: pluginServiceFactory(cwd, { dataDir }) });
  const runtimePlugins = createRuntimePlugins(dataDir);
  registerRuntimePlugins(app, runtimePlugins);
  const workbenchPlugins = createWorkbenchPlugins(dataDir, { runtime: runtimePlugins });
  registerWorkbenchPlugins(app, workbenchPlugins);
  const pcbDesign = createPcbDesignGuidance(workbenchPlugins);
  registerPcbDesignGuidance(app, pcbDesign, workbenchPlugins);
  const pcbDesignTurns = new Set();
  const unsubscribePcbDesign = workbenchPlugins.subscribe((id, state) => {
    if (id === pcbDesignPluginId && (!state.installed || !state.enabled))
      for (const control of pcbDesignTurns) control.abort();
  });
  const thermal = registerThermal(app, {
    plugins: workbenchPlugins,
    resourceRoot: thermalRoot,
    runner: thermalRunner,
    detector: thermalDetector,
    resultFiles: thermalResultFiles,
    readSpice: (body, signal) => simulations.readCompleted(body, signal),
  });
  const simulations = registerSpice(
    app,
    (deck, signal, store, onSamples, resultFiles, config) =>
      simulationRunner(deck, signal, store, simulationRoot, onSamples, resultFiles, config),
    (signal) => simulationDetector(signal, simulationRoot),
    dataDir,
    simulationModelFetcher,
    simulationModelFiles,
    workbenchPlugins,
    simulationResultFiles,
    (deck, signal, store, resultFiles) =>
      simulationResultLoader(deck, signal, store, simulationRoot, resultFiles),
    simulationProjectRoot,
  );
  app.get('/api/libraries/:kind', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['symbols', 'footprints'].includes(req.params.kind))
      return res.status(400).json({ error: 'Unknown library kind.' });
    const {
      q = '',
      library = '',
      id,
      offset = '0',
      categories,
      category = '',
      includeAssetStatus,
    } = req.query;
    const stream = req.get('accept') === 'application/x-ndjson';
    if (
      typeof q !== 'string' ||
      q.length > 200 ||
      typeof library !== 'string' ||
      library.length > 200 ||
      typeof category !== 'string' ||
      (includeAssetStatus !== undefined &&
        (includeAssetStatus !== '1' ||
          req.params.kind !== 'symbols' ||
          id !== undefined ||
          categories !== undefined)) ||
      (stream && includeAssetStatus !== '1') ||
      (category !== '' && (!/^[1-9]\d{0,9}$/.test(category) || !isOnlineLibrary(library))) ||
      (id !== undefined && !!category) ||
      (categories !== undefined &&
        (!librarySources.includes(categories) ||
          !!q ||
          !!library ||
          id !== undefined ||
          String(offset) !== '0' ||
          !!category)) ||
      (id !== undefined && (typeof id !== 'string' || id.length > 500)) ||
      !/^\d{1,6}$/.test(String(offset))
    )
      return res.status(400).json({ error: 'Invalid library query.' });
    const control = new AbortController();
    res.on('close', () => control.abort());
    if (stream) {
      res.type('application/x-ndjson');
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
    }
    try {
      const result = await libraries.request({
        action: categories ? 'categories' : id ? 'detail' : 'search',
        kind: req.params.kind,
        source: categories,
        id,
        query: q,
        library,
        category,
        offset: Number(offset),
        includeAssetStatus: includeAssetStatus === '1',
        signal: control.signal,
        ...(stream && {
          onProgress(progress) {
            if (!res.destroyed) res.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
          },
        }),
      });
      if (res.destroyed) return;
      if (stream) res.end(JSON.stringify({ type: 'result', result }) + '\n');
      else res.json(result);
    } catch (e) {
      if (res.destroyed) return;
      const error = libraryAssetFailure(e);
      if (stream) res.end(JSON.stringify({ type: 'error', ...error }) + '\n');
      else res.status(422).json(error);
    }
  });
  app.get('/api/library-price', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { id } = req.query;
    if (
      Object.keys(req.query).length !== 1 ||
      typeof id !== 'string' ||
      !id.startsWith('NextPCB:') ||
      id.length > 500
    )
      return res.status(400).json({ error: 'Send one NextPCB component ID.' });
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      const result = await libraries.price(id, control.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(422).json(libraryAssetFailure(error));
    }
  });
  app.get('/api/library-model', async (req, res) => {
    const { id, index = '0' } = req.query;
    if (typeof id !== 'string' || id.length > 500 || !/^\d{1,2}$/.test(String(index)))
      return res.status(400).json({ error: 'Invalid model request.' });
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      const result = await libraries.model(id, Number(index), control.signal);
      if (!res.destroyed) res.json(result);
    } catch (e) {
      if (!res.destroyed) res.status(422).json(libraryAssetFailure(e));
    }
  });
  app.get('/api/agents', async (_req, res) => res.json(await detectAgents({ cursorCredential })));
  app.post('/api/model-cad/preview', async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 ||
      !Object.hasOwn(req.body, 'object')
    )
      return res.status(400).json({ error: 'Send one bounded CAD object for preview.' });
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      const result = await modelCadPreviews.preview(req.body.object, control.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: String(error.message).slice(0, 4000) });
    }
  });
  app.get('/api/models', async (req, res) => {
    if (!isAgentProvider(req.query.provider))
      return res.status(400).json({ error: 'Unknown agent.' });
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      res.json(
        await modelLister(req.query.provider, cwd, control.signal, {
          cursorCredential,
          ...(rawKiCad.active() && { raw: true }),
        }),
      );
    } catch (e) {
      if (res.destroyed) return;
      const error =
        req.query.provider === 'cursor'
          ? e?.modelListDiagnostic === true
            ? e.message
            : 'Could not load Cursor models.'
          : e.message;
      res.status(502).json({ error });
    }
  });
  app.get('/api/state', async (req, res) => {
    try {
      res.json(await recovery.read());
    } catch (e) {
      if (e.code === 'ENOENT') res.json(null);
      else
        res.status(500).json({
          error: 'Could not read the saved draft. The original recovery file was preserved.',
        });
    }
  });
  app.post('/api/state', async (req, res) => {
    let write;
    try {
      write = recovery.writeParsed(req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    await write;
    res.json({ ok: true });
  });
  app.delete('/api/state', async (req, res) => {
    await recovery.clear();
    res.json({ ok: true });
  });
  app.post('/api/chat/steer', async (req, res) => {
    try {
      const bridge = inputBridges.get(req.body?.runId);
      if (!bridge) throw new Error('The originating Agent run is no longer active.');
      res.json(await bridge.submit(req.body, req.get('origin')));
    } catch (error) {
      res.status(409).json({
        error: error.message,
        ...(error.code === 'OPENPE_STEER_REJECTED' ? { code: error.code } : {}),
      });
    }
  });
  app.post('/api/chat/answer', (req, res) => {
    try {
      const bridge = questionBridges.get(req.body?.runId);
      if (!bridge) throw new Error('The originating Agent question is no longer active.');
      bridge.respond(req.body, req.get('origin'));
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });
  app.post('/api/chat/tool-result', (req, res) => {
    try {
      const bridge = agentBridges.get(req.body?.runId);
      if (!bridge)
        return res
          .status(409)
          .json({ error: 'The originating Agent request is no longer active.' });
      bridge.respond(req.body, req.get('origin'));
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });
  let rawTurn;
  app.post('/api/raw-kicad/chat', async (req, res) => {
    // Check again after asynchronous body parsing in case the mode changed.
    if (!rawKiCad.active())
      return res.status(409).json({ error: 'Enable Raw KiCad mode before sending a message.' });
    const b = req.body;
    if (
      !b ||
      typeof b !== 'object' ||
      Array.isArray(b) ||
      Object.keys(b).some(
        (key) =>
          !['selection', 'provider', 'prompt', 'history', 'model', 'effort', 'parameters'].includes(
            key,
          ),
      ) ||
      typeof b.selection !== 'string' ||
      !isAgentProvider(b.provider) ||
      typeof b.prompt !== 'string' ||
      !b.prompt.trim() ||
      b.prompt.length > 16000 ||
      (b.model !== undefined && !validAgentModelId(b.provider, b.model)) ||
      (b.effort !== undefined && !isProviderReasoningEffort(b.provider, b.effort)) ||
      (b.parameters !== undefined &&
        (b.provider !== 'cursor' || !validCursorRequestParameters(b.parameters)))
    )
      return res.status(400).json({ error: 'Invalid Raw KiCad chat request.' });
    if (rawTurn) return res.status(409).json({ error: 'An agent is already responding.' });
    let prompt;
    try {
      prompt = rawKiCad.prompt(b.selection, b.prompt, b.history);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const control = new AbortController();
    rawTurn = control;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const emit = (event) => {
      if (
        !res.destroyed &&
        !control.signal.aborted &&
        ['text-delta', 'text-replace', 'error', 'done'].includes(event.type)
      )
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n');
    }, 15000);
    res.once('close', () => control.abort());
    let outcome = 'failed';
    try {
      const result = await rawAgentRunner(
        b.provider,
        { prompt, model: b.model, effort: b.effort, parameters: b.parameters },
        emit,
        control.signal,
        { cursorCredential },
      );
      outcome = result?.outcome || 'failed';
    } catch (error) {
      emit({ type: 'error', text: error.message });
    } finally {
      if (rawTurn === control) rawTurn = undefined;
      clearInterval(heartbeat);
      emit({ type: 'done', outcome });
      res.end();
    }
  });
  app.post('/api/chat', async (req, res) => {
    if (rawKiCad.active())
      return res.status(409).json({ error: 'Workbench chat is unavailable in Raw KiCad mode.' });
    const b = req.body;
    if (
      !isAgentProvider(b?.provider) ||
      typeof b.prompt !== 'string' ||
      !b.prompt.trim() ||
      b.prompt.length > 16000 ||
      (b.effort !== undefined && !isProviderReasoningEffort(b.provider, b.effort)) ||
      (b.parameters !== undefined &&
        (b.provider !== 'cursor' || !validCursorRequestParameters(b.parameters))) ||
      (b.model !== undefined && !validAgentModelId(b.provider, b.model)) ||
      (b.capabilities !== undefined && typeof b.capabilities !== 'boolean') ||
      (b.requestTitle !== undefined && typeof b.requestTitle !== 'boolean') ||
      typeof b.sessionId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(b.sessionId) ||
      !b.context ||
      !Array.isArray(b.history)
    )
      return res.status(400).json({ error: 'Invalid chat request.' });
    try {
      validateAnnotations(b.annotations);
      validateLayoutAnnotationContext(b.context.layout);
      validateAgentWorkspaceContext(b.context.workspace, b.context.id, b.context.basis);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const sessionId = b.sessionId;
    if (active.has(sessionId))
      return res.status(409).json({ error: 'An agent is already running in this session.' });
    if (active.size >= 4)
      return res.status(429).json({
        error: 'Four sessions are running. Stop or finish a response before sending another.',
      });
    const control = new AbortController();
    active.set(sessionId, control);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const emit = (event) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const bridge = b.capabilities
      ? createAgentCapabilityBridge({
          sessionId,
          emit,
          signal: control.signal,
          origin: req.get('origin'),
        })
      : null;
    if (bridge) agentBridges.set(bridge.id, bridge);
    const questions = createAgentQuestionBridge({
      sessionId,
      emit,
      signal: control.signal,
      origin: req.get('origin'),
    });
    questions.provider = b.provider;
    questionBridges.set(questions.id, questions);
    const inputBridge = createAgentInputBridge({
      sessionId,
      emit,
      signal: control.signal,
      origin: req.get('origin'),
    });
    inputBridges.set(inputBridge.id, inputBridge);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n');
    }, 15000);
    res.on('close', () => {
      control.abort();
      if (active.get(sessionId) === control) active.delete(sessionId);
    });
    let outcome = 'failed';
    emit({ type: 'status', stage: 'connected', text: 'Connected to local service…' });
    try {
      // The service owns plugin instructions; never trust a renderer-supplied copy.
      pcbDesignTurns.add(control);
      const pcbDesignInstructions = await pcbDesign.instructions(
        !!bridge && ['codex', 'claude', 'cursor'].includes(b.provider),
        control.signal,
      );
      if (!pcbDesignInstructions) pcbDesignTurns.delete(control);
      control.signal.throwIfAborted();
      const result = await agentRunner(b.provider, b, cwd, emit, control.signal, {
        input: inputBridge,
        questions: { ...questions, url: `${base}/api/agent-questions/${questions.id}` },
        pcbDesignInstructions,
        cursorCredential,
        ...(bridge
          ? {
              capabilities: {
                call: (tool, args) => bridge.call(tool, args),
                url: `${base}/api/agent-tools/${bridge.id}`,
                token: bridge.token,
              },
            }
          : {}),
      });
      outcome = result?.outcome || 'failed';
    } catch (e) {
      emit({ type: 'error', text: e.message });
    } finally {
      pcbDesignTurns.delete(control);
      clearInterval(heartbeat);
      bridge?.close();
      questions.close();
      inputBridge.close();
      inputBridges.delete(inputBridge.id);
      questionBridges.delete(questions.id);
      if (bridge) agentBridges.delete(bridge.id);
      if (active.get(sessionId) === control) active.delete(sessionId);
      emit({ type: 'done', outcome });
      res.end();
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown OpenPE API route.' }));
  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }
  app.use((err, req, res, next) => {
    if (!res.headersSent)
      res.status(500).json({ error: err.message || 'The local service encountered an error.' });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    componentModels,
    installPluginPackage: (pkg) => runtimePlugins.install(pkg),
    previewPluginPackage: readPluginPackage,
    token,
    writeWorkspaceRecovery: (content) =>
      content === null ? recovery.clear() : recovery.writeEncoded(content),
    rawKiCadExtensions,
    selectRawKiCadFiles: rawKiCad.select,
    setRawKiCadMode(value) {
      if (value === rawKiCad.active()) return;
      rawKiCad.setActive(value);
      for (const control of active.values()) control.abort();
      rawTurn?.abort();
      for (const response of apiResponses) response.destroy();
    },
    close: () => {
      runtimePlugins.close();
      plugins.close();
      unsubscribePcbDesign();
      pcbDesign.close();
      simulations.close();
      thermal.close();
      modelCadPreviews.close();
      datasheets.close();
      libraries.close();
      for (const control of active.values()) control.abort();
      rawTurn?.abort();
      server.close();
    },
  };
}
