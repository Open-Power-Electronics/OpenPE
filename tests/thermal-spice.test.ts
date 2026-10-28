import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uid } from '../lib/circuit';
import { createProject, serializeProject } from '../lib/project';
import { startServer } from '../server/index.mjs';
import { createEmptyPCB } from '../lib/pcb-layout';
import { buildSpiceDeck, defaultTransient, spiceNets, type SimulationResult } from '../lib/spice';
import {
  deriveThermalSpiceSources,
  defaultThermalConfig,
  validateThermalConfig,
  validateThermalSpiceImport,
  type ThermalModel,
  type ThermalResult,
} from '../lib/thermal';
import { switchingStageFixture } from './fixtures/switching-stage';

export function thermalSpiceFixture() {
  const circuit = switchingStageFixture();
  const config = defaultTransient(circuit),
    deck = buildSpiceDeck(circuit, config);
  const resistor = circuit.parts.find((part) => part.ref === 'R1')!;
  const board = createEmptyPCB();
  board.footprints = [
    {
      id: 'resistor-footprint',
      symbolId: resistor.id,
      reference: resistor.ref,
      value: resistor.value,
      libraryId: 'Test:R',
      x: 5,
      y: 5,
      rotation: 0,
      side: 'front',
      graphics: [],
      pads: [],
    },
  ];
  const nets = spiceNets(circuit);
  const positive = nets.node(resistor, '1');
  const result: SimulationResult = {
    version: 'fixture',
    log: '',
    time: [0, 0.3 * deck.stop, 0.7 * deck.stop, deck.stop],
    traces: deck.traces.map((trace) => ({
      ...trace,
      values:
        trace.unit === 'V' && trace.vector === `v(${positive})`
          ? [2, 2, 2, 2]
          : trace.unit === 'A' && trace.targets?.some((target) => target.id === resistor.id)
            ? [0, 3, 7, 10]
            : [0, 0, 0, 0],
    })),
    dissipation: {
      startS: deck.stop * 0.8,
      endS: deck.stop,
      sampleCount: 2000,
      powers: deck.traces
        .filter((trace) => trace.dissipation)
        .map((trace) => ({
          vector: trace.vector,
          powerW: trace.targets?.some((target) => target.id === resistor.id) ? 10 : 0,
        })),
    },
  };
  return { circuit, board, config, deck, result, resistor };
}

test('SPICE heat uses full-resolution signed-power summaries independently of reduced display samples', () => {
  const { circuit, board, deck, result } = thermalSpiceFixture();
  const before = JSON.stringify([circuit, board, result]);
  const imported = deriveThermalSpiceSources(circuit, board, deck, result);
  assert.equal(imported.losses.length, 1);
  assert.equal(imported.losses[0].method, 'resistor');
  assert.ok(Math.abs(imported.heatSources[0].powerW - 10) < 1e-12);
  assert.equal(JSON.stringify([circuit, board, result]), before);
  result.traces.forEach((trace) => trace.values.fill(0));
  assert.equal(deriveThermalSpiceSources(circuit, board, deck, result).heatSources[0].powerW, 10);
  assert.deepEqual(deriveThermalSpiceSources(circuit, board, deck, result).window, {
    startS: deck.stop * 0.8,
    endS: deck.stop,
  });
});

test('SPICE heat rejects incomplete samples, negative dissipation, ambiguous links and ideal reactive paths', () => {
  const { circuit, board, deck, result, resistor } = thermalSpiceFixture();
  const bad = structuredClone(result);
  bad.time[3] = deck.stop * 0.9;
  assert.throws(() => deriveThermalSpiceSources(circuit, board, deck, bad), /Incomplete/);
  const older = structuredClone(result);
  delete older.dissipation;
  assert.throws(() => deriveThermalSpiceSources(circuit, board, deck, older), /full-resolution/);
  const current = result.traces.find(
    (trace) => trace.unit === 'A' && trace.targets?.some((target) => target.id === resistor.id),
  )!;
  const power = result.dissipation!.powers.find((power) => power.vector === current.vector)!;
  power.powerW = -10;
  assert.throws(() => deriveThermalSpiceSources(circuit, board, deck, result), /negative/);
  power.powerW = 10;
  board.footprints.push({ ...board.footprints[0], id: 'ambiguous' });
  assert.throws(() => deriveThermalSpiceSources(circuit, board, deck, result), /unambiguous/);
  board.footprints.pop();
  board.footprints[0].symbolId = circuit.parts.find((part) => part.libId === 'Device:L')!.id;
  assert.throws(
    () => deriveThermalSpiceSources(circuit, board, deck, result),
    /No positive supported/,
  );
});

test('thermal SPICE provenance is bounded session configuration with matching per-device measurements', () => {
  const { circuit, board, config, deck, result } = thermalSpiceFixture();
  const derived = deriveThermalSpiceSources(circuit, board, deck, result);
  const input = {
    heatSources: derived.heatSources,
    losses: derived.losses,
    assumptions: derived.assumptions,
    spiceSource: { config, ...derived.window, resultBasis: 'a'.repeat(64) },
  };
  const imported = validateThermalSpiceImport(input, board);
  assert.notEqual(imported, input);
  assert.deepEqual(
    validateThermalConfig(
      {
        ...defaultThermalConfig(board),
        heatSources: imported.heatSources,
        spiceSource: imported.spiceSource,
      },
      board,
    ).spiceSource,
    imported.spiceSource,
  );
  assert.throws(
    () =>
      validateThermalSpiceImport({
        ...input,
        spiceSource: { ...input.spiceSource, startS: deck.stop },
      }),
    /No positive/,
  );
  assert.throws(
    () =>
      validateThermalSpiceImport({
        ...input,
        heatSources: [{ ...input.heatSources[0], powerW: 1 }],
      }),
    /measurements/,
  );
  assert.throws(
    () =>
      validateThermalSpiceImport({
        ...input,
        spiceSource: { ...input.spiceSource, source: 'unsafe' },
      }),
    /Invalid/,
  );
});

test('thermal SPICE import is load-only, rechecks completed samples and gates both plugins', async () => {
  const fixture = thermalSpiceFixture();
  const { board, circuit, deck, result, config } = fixture;
  board.footprints[0].id = uid();
  delete board.footprints[0].reference;
  delete board.footprints[0].value;
  board.footprints[0].pads = [
    {
      id: uid(),
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 2, y: 2 },
      netId: null,
    },
  ];
  const corners = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  board.graphics = corners.map((start, i) => ({
    id: uid(),
    start,
    end: corners[(i + 1) % 4],
    width: 0.1,
    layer: 'Edge.Cuts',
  }));
  const project = createProject();
  project.schematic = circuit;
  project.pcb = board;
  const source = serializeProject(project),
    fileId = uid();
  let simulations = 0,
    thermals = 0,
    lookups = 0;
  let completed = result;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-thermal-spice-'));
  const server = await startServer({
    dataDir: directory,
    simulationRunner: async () => {
      simulations++;
      return result;
    },
    simulationResultFiles: {
      forProject: () => ({ readSettings: async () => ({ config, key: 'saved-key' }) }),
    } as never,
    simulationResultLoader: async (current: { netlist: string }) => {
      lookups++;
      return current.netlist === deck.netlist ? completed : null;
    },
    thermalRunner: async (model: ThermalModel): Promise<ThermalResult> => {
      thermals++;
      const watts = model.sources.reduce((sum, source) => sum + source.powerW, 0);
      return {
        version: 1,
        status: 'completed',
        basis: model.basis,
        solver: { gmsh: 'fixture', elmer: 'fixture' },
        points: [
          { x: 0, y: 0, z: 0, temperatureC: 30 },
          { x: 10, y: 0, z: 0, temperatureC: 30 },
          { x: 0, y: 10, z: 0, temperatureC: 30 },
        ],
        triangles: [[0, 1, 2]],
        statistics: {
          minC: 30,
          maxC: 30,
          meanC: 30,
          inputPowerW: watts,
          outputPowerW: watts,
          energyImbalanceRelative: 0,
          nodeCount: 3,
          elementCount: 1,
        },
        assumptions: model.assumptions,
        diagnostics: [],
      };
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const post = (route: string, body: unknown) =>
    fetch(server.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const importedResponse = await post('/api/thermal/spice-sources', { source, fileId });
    assert.equal(importedResponse.status, 200, await importedResponse.clone().text());
    const imported = validateThermalSpiceImport(await importedResponse.json(), board);
    assert.equal(simulations, 0);
    assert.equal(thermals, 0);
    const thermalConfig = {
      ...defaultThermalConfig(board),
      heatSources: imported.heatSources,
      spiceSource: imported.spiceSource,
    };
    completed = structuredClone(result);
    delete completed.dissipation;
    const older = await post('/api/thermal/spice-sources', { source, fileId });
    assert.equal(older.status, 422);
    assert.match((await older.json()).error, /full-resolution/);
    completed = result;
    assert.equal(
      (await post('/api/thermal/run', { source, fileId, config: thermalConfig })).status,
      200,
    );
    assert.equal(thermals, 1);
    const changedProject = structuredClone(project);
    changedProject.schematic.parts.find((part) => part.ref === 'R1')!.value = '999';
    assert.equal(
      (
        await post('/api/thermal/spice-sources', {
          source: serializeProject(changedProject),
          fileId,
        })
      ).status,
      422,
    );
    const edited = {
      ...thermalConfig,
      heatSources: [{ ...thermalConfig.heatSources[0], powerW: 999 }],
    };
    const invalid = await post('/api/thermal/run', { source, fileId, config: edited });
    assert.equal(invalid.status, 422);
    assert.match((await invalid.json()).error, /changed/);
    completed = structuredClone(result);
    completed.traces[0].values[0] += 1;
    const stale = await post('/api/thermal/run', { source, fileId, config: thermalConfig });
    assert.equal(stale.status, 422);
    assert.match((await stale.json()).error, /stale/);
    assert.equal(thermals, 1);
    for (const extra of [
      { heatSources: [] },
      { executable: 'solver' },
      { window: { startS: 0, endS: 1, path: '../' } },
    ])
      assert.equal(
        (await post('/api/thermal/spice-sources', { source, fileId, ...extra })).status,
        400,
      );
    await post('/api/workbench-plugins', { id: 'spice-simulation@openpe', action: 'disable' });
    const prior = lookups;
    assert.equal((await post('/api/thermal/spice-sources', { source, fileId })).status, 403);
    assert.equal(
      (await post('/api/thermal/run', { source, fileId, config: thermalConfig })).status,
      403,
    );
    assert.equal(lookups, prior);
    const manual = { ...thermalConfig };
    delete (manual as { spiceSource?: unknown }).spiceSource;
    assert.equal((await post('/api/thermal/run', { source, fileId, config: manual })).status, 200);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
