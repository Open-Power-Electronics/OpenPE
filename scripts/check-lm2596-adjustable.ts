// Explicit offline real-solver verification of the derivative before/after Home regeneration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { lm2596AdjustableDerivedModel as model } from '../lib/reference-models';
import { deriveLm2596AdjustableModel } from '../plugins/spice-simulation/host/spice-lm2596-adj.mjs';
import { adaptSpiceModels } from '../plugins/spice-simulation/host/spice-model-adapters.mjs';
import { runSimulation } from '../plugins/spice-simulation/host/spice.mjs';
import type { SpiceDeck, SimulationResult } from '../plugins/spice-simulation/domain/spice';
import { verifyHomeOutput, voltageWindow } from './home-simulation-verification';

const directory = 'test-results/lm2596-adjustable';
await mkdir(directory, { recursive: true });
const originalPath = `resources/example-catalog/simulation/models/${model.sourceModelId}-${model.sourceSha256}.lib`;
const original = await readFile(originalPath);
assert.equal(createHash('sha256').update(original).digest('hex'), model.sourceSha256);
const derived = deriveLm2596AdjustableModel(original);
await writeFile(`${directory}/${model.subcircuit}.lib`, derived);
const store = async (id: string) => {
  assert.equal(id, model.sourceModelId);
  return original;
};
const cases = [
  { id: '5v', upper: 3090, lower: 1010, input: 12, load: 100, initial: 5, duration: 0.01 },
  {
    id: '3v3-feedback',
    upper: 1690,
    lower: 1010,
    input: 12,
    load: 100,
    initial: 3.3,
    duration: 0.01,
  },
];
// This separate stress case is deliberately available as a failing qualification
// check. Its observed low-frequency ripple is not part of the validated Home point.
const stress = {
  id: '5v-discharged-output',
  upper: 3090,
  lower: 1010,
  input: 12,
  load: 10,
  initial: 0,
  duration: 0.02,
};
const selected = process.argv[2]
  ? [...cases, stress].filter((entry) => entry.id === process.argv[2])
  : cases;
assert.ok(selected.length, 'No derivative verification case matched the requested ID.');
const summary = [];
for (const entry of selected) {
  const target = model.referenceVoltage * (1 + entry.upper / entry.lower);
  const deck: SpiceDeck = {
    modelIds: [model.sourceModelId],
    compatibility: 'ps',
    stop: entry.duration,
    assumptions: [model.description],
    traces: [
      { label: 'V(VOUT)', unit: 'V', vector: 'v(out)' },
      { label: 'V(FB)', unit: 'V', vector: 'v(fb)' },
      { label: 'I(L1)', unit: 'A', vector: 'i(l1)' },
    ],
    netlist: `OpenPE LM2596 adjustable derivative verification
.options itl4=1000 reltol=0.005 method=gear
.include example-model-0.lib
.model OPENPE_BOOST_D D(Is=1u N=1.05 Rs=0.02)
V1 vin 0 DC ${entry.input}
RSERIN vin cin 0.05
CIN cin 0 100u IC=${entry.input}
X1 vin fb sw 0 0 ${model.subcircuit}
D1 0 sw OPENPE_BOOST_D
RSERL sw coil 0.05
L1 coil out 330u
RSEROUT out cout 0.05
COUT cout 0 330u IC=${entry.initial}
RTOP out fb ${entry.upper}
RBOTTOM fb 0 ${entry.lower}
RLOAD out 0 ${entry.load}
.save v(out) v(fb) i(l1)
.control
set wr_singlescale
set wr_vecnames
set numdgt=15
tran 2e-7 ${entry.duration} 0 2e-7 uic
linearize
wrdata waveforms.txt v(out) v(fb) i(l1)
quit
.endc
.end
`,
  };
  const executed = adaptSpiceModels(deck, new Map([[model.sourceModelId, original]]));
  await writeFile(`${directory}/${entry.id}-executed.cir`, executed.netlist);
  const started = performance.now();
  const result: SimulationResult = await runSimulation(deck, new AbortController().signal, store);
  let metrics: ReturnType<typeof verifyHomeOutput>;
  try {
    metrics = verifyHomeOutput(
      result.time,
      result.traces[0].values,
      [target * 0.98, target * 1.02],
      entry.duration,
    );
  } catch (error) {
    await writeFile(
      `${directory}/${entry.id}-failure.json`,
      JSON.stringify(
        {
          ...entry,
          target,
          error: String(error),
          stop: result.time.at(-1),
          sourceSha256: model.sourceSha256,
          executedDeckSha256: createHash('sha256').update(executed.netlist).digest('hex'),
        },
        null,
        2,
      ) + '\n',
    );
    throw error;
  }
  const feedback = result.traces[1].values.at(-1)!;
  assert.ok(
    Math.abs(feedback - model.referenceVoltage) < 0.03,
    'FB must regulate near the preserved reference.',
  );
  const record = {
    ...entry,
    target,
    ...metrics,
    feedback,
    version: result.version,
    stop: result.time.at(-1),
    samples: result.time.length,
    durationMs: Math.round(performance.now() - started),
    sourceSha256: model.sourceSha256,
    derivedSha256: createHash('sha256').update(derived).digest('hex'),
    executedDeckSha256: createHash('sha256').update(executed.netlist).digest('hex'),
    peakCurrent: result.traces[2].values.reduce(
      (maximum, value) => Math.max(maximum, value),
      -Infinity,
    ),
    minimumOutput: result.traces[0].values.reduce(
      (minimum, value) => Math.min(minimum, value),
      Infinity,
    ),
    maximumOutput: result.traces[0].values.reduce(
      (maximum, value) => Math.max(maximum, value),
      -Infinity,
    ),
    ...(entry.duration > 0.01
      ? { startup10ms: voltageWindow(result.time, result.traces[0].values, 0.008, 0.01) }
      : {}),
  };
  summary.push(record);
  await writeFile(`${directory}/${entry.id}.json`, JSON.stringify(record, null, 2) + '\n');
  console.log(
    `PASS ${entry.id}: ${metrics.mean.toFixed(6)} V; ${metrics.ripplePercent.toFixed(3)}% ripple; FB ${feedback.toFixed(6)} V`,
  );
}
if (summary.length === cases.length)
  assert.ok(
    summary[0].mean - summary[1].mean > 1.5,
    'External feedback must adjust output rather than retain fixed 5 V.',
  );
assert.deepEqual(
  await readFile(originalPath),
  original,
  'The original official model must remain unchanged.',
);
await writeFile(
  `${directory}/summary${process.argv[2] ? '-filtered' : ''}.json`,
  JSON.stringify(summary, null, 2) + '\n',
);
