import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../../../server/project-format.mjs';
import { buildSpiceDeck, validatedSimulationResult } from './spice-format.mjs';
import { validateSpiceConfig } from '../../../server/project-spice-files.mjs';
import { createSimulationModelStore } from '../../../server/example-models.mjs';
import { spiceRuntime } from './spice-runtime.mjs';
import { projectSimulationModels } from '../../../server/project-models.mjs';
import { createSpiceResultCache } from './spice-cache.mjs';
import { createSpiceRawReader, liveSpiceNetlist } from './spice-raw.mjs';
import { sendSpiceEvent } from './spice-events.mjs';
import { readNativeSpiceDissipation, readWaveforms } from './spice-waveforms.mjs';
import { adaptSpiceModels } from './spice-model-adapters.mjs';
export { parseWaveforms } from './spice-waveforms.mjs';
import { spiceFailure, publicSpiceFailure } from './spice-errors.mjs';
import {
  spiceConvergenceDecks,
  runSpiceAttempts,
  convergenceProgress,
  convergencePolicy,
} from './spice-convergence.mjs';

const exec = promisify(execFile);
const completedResults = createSpiceResultCache();
const installMessage =
  'The bundled ngspice solver is missing or cannot start. Repair the OpenPE installation, or run npm run simulation:prepare in a development checkout, then restart OpenPE.';

export async function detectSpice(signal, root) {
  let runtime;
  try {
    runtime = spiceRuntime(root);
  } catch (error) {
    return { available: false, error: error.message };
  }
  const candidates = [runtime.executable];
  for (const executable of candidates) {
    if (signal?.aborted) throw new Error('Simulation cancelled.');
    try {
      const { stdout, stderr } = await exec(executable, ['-n', '--version'], {
        windowsHide: true,
        timeout: 4000,
        maxBuffer: 64000,
        signal,
        env: runtime.env,
      });
      const version = `${stdout}\n${stderr}`.match(/ngspice-\d+[^\r\n*]*/i)?.[0]?.trim();
      if (version) return { available: true, version, executable };
    } catch {
      /* Try the next console executable; never launch a shell. */
    }
  }
  if (signal?.aborted) throw new Error('Simulation cancelled.');
  return { available: false, error: installMessage };
}

/** Internal host preparation shared with offline maintenance; never a renderer capability. */
export async function prepareSimulation(deck, signal, modelStore, root) {
  const solver = await detectSpice(signal, root);
  if (!solver.available) throw new Error(solver.error);
  const executable = await stat(solver.executable);
  const solverSha256 = createHash('sha256')
    .update(await readFile(solver.executable))
    .digest('hex');
  const checkedExecutable = await stat(solver.executable);
  if (['size', 'mtimeMs', 'ctimeMs'].some((name) => executable[name] !== checkedExecutable[name]))
    throw new Error('The bundled solver changed during verification. Retry the simulation.');
  const original = deck;
  signal.throwIfAborted();
  const modelBytes = new Map();
  if (deck.modelId) {
    if (!modelStore) throw new Error('TI model storage is unavailable. Restart the local service.');
    const bytes = await modelStore(deck.modelId, signal);
    modelBytes.set(deck.modelId, bytes);
    if (signal.aborted) throw new Error('Simulation cancelled.');
  }
  for (const id of deck.modelIds || []) {
    if (!modelStore)
      throw new Error('Example model storage is unavailable. Restart the local service.');
    const bytes = await modelStore(id, signal);
    modelBytes.set(id, bytes);
    signal.throwIfAborted();
  }
  // Adapt only verified, pinned vendor models in this private solver deck.
  // Include the derived deck in the identity before looking up completed results.
  deck = adaptSpiceModels(deck, modelBytes);
  const decks = spiceConvergenceDecks(deck);
  // Revalidate model files before reuse, including missing/changed files beside a grant.
  // Probe targets are rebound through the current compiler after loading. They
  // describe editor objects, not solver inputs, and must not invalidate samples
  // after a wire split or an equivalent template refresh.
  signal.throwIfAborted();
  const finishIdentity = (identity) => {
    for (const id of [
      ...(original.modelId ? [original.modelId] : []),
      ...(original.modelIds || []),
    ])
      identity.update(id).update(modelBytes.get(id));
    return identity
      .update(
        JSON.stringify([
          convergencePolicy,
          decks.map(({ netlist }) => netlist),
          deck.compatibility,
        ]),
      )
      .digest('hex');
  };
  const key = finishIdentity(
    createHash('sha256').update(
      JSON.stringify([
        'openpe-spice-v2',
        solverSha256,
        solver.version,
        original.netlist,
        original.stop,
        original.traces.map(({ unit, vector }) => [unit, vector]),
        original.compatibility,
        ...(original.traces.some((trace) => trace.dissipation)
          ? [
              [
                'full-resolution-dissipation-v2-native-raw',
                original.traces
                  .filter((trace) => trace.dissipation)
                  .map((trace) => [
                    trace.vector,
                    trace.dissipation.positiveNode,
                    trace.dissipation.negativeNode,
                  ]),
              ],
            ]
          : []),
      ]),
    ),
  );
  return {
    solver,
    deck,
    decks,
    modelBytes,
    key,
    identity: { identityVersion: 2, solverSha256 },
  };
}

async function readPreparedResult(prepared, resultFiles, signal) {
  return resultFiles.read(prepared.key, prepared.deck, signal, {
    ...prepared.identity,
    solverVersion: prepared.solver.version,
  });
}

/** A lookup verifies the same inputs as Run and can never start a transient analysis. */
export async function findSimulationResult(deck, signal, modelStore, root, resultFiles) {
  if (!resultFiles) return null;
  const prepared = await prepareSimulation(deck, signal, modelStore, root);
  return readPreparedResult(prepared, resultFiles, signal);
}

/** @returns {Promise<import('../domain/spice').SimulationResult>} */
export async function runSimulation(
  deck,
  signal,
  modelStore,
  root,
  onSamples,
  resultFiles,
  config,
) {
  const prepared = await prepareSimulation(deck, signal, modelStore, root);
  const { solver, key, modelBytes } = prepared;
  deck = prepared.deck;
  const cached = resultFiles
    ? await readPreparedResult(prepared, resultFiles, signal)
    : completedResults.get(key);
  if (cached && (!deck.traces.some((trace) => trace.dissipation) || cached.dissipation))
    return validatedSimulationResult(cached, deck);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-spice-'));
  try {
    signal.throwIfAborted();
    if (deck.modelId)
      await writeFile(path.join(directory, 'ti-model.lib'), modelBytes.get(deck.modelId));
    for (const [index, id] of (deck.modelIds || []).entries())
      await writeFile(path.join(directory, `example-model-${index}.lib`), modelBytes.get(id));
    const runtime = spiceRuntime(root);
    const attempt = await runSpiceAttempts(
      prepared.decks,
      signal,
      async (candidate, index) => {
        deck = candidate;
        if (index) {
          for (const name of ['waveforms.raw', 'waveforms.txt'])
            await rm(path.join(directory, name), { force: true });
        }
        await writeFile(path.join(directory, 'circuit.cir'), liveSpiceNetlist(deck), 'utf8');
        return new Promise((resolve, reject) => {
          const child = spawn(
            solver.executable,
            [
              '-n',
              ...(deck.modelId || deck.compatibility
                ? ['-D', `ngbehavior=${deck.compatibility || 'ps'}`]
                : []),
              '-b',
              'circuit.cir',
            ],
            {
              cwd: directory,
              env: runtime.env,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let output = '',
            failure = '',
            failureCode,
            solverFailed = false;
          const stop = (reason, code) => {
            failureCode ||= code;
            failure ||= reason;
            child.kill();
          };
          const cancel = () => stop('Simulation cancelled.');
          const inspect =
            index === 0 && prepared.decks.length > 1 ? convergenceProgress(deck) : undefined;
          const samples =
            onSamples || inspect
              ? createSpiceRawReader(
                  path.join(directory, 'waveforms.raw'),
                  deck,
                  onSamples || (async () => {}),
                  inspect,
                )
              : null;
          const samplePoll = setInterval(() => {
            void samples?.poll().catch((error) => stop(error.message, error.code));
          }, 200);
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
          const capture = (chunk) => {
            solverFailed ||=
              /simulation\(s\) aborted|timestep too small|fatal error|error on line/i.test(
                output.slice(-256) + chunk.toString(),
              );
            output += chunk.toString();
            if (output.length > 128000) {
              output = output.slice(-128000);
            }
          };
          child.stdout.on('data', capture);
          child.stderr.on('data', capture);
          child.on('error', (error) => {
            failure ||= error.message;
          });
          child.on('close', async (code) => {
            clearInterval(samplePoll);
            signal.removeEventListener('abort', cancel);
            try {
              await samples?.close();
            } catch (error) {
              failure ||= error.message;
            }
            if (failure || code !== 0 || solverFailed)
              reject(
                Object.assign(
                  spiceFailure(output, failure),
                  failureCode ? { code: failureCode } : {},
                ),
              );
            else resolve(output);
          });
        });
      },
      () => onSamples?.({ reset: true }),
    );
    deck = attempt.deck;
    const log = attempt.log;
    if (signal.aborted) throw new Error('Simulation cancelled.');
    const file = path.join(directory, 'waveforms.txt');
    await stat(file).catch(() => {
      throw new Error(`ngspice produced no waveforms.\n${String(log).slice(-6000)}`);
    });
    let data;
    try {
      data = await readWaveforms(file, deck, signal);
      const dissipation = await readNativeSpiceDissipation(
        path.join(directory, 'waveforms.raw'),
        deck,
        signal,
      );
      if (dissipation) data.dissipation = dissipation;
    } catch (error) {
      throw new Error(`${error.message}\n${String(log).slice(-6000)}`);
    }
    signal.throwIfAborted();
    const result = { ...data, version: solver.version, log: String(log).slice(-16000) };
    if (resultFiles) {
      await writeFile(path.join(directory, 'solver.log'), String(log), 'utf8');
      try {
        await resultFiles.write(key, directory, result, signal, deck, config, prepared.identity);
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(
          `Could not save the completed SPICE run. Check the project spice folder and available disk space. ${error.message}`,
        );
      }
    }
    if (!resultFiles) completedResults.set(key, result);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function registerSpice(
  app,
  runner = runSimulation,
  detector = detectSpice,
  dataDir,
  modelFetcher = fetch,
  modelFiles,
  plugins,
  resultFiles,
  resultLoader = findSimulationResult,
  projectRoot,
  preparedModelRoot,
) {
  const modelStore = dataDir
    ? createSimulationModelStore(dataDir, modelFetcher, projectRoot, preparedModelRoot)
    : undefined;
  const offlineModelStore = dataDir
    ? createSimulationModelStore(
        dataDir,
        async () => {
          const error = new Error(
            'The referenced simulation model file is missing. Restore the referenced model folder, or prepare the example files with npm run simulation:download-examples. Run does not download referenced models.',
          );
          error.code = 'OPENPE_MODEL_FILES_MISSING';
          throw error;
        },
        projectRoot,
        preparedModelRoot,
      )
    : undefined;
  let active = null;
  const detections = new Set();
  const lookups = new Set();
  const unsubscribe = plugins?.subscribe((_id, state) => {
    if (_id !== 'spice-simulation@openpe') return;
    if (state.installed && state.enabled) return;
    active?.abort();
    for (const control of detections) control.abort();
    for (const control of lookups) control.abort();
  });
  function prepareRequest(body, loadOnly = false) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['source', 'config', 'fileId'].includes(key)) ||
      typeof body.source !== 'string' ||
      (body.fileId !== undefined &&
        (typeof body.fileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.fileId)))
    )
      throw new Error('Send a project source and transient settings.');
    const project = parseProject(body.source);
    const config =
      body.config === undefined && loadOnly ? undefined : validateSpiceConfig(body.config);
    const deck = config === undefined ? undefined : buildSpiceDeck(project.schematic, config);
    const store = (id, signal) =>
      (loadOnly || project.simulationModels?.some((model) => model.id === id)
        ? offlineModelStore
        : modelStore)?.(id, signal);
    const files =
      loadOnly && modelFiles ? { read: modelFiles.read, write: async () => {} } : modelFiles;
    const projectModels = projectSimulationModels(project, store, files, body.fileId);
    let projectResults;
    if (resultFiles) {
      if (body.fileId) projectResults = resultFiles.forProject(body.fileId);
      if (!projectResults && !loadOnly)
        throw new Error('Save the project before running a simulation.');
    }
    return { project, config, deck, projectModels, projectResults };
  }
  async function loadCompleted(prepared, signal) {
    let { config, deck } = prepared;
    let files = prepared.projectResults;
    if (!files) return { result: null };
    if (config === undefined) {
      const saved = await files.readSettings(signal);
      signal.throwIfAborted();
      if (!saved) return { result: null };
      config = saved.config;
      try {
        deck = buildSpiceDeck(prepared.project.schematic, config);
      } catch {
        return { result: null };
      }
      const original = files;
      files = {
        ...original,
        read(key, current, requestSignal, identity) {
          if (key !== saved.key) return null;
          return original.read(key, current, requestSignal, identity);
        },
      };
    }
    const result = await resultLoader(deck, signal, prepared.projectModels.store, files);
    signal.throwIfAborted();
    await plugins?.require('spice-simulation@openpe');
    return { result: result ? validatedSimulationResult(result, deck) : null, config, deck };
  }
  app.post('/api/simulation/result', async (req, res) => {
    const control = new AbortController();
    try {
      await plugins?.require('spice-simulation@openpe');
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    let prepared;
    try {
      prepared = prepareRequest(req.body, true);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    lookups.add(control);
    res.on('close', () => control.abort());
    try {
      const { result, config } = await loadCompleted(prepared, control.signal);
      if (!res.destroyed) {
        if (control.signal.aborted)
          res.status(409).json({ error: 'Simulation result lookup cancelled.' });
        else res.json({ result, ...(result ? { config } : {}) });
      }
    } catch (error) {
      if (!res.destroyed)
        res.status(control.signal.aborted ? 409 : 422).json({
          error: control.signal.aborted
            ? 'Simulation result lookup cancelled.'
            : publicSpiceFailure(error).message,
        });
    } finally {
      lookups.delete(control);
    }
  });
  app.get('/api/simulation/status', async (_req, res) => {
    try {
      await plugins?.require('spice-simulation@openpe');
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    const control = new AbortController();
    detections.add(control);
    res.on('close', () => control.abort());
    try {
      const status = await detector(control.signal);
      if (control.signal.aborted)
        return res.status(409).json({
          error: 'Simulation cancelled. Check SPICE Simulation in Plugins > Marketplace.',
        });
      res.json(
        status.available
          ? { available: true, version: status.version }
          : { available: false, error: status.error },
      );
    } catch (error) {
      if (!res.destroyed) res.status(500).json({ error: error.message });
    } finally {
      detections.delete(control);
    }
  });
  app.post('/api/simulation/transient', async (req, res) => {
    try {
      await plugins?.require('spice-simulation@openpe');
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    if (active)
      return res
        .status(409)
        .json({ error: 'A simulation is already running. Stop it or wait for it to finish.' });
    let deck, config, projectModels, projectResults;
    try {
      ({ deck, config, projectModels, projectResults } = prepareRequest(req.body));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const control = new AbortController();
    active = control;
    res.on('close', () => control.abort());
    const streaming = /(?:^|,)\s*text\/event-stream(?:\s*;|\s*$)/i.test(req.get('accept') || '');
    if (streaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.flushHeaders();
    }
    try {
      if (streaming) await sendSpiceEvent(res, { type: 'started' }, control.signal);
      const result = await runner(
        deck,
        control.signal,
        projectModels.store,
        streaming
          ? (samples) =>
              sendSpiceEvent(
                res,
                samples.reset ? { type: 'retry' } : { type: 'samples', ...samples },
                control.signal,
              )
          : undefined,
        projectResults,
        config,
      );
      if (!control.signal.aborted) {
        const completed = {
          ...result,
          ...(projectModels.models.length ? { simulationModels: projectModels.models } : {}),
        };
        if (streaming) {
          await sendSpiceEvent(res, { type: 'result', result: completed }, control.signal);
          res.end();
        } else res.json(completed);
      } else if (!res.destroyed && streaming) {
        res.end(`data: ${JSON.stringify({ type: 'error', message: 'Simulation cancelled.' })}\n\n`);
      } else if (!res.destroyed)
        res.status(409).json({
          error: 'Simulation cancelled. Check SPICE Simulation in Plugins > Marketplace.',
        });
    } catch (error) {
      if (!res.destroyed) {
        const { message, ...details } = publicSpiceFailure(error);
        if (streaming)
          res.end(`data: ${JSON.stringify({ type: 'error', message, ...details })}\n\n`);
        else res.status(422).json({ error: message, ...details });
      }
    } finally {
      if (active === control) active = null;
    }
  });
  return {
    /** Shared read-only completed-result port. It never launches a solver or downloads. */
    async readCompleted(body, signal) {
      await plugins?.require('spice-simulation@openpe');
      const control = new AbortController();
      const abort = () => control.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) control.abort();
      lookups.add(control);
      try {
        return await loadCompleted(prepareRequest(body, true), control.signal);
      } finally {
        lookups.delete(control);
        signal.removeEventListener('abort', abort);
      }
    },
    close() {
      unsubscribe?.();
      active?.abort();
      for (const c of detections) c.abort();
      for (const c of lookups) c.abort();
    },
  };
}
