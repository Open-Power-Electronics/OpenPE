import { parseProject } from '../../../server/project-format.mjs';
import { createHash } from 'node:crypto';
import {
  deriveThermalSpiceSources,
  prepareThermalModel,
  validateThermalConfig,
  validateThermalResult,
} from './thermal-format.mjs';
import { detectThermal, runThermalSimulation } from './thermal-runtime.mjs';
import { publicThermalFailure } from './thermal-errors.mjs';

/** The authenticated host supplies the sole executable resource root. Requests
 * carry validated project data and settings, never meshes, scripts or paths. */
export function registerThermal(
  app,
  {
    plugins,
    resourceRoot,
    runner = runThermalSimulation,
    detector = detectThermal,
    resultFiles,
    readSpice,
  } = {},
) {
  let active = null;
  const detections = new Set();
  const lookups = new Set();
  const spiceControls = new Set();
  let activeCoupled = false;
  const unsubscribe = plugins.subscribe((id, state) => {
    if (id === 'spice-simulation@openpe' && (!state.installed || !state.enabled)) {
      if (activeCoupled) active?.abort();
      for (const control of spiceControls) control.abort();
    }
    if (id !== 'pcb-thermal@openpe' || (state.installed && state.enabled)) return;
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
      Buffer.byteLength(body.source) > 8_000_000 ||
      (loadOnly && !body.fileId) ||
      (body.fileId !== undefined &&
        (typeof body.fileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.fileId)))
    )
      throw new Error('Send a validated project source, thermal settings and project file ID.');
    const project = parseProject(body.source);
    if (!project.pcb) throw new Error('Open a PCB layout before running thermal analysis.');
    const config =
      body.config === undefined && loadOnly
        ? undefined
        : validateThermalConfig(body.config, project.pcb);
    const projectResults = resultFiles && body.fileId ? resultFiles.forProject(body.fileId) : null;
    if (resultFiles && !projectResults && !loadOnly)
      throw new Error('Save the project before running thermal analysis.');
    return { project, config, projectResults, source: body.source, fileId: body.fileId };
  }
  async function importSpice(prepared, control, provenance) {
    await plugins.require('spice-simulation@openpe');
    if (!prepared.fileId || !readSpice)
      throw new Error(
        'Save the project and complete SPICE Simulation before loading its heat sources.',
      );
    spiceControls.add(control);
    try {
      const completed = await readSpice(
        {
          source: prepared.source,
          fileId: prepared.fileId,
          ...(provenance ? { config: provenance.config } : {}),
        },
        control.signal,
      );
      control.signal.throwIfAborted();
      await plugins.require('spice-simulation@openpe');
      if (!completed.result)
        throw new Error(
          'No matching completed SPICE result. Run SPICE Simulation for this project first.',
        );
      const derived = deriveThermalSpiceSources(
        prepared.project.schematic,
        prepared.project.pcb,
        completed.deck,
        completed.result,
      );
      const resultBasis = createHash('sha256')
        .update(
          JSON.stringify([
            completed.deck.netlist,
            completed.result.version,
            completed.result.time,
            completed.result.traces.map(({ vector, unit, values }) => [vector, unit, values]),
            completed.result.dissipation,
          ]),
        )
        .digest('hex');
      return {
        heatSources: derived.heatSources,
        spiceSource: { config: completed.config, ...derived.window, resultBasis },
        losses: derived.losses,
        assumptions: derived.assumptions,
      };
    } finally {
      spiceControls.delete(control);
    }
  }
  async function verifySpice(prepared, config, control) {
    if (!config.spiceSource) return;
    const imported = await importSpice(prepared, control, config.spiceSource);
    if (
      imported.spiceSource.resultBasis !== config.spiceSource.resultBasis ||
      imported.spiceSource.startS !== config.spiceSource.startS ||
      imported.spiceSource.endS !== config.spiceSource.endS
    )
      throw new Error('The SPICE heat sources are stale. Load SPICE heat sources again.');
    const expected = new Map(
      imported.heatSources.map((source) => [source.footprintId, source.powerW]),
    );
    const actual = new Map(config.heatSources.map((source) => [source.footprintId, source.powerW]));
    for (const id of new Set([...expected.keys(), ...actual.keys()])) {
      const a = expected.get(id) ?? 0,
        b = actual.get(id) ?? 0;
      if (Math.abs(a - b) > 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)))
        throw new Error(
          'SPICE heat input was changed. Reload SPICE heat sources or choose Manual.',
        );
    }
  }
  app.post('/api/thermal/spice-sources', async (req, res) => {
    try {
      await plugins.require('pcb-thermal@openpe');
      await plugins.require('spice-simulation@openpe');
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    let prepared;
    try {
      const body = req.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['source', 'fileId'].includes(key))
      )
        throw new Error('Send current project source and a saved project file ID.');
      prepared = prepareRequest({ source: body.source, fileId: body.fileId }, true);
    } catch (error) {
      return res.status(400).json({ error: String(error.message).slice(0, 4000) });
    }
    const control = new AbortController();
    lookups.add(control);
    res.on('close', () => control.abort());
    try {
      const imported = await importSpice(prepared, control);
      await plugins.require('pcb-thermal@openpe');
      control.signal.throwIfAborted();
      if (!res.destroyed) res.json(imported);
    } catch (error) {
      if (!res.destroyed)
        res.status(control.signal.aborted ? 409 : 422).json({
          error: control.signal.aborted
            ? 'SPICE heat-source lookup cancelled.'
            : publicThermalFailure(error, 'spice').message,
        });
    } finally {
      lookups.delete(control);
    }
  });
  app.get('/api/thermal/status', async (req, res) => {
    try {
      await plugins.require('pcb-thermal@openpe');
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    if (Object.keys(req.query).length)
      return res.status(400).json({ error: 'Thermal status does not accept resource selectors.' });
    const control = new AbortController();
    detections.add(control);
    res.on('close', () => control.abort());
    try {
      const status = await detector(control.signal, resourceRoot);
      if (!res.destroyed) {
        if (control.signal.aborted) res.status(409).json({ error: 'Thermal detection cancelled.' });
        else if (status.available)
          res.json({
            available: true,
            gmsh: status.gmsh,
            elmer: status.elmer,
            identity: status.identity,
          });
        else {
          const { message } = publicThermalFailure(status, 'resources');
          res.json({ available: false, diagnostic: message, error: message });
        }
      }
    } catch (error) {
      if (!res.destroyed)
        res.status(control.signal.aborted ? 409 : 503).json({
          error: control.signal.aborted
            ? 'Thermal detection cancelled.'
            : publicThermalFailure(error, 'resources').message,
        });
    } finally {
      detections.delete(control);
    }
  });
  app.post('/api/thermal/result', async (req, res) => {
    try {
      await plugins.require('pcb-thermal@openpe');
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    let prepared;
    try {
      prepared = prepareRequest(req.body, true);
    } catch (error) {
      return res.status(400).json({ error: String(error.message).slice(0, 4000) });
    }
    const control = new AbortController();
    lookups.add(control);
    res.on('close', () => control.abort());
    try {
      const { project, config, projectResults } = prepared;
      const saved = projectResults ? await projectResults.read(control.signal) : null;
      control.signal.throwIfAborted();
      await plugins.require('pcb-thermal@openpe');
      if (!saved) return res.json({ result: null });
      let matches = false;
      try {
        await verifySpice(prepared, saved.model.config, control);
        const current = prepareThermalModel(project.pcb, saved.model.config);
        matches =
          JSON.stringify(current) === JSON.stringify(saved.model) &&
          (config === undefined ||
            JSON.stringify(prepareThermalModel(project.pcb, config)) ===
              JSON.stringify(saved.model));
      } catch {
        // Changed board geometry or settings cannot restore an older analysis.
      }
      if (!matches) return res.json({ result: null });
      const status = await detector(control.signal, resourceRoot);
      control.signal.throwIfAborted();
      await plugins.require('pcb-thermal@openpe');
      if (!status.available)
        throw new Error(
          status.diagnostic || status.error || 'The thermal solvers are unavailable.',
        );
      if (
        status.identity !== saved.solver.identity ||
        status.gmsh !== saved.solver.gmsh ||
        status.elmer !== saved.solver.elmer
      )
        return res.json({ result: null });
      const result = validateThermalResult(saved.result);
      if (
        result.basis !== saved.model.basis ||
        result.solver.gmsh !== saved.solver.gmsh ||
        result.solver.elmer !== saved.solver.elmer
      )
        throw new Error('Saved thermal results do not match their verified inputs.');
      control.signal.throwIfAborted();
      if (!res.destroyed) res.json({ result, config: saved.model.config });
    } catch (error) {
      if (!res.destroyed)
        res.status(control.signal.aborted ? 409 : 422).json({
          error: control.signal.aborted
            ? 'Thermal result lookup cancelled.'
            : publicThermalFailure(error, 'result').message,
        });
    } finally {
      lookups.delete(control);
    }
  });
  app.post('/api/thermal/run', async (req, res) => {
    try {
      await plugins.require('pcb-thermal@openpe');
      if (req.body?.config?.spiceSource) await plugins.require('spice-simulation@openpe');
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    let model, projectResults, prepared;
    try {
      prepared = prepareRequest(req.body);
      model = prepareThermalModel(prepared.project.pcb, prepared.config);
      projectResults = prepared.projectResults;
    } catch (error) {
      return res.status(400).json({ error: String(error.message).slice(0, 4000) });
    }
    if (active)
      return res
        .status(409)
        .json({ error: 'Another thermal analysis is running. Stop it before starting a new run.' });
    const control = new AbortController();
    active = control;
    activeCoupled = !!model.config.spiceSource;
    res.on('close', () => control.abort());
    try {
      await verifySpice(prepared, model.config, control);
      let published = false;
      const result = await runner(
        model,
        control.signal,
        resourceRoot,
        undefined,
        projectResults
          ? async ({ directory, result: completed, solver }) => {
              control.signal.throwIfAborted();
              await plugins.require('pcb-thermal@openpe');
              if (activeCoupled) await plugins.require('spice-simulation@openpe');
              validateThermalResult(completed);
              if (
                completed.basis !== model.basis ||
                completed.solver.gmsh !== solver.gmsh ||
                completed.solver.elmer !== solver.elmer
              )
                throw new Error('Thermal results do not match this board and its solver.');
              try {
                await projectResults.write(directory, model, completed, solver, control.signal);
              } catch (error) {
                control.signal.throwIfAborted();
                throw new Error(
                  `Could not save the completed thermal run. Check the project thermal folder and available disk space. ${error.message}`,
                );
              }
              published = true;
            }
          : undefined,
      );
      control.signal.throwIfAborted();
      await plugins.require('pcb-thermal@openpe');
      if (activeCoupled) await plugins.require('spice-simulation@openpe');
      validateThermalResult(result);
      if (result.basis !== model.basis)
        throw new Error('Thermal results do not match this board and its settings.');
      if (projectResults && !published)
        throw new Error('The completed thermal run was not saved. Run again.');
      if (!res.destroyed) res.json({ result });
    } catch (error) {
      if (!res.destroyed)
        res.status(control.signal.aborted ? 409 : 422).json({
          error: control.signal.aborted
            ? 'Thermal analysis cancelled.'
            : publicThermalFailure(error).message,
        });
    } finally {
      if (active === control) {
        active = null;
        activeCoupled = false;
      }
    }
  });
  return {
    close() {
      unsubscribe();
      active?.abort();
      for (const control of detections) control.abort();
      for (const control of lookups) control.abort();
    },
  };
}
