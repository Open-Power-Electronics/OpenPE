import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SpiceDeck } from '../plugins/spice-simulation/domain/spice';
import { readNativeSpiceRows } from '../plugins/spice-simulation/host/spice-raw.mjs';
import {
  parseWaveforms,
  readNativeSpiceDissipation,
} from '../plugins/spice-simulation/host/spice-waveforms.mjs';

const deck: SpiceDeck = {
  netlist: '',
  stop: 1,
  assumptions: [],
  traces: [
    { label: 'Voltage', vector: 'v(out)', unit: 'V' },
    {
      label: 'Current',
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
function nativeRows(rows: number[][], changeHeader = (header: string) => header) {
  const header = changeHeader(
    `Title: Heat fixture\nPlotname: Transient Analysis\nFlags: real\nNo. Variables: 3\nNo. Points: ${rows.length}\nVariables:\n0 time time\n1 i(r1) current\n2 v(out) voltage\nBinary:\n`,
  );
  const data = Buffer.alloc(rows.length * 24);
  rows.forEach(([time, voltage, current], index) => {
    data.writeDoubleLE(time, index * 24);
    data.writeDoubleLE(current, index * 24 + 8);
    data.writeDoubleLE(voltage, index * 24 + 16);
  });
  return Buffer.concat([Buffer.from(header), data]);
}

test('native switching samples retain positive heat when interpolated display V/I creates negative power', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-native-heat-'));
  const file = path.join(directory, 'waveforms.raw');
  try {
    const rows = [[0, 0, 0]];
    for (let i = 0; i <= 10; i++) rows.push([0.8 + i * 0.02, i % 2 ? -10 : 1, i % 2 ? -1 : 10]);
    await writeFile(file, nativeRows(rows));
    const heat = await readNativeSpiceDissipation(file, deck);
    assert.equal(heat!.sampleCount, rows.length);
    assert.equal(heat!.startS, 0.8);
    assert.equal(heat!.endS, 1);
    assert.ok(Math.abs(heat!.powers[0].powerW - 10) < 1e-10);
    const uic = rows.map((row, index) => (index === 0 ? [1e-11, ...row.slice(1)] : row));
    await writeFile(file, nativeRows(uic));
    const uicHeat = await readNativeSpiceDissipation(file, deck);
    assert.equal(uicHeat!.sampleCount, uic.length);
    assert.ok(Math.abs(uicHeat!.powers[0].powerW - 10) < 1e-10);
    const linearized = parseWaveforms(
      'time v(out) i(r1)\n0 0 0\n0.8 1 10\n0.85 -4.5 4.5\n0.9 -10 -1\n0.95 -4.5 4.5\n1 1 10\n',
      deck,
    );
    assert.ok(linearized.dissipation!.powers[0].powerW < 0);
    assert.notEqual(heat!.powers[0].powerW, linearized.dissipation!.powers[0].powerW);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native heat includes every accepted row beyond display limits and retains signed window weighting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-native-heat-count-'));
  const file = path.join(directory, 'waveforms.raw');
  try {
    const rows = Array.from({ length: 210001 }, (_, i) => [i / 210000, 10, i % 20 === 0 ? 20 : 0]);
    await writeFile(file, nativeRows(rows));
    const heat = await readNativeSpiceDissipation(file, deck);
    assert.equal(heat!.sampleCount, rows.length);
    assert.ok(Math.abs(heat!.powers[0].powerW - 10) < 1e-8);
    await writeFile(
      file,
      nativeRows([
        [0, 10, -2],
        [0.5, 10, -2],
        [1.0000001, 10, -4],
      ]),
    );
    const signed = await readNativeSpiceDissipation(file, deck);
    assert.ok(Math.abs(signed!.powers[0].powerW + 35.99999680000064) < 1e-9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('completed native heat rejects malformed headers, incomplete rows, invalid samples and cancellation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-native-heat-invalid-'));
  const file = path.join(directory, 'waveforms.raw');
  const rows = [
    [0, 1, 1],
    [0.8, 1, 1],
    [1, 1, 1],
  ];
  const valid = nativeRows(rows);
  try {
    const malformed = [
      valid.subarray(0, valid.length - 1),
      valid.subarray(0, valid.length - 24),
      Buffer.concat([valid, Buffer.alloc(24)]),
      nativeRows(rows, (header) => header.replace('v(out)', 'v(missing)')),
      nativeRows(rows, (header) => header.replace('1 i(r1)', '7 i(r1)')),
      nativeRows(rows, (header) => header.replace('i(r1) current', 'v(out) voltage')),
      nativeRows(rows, (header) => header.replace('v(out) voltage', 'v(out) current')),
      nativeRows(rows, (header) => header.replace('Flags: real', 'Flags: complex')),
      nativeRows([
        [0, 1, 1],
        [0.8, NaN, 1],
        [1, 1, 1],
      ]),
      nativeRows([
        [0, 1, 1],
        [0.8, 1, Infinity],
        [1, 1, 1],
      ]),
      nativeRows([
        [0, 1, 1],
        [0.8, 1, 1],
        [0.8, 1, 1],
      ]),
      nativeRows([
        [0.81, 1, 1],
        [0.9, 1, 1],
        [1, 1, 1],
      ]),
      nativeRows([
        [0, 1, 1],
        [0.8, 1, 1],
        [0.99, 1, 1],
      ]),
    ];
    for (const bytes of malformed) {
      await writeFile(file, bytes);
      await assert.rejects(readNativeSpiceDissipation(file, deck), /native waveform/i);
    }
    await writeFile(file, valid);
    await assert.rejects(readNativeSpiceDissipation(file, deck, AbortSignal.abort()), /abort/i);
    const control = new AbortController();
    let received = 0;
    await assert.rejects(
      readNativeSpiceRows(
        file,
        deck,
        () => {
          received++;
          control.abort();
        },
        control.signal,
      ),
      /abort/i,
    );
    assert.equal(received, 1);
    const missingTerminal: SpiceDeck = {
      ...deck,
      traces: deck.traces.map((trace) =>
        trace.dissipation
          ? { ...trace, dissipation: { ...trace.dissipation, negativeNode: 'missing' } }
          : trace,
      ),
    };
    await assert.rejects(readNativeSpiceDissipation(file, missingTerminal), /terminal voltage/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
