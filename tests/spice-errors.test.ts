import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spiceFailure, publicSpiceFailure } from '../server/spice-errors.mjs';
import { startServer } from '../server/index.mjs';
import { createProject, serializeProject } from '../lib/project';
import { defaultTransient } from '../lib/spice';
import { readSimulationEvents } from '../lib/simulation-stream';
import { switchingStageFixture } from './fixtures/switching-stage';

const diagnostic =
  'doAnalyses: TRAN: Timestep too small; time = 0.00176724, timestep = 2.5e-19: trouble with node "x15.nodeone"\r\nrun simulation(s) aborted';

test('native convergence failures expose milliseconds and retain private diagnostics internally', () => {
  const error = spiceFailure(diagnostic);
  assert.deepEqual(publicSpiceFailure(error), {
    message:
      'The solver could not converge at 1.76724 ms. Try a shorter duration or review the circuit and model.',
    code: 'OPENPE_SPICE_CONVERGENCE',
  });
  assert.match(error.message, /x15.nodeone/);
  assert.doesNotMatch(publicSpiceFailure(error).message, /timestep|nodeone|aborted/);
  for (const log of [
    'Timestep too small; initial timepoint: trouble with node "private"',
    'Timestep too small; time = 0, timestep = 1e-19',
    'Timestep too small; time = 1e999',
    'Timestep too small; time = 1e308',
    'Transient op failed',
    'The operating point could not be simulated successfully.',
  ])
    assert.match(publicSpiceFailure(spiceFailure(log)).message, /at startup/);
  assert.match(
    publicSpiceFailure(spiceFailure('Timestep too small; time = 0.0002')).message,
    /0.2 ms/,
  );
});

test('cancellation and reader failures take precedence over convergence diagnostics', () => {
  for (const reason of [
    'Simulation cancelled.',
    'ngspice returned invalid or non-monotonic waveform data.',
  ])
    assert.deepEqual(publicSpiceFailure(spiceFailure(diagnostic, reason)), { message: reason });
  assert.deepEqual(publicSpiceFailure(spiceFailure('Fatal error: private model data')), {
    message:
      'The solver could not complete this simulation. Review the circuit and simulation settings.',
  });
  assert.equal(spiceFailure('Error on line 4\nTimestep too small').code, undefined);
});

test('JSON and SSE simulation failures carry the same safe recovery code without solver logs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-spice-failure-'));
  const server = await startServer({
    dataDir: directory,
    simulationRunner: async () => {
      throw spiceFailure(diagnostic);
    },
  });
  const circuit = switchingStageFixture();
  const body = JSON.stringify({
    source: serializeProject(createProject(circuit)),
    config: defaultTransient(circuit),
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  try {
    const response = await fetch(server.base + '/api/simulation/transient', {
      method: 'POST',
      headers,
      body,
    });
    assert.equal(response.status, 422);
    const failure = await response.json();
    assert.equal(failure.code, 'OPENPE_SPICE_CONVERGENCE');
    assert.match(failure.error, /1.76724 ms/);
    assert.doesNotMatch(JSON.stringify(failure), /nodeone|doAnalyses|timestep/);
    const stream = await fetch(server.base + '/api/simulation/transient', {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body,
    });
    const events: string[] = [];
    await assert.rejects(
      readSimulationEvents(stream.body!, (event) => events.push(event.type)),
      (error: Error & { code?: string }) => {
        assert.equal(error.message, failure.error);
        assert.equal(error.code, failure.code);
        return true;
      },
    );
    assert.deepEqual(events, ['started']);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
