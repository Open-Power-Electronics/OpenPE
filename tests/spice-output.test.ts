import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readWaveforms } from '../plugins/spice-simulation/host/spice-waveforms.mjs';
import { validatedSimulationResult } from '../plugins/spice-simulation/domain/waveform';
import type { SpiceDeck } from '../plugins/spice-simulation/domain/spice';

const deck: SpiceDeck = {
  netlist: '',
  stop: 1,
  assumptions: [],
  traces: [
    { label: 'Output', vector: 'v(out)', unit: 'V' },
    { label: 'Current', vector: 'i(l1)', unit: 'A' },
  ],
};

test('completed output beyond former byte/sample limits streams to bounded actual extrema', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-large-waveform-'));
  const file = path.join(directory, 'waveforms.txt');
  const handle = await open(file, 'w');
  const padding = ' '.repeat(150);
  try {
    await handle.write('time v(out) i(l1)\n');
    for (let start = 0; start <= 210000; start += 1000) {
      const lines = [];
      for (let i = start; i < Math.min(start + 1000, 210001); i++)
        lines.push(`${i / 210000}${padding}${i === 123456 ? 99 : 1} ${i === 123457 ? -77 : 2}\n`);
      await handle.write(lines.join(''));
    }
    await handle.close();
    assert.ok((await stat(file)).size > 32 * 1024 * 1024);
    const result = await readWaveforms(file, deck, new AbortController().signal);
    assert.ok(result.time.length < 200000);
    assert.ok(result.time.length * 3 <= 1100000);
    assert.equal(result.time[0], 0);
    assert.equal(result.time.at(-1), 1);
    assert.equal(result.traces[0].values[result.time.indexOf(123456 / 210000)], 99);
    assert.equal(result.traces[1].values[result.time.indexOf(123457 / 210000)], -77);
    validatedSimulationResult({ ...result, version: 'fixture', log: '' }, deck);
    const control = new AbortController();
    control.abort();
    await assert.rejects(readWaveforms(file, deck, control.signal), { name: 'AbortError' });
    await assert.rejects(readWaveforms(path.join(directory, 'missing.txt'), deck), /ENOENT/);
    await appendFile(file, '1.1 NaN 2\n');
    await assert.rejects(readWaveforms(file, deck), /invalid or non-monotonic/);
  } finally {
    await handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});
