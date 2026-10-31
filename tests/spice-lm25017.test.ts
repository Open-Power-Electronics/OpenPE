import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adaptLm25017, lm25017Latch } from '../server/spice-lm25017.mjs';
import { runSimulation } from '../server/spice.mjs';
import type { SpiceDeck } from '../lib/spice';

const id = 'reference-lm25017';
const deck = (): SpiceDeck => ({
  netlist:
    'Controller test\n.include example-model-0.lib\nX42 a 0 0 b c d e f g LM25017\n.save v(b)\n.end\n',
  modelIds: [id],
  stop: 0.01,
  traces: [{ vector: 'v(b)', label: 'Output', unit: 'V' }],
  assumptions: [],
});
test('controller state closure preserves original model, external circuit and timing components', async () => {
  const bytes = await readFile('examples/lm25017-wson8-flybuck/circuits/LM25017.lib');
  const before = Buffer.from(bytes),
    input = deck(),
    snapshot = structuredClone(input);
  const result = adaptLm25017(input, new Map([[id, bytes]]));
  assert.deepEqual(input, snapshot);
  assert.deepEqual(bytes, before);
  assert.match(result.netlist, /^X42 a 0 0 b c d e f g OPENPE_COMPAT_LM25017$/m);
  assert.match(result.netlist, /^\.include example-model-0.lib$/m);
  const original = /^\.subckt LM25017\b[\s\S]*?^\.ends LM25017\b/im.exec(
    bytes.toString('utf8'),
  )![0];
  for (const line of original.split(/\r?\n/).filter((line) => /^(?:R|C|L|D|X|V|G)/i.test(line)))
    assert.ok(result.netlist.includes(line), `Retain original element: ${line}`);
  assert.equal(result.stop, input.stop);
  assert.equal(result.traces, input.traces);
  assert.match(result.assumptions.at(-1)!, /approximate 1 ps/);
  assert.equal(result.compatibility, 'psa');
});
test('state closure rejects changed bytes, malformed calls, duplicate identities and reapplication', async () => {
  const bytes = await readFile('examples/lm25017-wson8-flybuck/circuits/LM25017.lib');
  const models = new Map([[id, bytes]]);
  assert.throws(() => adaptLm25017(deck(), new Map()), /SHA-256/);
  assert.throws(
    () => adaptLm25017(deck(), new Map([[id, Buffer.concat([bytes, Buffer.from('\n')])]])),
    /SHA-256/,
  );
  assert.throws(() => adaptLm25017({ ...deck(), modelIds: [id, id] }, models), /one original/);
  assert.throws(
    () => adaptLm25017({ ...deck(), netlist: deck().netlist.replace(' a 0', ' 0') }, models),
    /terminals/,
  );
  assert.throws(() => adaptLm25017(adaptLm25017(deck(), models), models), /already adapted/);
  const unrelated = { ...deck(), modelIds: ['unrelated'] };
  assert.equal(adaptLm25017(unrelated, models), unrelated);
});
test(
  'native event latch starts reset, sets, holds and resets with the original output-gate truth table',
  {
    skip: process.env.OPENPE_TEST_NGSPICE !== '1',
  },
  async () => {
    const stop = 10e-9;
    const fixture: SpiceDeck = {
      ...deck(),
      modelIds: [],
      stop,
      compatibility: 'psa',
      netlist: `Latch truth and hold sequence
VS U2_SET 0 PWL(0 0 1n 0 1.01n 5 2n 5 2.01n 0 7n 0 7.01n 5 8n 5 8.01n 0)
VR U2_RESET 0 PWL(0 0 4n 0 4.01n 5 5n 5 5.01n 0 7n 0 7.01n 5 8n 5 8.01n 0)
${lm25017Latch}
RQ U2_Q_ND 0 1k
RQB U2_QB_ND 0 1k
.save v(U2_Q_ND) v(U2_QB_ND)
.control
set wr_singlescale
set wr_vecnames
set numdgt=15
tran 10p 10n 0 10p uic
linearize
wrdata waveforms.txt v(U2_Q_ND) v(U2_QB_ND)
quit
.endc
.end`,
      traces: [
        { vector: 'v(u2_q_nd)', label: 'Q', unit: 'V' },
        { vector: 'v(u2_qb_nd)', label: 'QB', unit: 'V' },
      ],
    };
    const result = await runSimulation(fixture, new AbortController().signal);
    for (const [at, q, qb] of [
      [0.5, 0, 5],
      [1.5, 5, 0],
      [3, 5, 0],
      [4.5, 0, 5],
      [6, 0, 5],
      [7.5, 0, 0],
      [9, 0, 5],
    ]) {
      const index = result.time.findIndex((time) => time >= at * 1e-9);
      assert.ok(index >= 0);
      assert.ok(Math.abs(result.traces[0].values[index] - q) < 0.01, `Q at ${at} ns`);
      assert.ok(Math.abs(result.traces[1].values[index] - qb) < 0.01, `QB at ${at} ns`);
    }
  },
);
