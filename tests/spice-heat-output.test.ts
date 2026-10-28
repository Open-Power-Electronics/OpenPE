import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWaveforms } from '../server/spice-waveforms.mjs';
import { validatedSimulationResult } from '../lib/waveform';
import type { SpiceDeck } from '../lib/spice';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const deck: SpiceDeck = {
  netlist: '',
  stop: 1,
  assumptions: [],
  traces: [
    { label: 'Output', vector: 'v(out)', unit: 'V' },
    {
      label: 'Resistor',
      vector: 'i(r1)',
      unit: 'A',
      dissipation: {
        positivePin: '1',
        negativePin: '2',
        positiveNode: 'out',
        negativeNode: '0',
        method: 'resistor',
      },
    },
  ],
};
test('full-resolution heat integrates every completed output row before display reduction', () => {
  const rows = ['time v(out) i(r1)'];
  for (let i = 0; i <= 210000; i++) rows.push(`${i / 210000} 10 ${i % 20 === 0 ? 20 : 0}`);
  const parsed = parseWaveforms(rows.join('\n'), deck);
  assert.ok(parsed.dissipation);
  assert.ok(parsed.time.length < 200000);
  assert.equal(parsed.dissipation.sampleCount, 210001);
  assert.equal(parsed.dissipation.startS, 0.8);
  assert.equal(parsed.dissipation.endS, 1);
  assert.ok(Math.abs(parsed.dissipation.powers[0].powerW - 10) < 1e-8);
  const checked = validatedSimulationResult({ ...parsed, version: 'fixture', log: '' }, deck);
  assert.deepEqual(checked.dissipation, parsed.dissipation);
  assert.notEqual(checked.dissipation, parsed.dissipation);
});
test('heat keeps signed power and clips the final averaging window at segment boundaries', () => {
  const parsed = parseWaveforms('time v(out) i(r1)\n0 10 -2\n0.5 10 -2\n1 10 -4\n', deck);
  assert.ok(parsed.dissipation);
  assert.ok(Math.abs(parsed.dissipation.powers[0].powerW - -36) < 1e-12);
  const slightOvershoot = parseWaveforms(
    'time v(out) i(r1)\n0 10 -2\n0.5 10 -2\n1.0000001 10 -2\n',
    deck,
  );
  assert.ok(Math.abs(slightOvershoot.dissipation!.powers[0].powerW + 20) < 1e-12);
  for (const heat of [
    { ...parsed.dissipation, startS: 0.7 },
    { ...parsed.dissipation, endS: 0.9 },
    { ...parsed.dissipation, sampleCount: 2 },
    { ...parsed.dissipation, powers: [] },
    { ...parsed.dissipation, powers: [{ vector: 'i(unknown)', powerW: 1 }] },
    { ...parsed.dissipation, powers: [{ vector: 'i(r1)', powerW: NaN }] },
  ])
    assert.throws(
      () =>
        validatedSimulationResult(
          { ...parsed, version: 'fixture', log: '', dissipation: heat },
          deck,
        ),
      /heat summary/,
    );
});
test('unmeasured dissipative terminal voltages fail instead of deriving heat from partial vectors', () => {
  const malformed: SpiceDeck = {
    ...deck,
    traces: deck.traces.map((t) =>
      t.dissipation ? { ...t, dissipation: { ...t.dissipation, negativeNode: 'missing' } } : t,
    ),
  };
  assert.throws(() => parseWaveforms('', malformed), /terminal voltage/);
});
test(
  'heat integration metadata changes saved cache keys without colliding with display-only records',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-heat-identity-'));
    const solverBytes = 'heat cache identity fixture';
    const original = childProcess.execFile;
    try {
      await mkdir(path.join(directory, 'bin'));
      await writeFile(path.join(directory, 'bin', 'ngspice_con.exe'), solverBytes);
      childProcess.execFile = Object.assign(
        () => {
          throw new Error('Fixture detection only.');
        },
        { [promisify.custom]: async () => ({ stdout: 'ngspice-47 heat fixture', stderr: '' }) },
      ) as unknown as typeof childProcess.execFile;
      syncBuiltinESMExports();
      const { findSimulationResult, prepareSimulation } = await import(
        new URL('../server/spice.mjs?heat-identity', import.meta.url).href
      );
      const keys: string[] = [];
      const files = {
        read: async (key: string) => {
          keys.push(key);
          return null;
        },
      };
      const plain = { ...deck, traces: deck.traces.map(({ dissipation: _, ...trace }) => trace) };
      await findSimulationResult(plain, new AbortController().signal, undefined, directory, files);
      await findSimulationResult(deck, new AbortController().signal, undefined, directory, files);
      await findSimulationResult(
        {
          ...deck,
          traces: deck.traces.map((trace) =>
            trace.dissipation
              ? {
                  ...trace,
                  dissipation: { ...trace.dissipation, positiveNode: '0', negativeNode: 'out' },
                }
              : trace,
          ),
        },
        new AbortController().signal,
        undefined,
        directory,
        files,
      );
      const legacyKey = createHash('sha256')
        .update(
          JSON.stringify([
            'openpe-spice-v2',
            createHash('sha256').update(solverBytes).digest('hex'),
            'ngspice-47 heat fixture',
            deck.netlist,
            deck.stop,
            deck.traces.map(({ unit, vector }) => [unit, vector]),
            deck.compatibility,
          ]),
        )
        .update(JSON.stringify([deck.netlist, deck.compatibility]))
        .digest('hex');
      assert.equal(keys[0], legacyKey);
      assert.notEqual(keys[1], legacyKey);
      assert.notEqual(keys[1], keys[2]);
      const linearizedHeatKey = createHash('sha256')
        .update(
          JSON.stringify([
            'openpe-spice-v2',
            createHash('sha256').update(solverBytes).digest('hex'),
            'ngspice-47 heat fixture',
            deck.netlist,
            deck.stop,
            deck.traces.map(({ unit, vector }) => [unit, vector]),
            deck.compatibility,
            [
              'full-resolution-dissipation-v1',
              deck.traces
                .filter((trace) => trace.dissipation)
                .map((trace) => [
                  trace.vector,
                  trace.dissipation!.positiveNode,
                  trace.dissipation!.negativeNode,
                ]),
            ],
          ]),
        )
        .update(JSON.stringify([deck.netlist, deck.compatibility]))
        .digest('hex');
      assert.notEqual(
        keys[1],
        linearizedHeatKey,
        'Native accepted-row summaries cannot reuse earlier linearized-output heat keys.',
      );
      const prepared = await prepareSimulation(
        deck,
        new AbortController().signal,
        undefined,
        directory,
      );
      assert.equal(prepared.key, keys[1]);
      assert.equal(Object.hasOwn(prepared, 'matchesPrevious'), false);
    } finally {
      childProcess.execFile = original;
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
