import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { projectFromNativeFiles, serializeProject } from '../lib/project';
import {
  buildSpiceDeck,
  defaultTransient,
  simulationSupportError,
  type SpiceDeck,
  passiveValue,
} from '../lib/spice';
import { runSimulation } from '../server/spice.mjs';
import { projectSimulationModels } from '../server/project-models.mjs';
import { readProjectModelFile } from '../server/project-model-files.mjs';
import { validatedSimulationResult } from '../lib/waveform';
import { spiceVectorName } from '../server/spice-raw.mjs';
import { partFields } from '../lib/library';
import { simulationSourceValues } from '../lib/simulation-source-parameters';

type MeasurementWindow = {
  startS: number;
  endS: number;
  means: number[];
  minimums: number[];
  maximums: number[];
  segments: number;
};
type FullMeasurements = {
  rows: number;
  drainPeakV: number;
  fullRunDrainPeakV: number;
  final: MeasurementWindow;
  beforeStep: MeasurementWindow;
  lightLoad: MeasurementWindow;
};
/** Read every completed linearized export row before its display reduction.
 * Device heat comes from the runner's separate original native-raw summary. */
async function measureFullOutput(file: string, current: SpiceDeck): Promise<FullMeasurements> {
  const q = current.traces.find((trace) => trace.vector === '@mq1[id]')!.dissipation!;
  const selected = [
    'time',
    current.traces[0].vector,
    'i(v1)',
    `v(${q.positiveNode})`,
    `v(${q.negativeNode})`,
    'i(lpri)',
    '@d3[id]',
    '@d7[id]',
  ];
  const definitions = [
    { startS: 0.0016, endS: 0.002 },
    { startS: 0.0036, endS: 0.004 },
    { startS: current.stop * 0.8, endS: current.stop },
  ];
  const windows = definitions.map((window) => ({
    ...window,
    means: new Array<number>(7).fill(0),
    minimums: new Array<number>(7).fill(Infinity),
    maximums: new Array<number>(7).fill(-Infinity),
    segments: 0,
  }));
  const input = createReadStream(file, { encoding: 'utf8' }),
    lines = createInterface({ input, crlfDelay: Infinity });
  let columns: number[] | undefined,
    previousTime = -1,
    previous: number[] | undefined,
    previousDrain: number | undefined,
    drainPeakV = -Infinity,
    fullRunDrainPeakV = -Infinity,
    rows = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const cells = line.trim().split(/\s+/);
      if (!columns) {
        const header = cells.map(spiceVectorName);
        assert.deepEqual(header, [
          'time',
          ...current.traces.map((trace) => trace.vector.toLowerCase()),
        ]);
        columns = selected.map((vector) => header.indexOf(vector));
        assert.ok(
          columns.every((column) => column >= 0),
          'Missing comparison waveform vector.',
        );
        continue;
      }
      const sample = columns.map((column) => Number(cells[column]));
      const time = sample[0],
        vout = sample[1];
      assert.ok(
        sample.every(Number.isFinite) && time > previousTime,
        'Invalid completed exported samples.',
      );
      const drain = sample[3];
      const finalStart = current.stop * 0.8;
      fullRunDrainPeakV = Math.max(fullRunDrainPeakV, drain);
      if (time >= finalStart) {
        drainPeakV = Math.max(drainPeakV, drain);
        if (previousDrain !== undefined && previousTime < finalStart)
          drainPeakV = Math.max(
            drainPeakV,
            previousDrain +
              ((drain - previousDrain) * (finalStart - previousTime)) / (time - previousTime),
          );
      }
      const values = [
        vout,
        -inputVoltage * sample[2],
        (vout * vout) / emcFlybackLoadOhms + vout * (time >= 0.00201 && time <= 0.00401 ? 0 : 0.5),
        sample[3] - sample[4],
        sample[5],
        sample[6],
        sample[7],
      ];
      if (previous)
        for (const window of windows) {
          const a = Math.max(window.startS, previousTime),
            b = Math.min(window.endS, time);
          if (b <= a) continue;
          const fractionA = (a - previousTime) / (time - previousTime),
            fractionB = (b - previousTime) / (time - previousTime);
          for (let i = 0; i < values.length; i++) {
            const va = previous[i] + (values[i] - previous[i]) * fractionA,
              vb = previous[i] + (values[i] - previous[i]) * fractionB;
            window.means[i] += (va + vb) * 0.5 * (b - a);
            window.minimums[i] = Math.min(window.minimums[i], va, vb);
            window.maximums[i] = Math.max(window.maximums[i], va, vb);
          }
          window.segments++;
        }
      previousTime = time;
      previous = values;
      previousDrain = drain;
      rows++;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  assert.ok(rows > 1 && Math.abs(previousTime - current.stop) <= 1e-12);
  for (const window of windows) {
    assert.ok(window.segments > 1);
    window.means = window.means.map((area) => area / (window.endS - window.startS));
  }
  return {
    rows,
    drainPeakV,
    fullRunDrainPeakV,
    beforeStep: windows[0],
    lightLoad: windows[1],
    final: windows[2],
  };
}

// Offline, real bundled ngspice check; never invokes Electron or fetches models.
const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const nativePath = path.resolve('examples/emc-flyback/emc-flyback.kicad_pro');
const native = await readNativeProject(nativePath);
const project = projectFromNativeFiles(native);
const snapshot = serializeProject(project);
const load = project.schematic.parts.find((part) => part.ref === 'R22')!;
const emcFlybackLoadOhms = passiveValue(load.value, 'R');
const supply = project.schematic.parts.find((part) => part.ref === 'V1')!;
const inputVoltage = simulationSourceValues(
  'DC',
  partFields(supply)['Sim.Params'],
  supply.value,
  supply.ref,
).dc;
const source = native.files.find((file: { name: string }) =>
  file.name.endsWith('.kicad_sch'),
)!.source;
const circuit = project.schematic;
assert.equal(simulationSupportError(circuit), '');
const config = defaultTransient(circuit),
  deck = buildSpiceDeck(circuit, config);
const started = Date.now();
let full: FullMeasurements | undefined;
const projectModels = projectSimulationModels(
  project,
  async () => {
    throw new Error('The offline EMC Flyback check requires project-local model files.');
  },
  {
    read: (_grant: string, model: { id: string; sha256: string; file: string }) =>
      readProjectModelFile(nativePath, model),
    write: async () => {},
  },
  'isolated-native-verification',
);
const result = validatedSimulationResult(
  await runSimulation(
    deck,
    new AbortController().signal,
    projectModels.store,
    undefined,
    undefined,
    {
      read: async () => null,
      write: async (_key: string, directory: string) => {
        full = await measureFullOutput(path.join(directory, 'waveforms.txt'), deck);
      },
    },
    config,
  ),
  deck,
);
assert.ok(full);
assert.deepEqual(await readNativeProject(nativePath), native, 'Simulation preserves native files.');
const voltage = result.traces.find((t) => t.vector === deck.traces[0].vector)!;
const mean = (start: number, end: number) => {
  let area = 0,
    minimum = Infinity,
    maximum = -Infinity;
  for (let i = 1; i < result.time.length; i++) {
    const a = Math.max(start, result.time[i - 1]),
      b = Math.min(end, result.time[i]);
    if (b <= a) continue;
    const va =
      voltage.values[i - 1] +
      ((voltage.values[i] - voltage.values[i - 1]) * (a - result.time[i - 1])) /
        (result.time[i] - result.time[i - 1]);
    const vb =
      voltage.values[i - 1] +
      ((voltage.values[i] - voltage.values[i - 1]) * (b - result.time[i - 1])) /
        (result.time[i] - result.time[i - 1]);
    area += ((va + vb) / 2) * (b - a);
    minimum = Math.min(minimum, va, vb);
    maximum = Math.max(maximum, va, vb);
  }
  return { mean: area / (end - start), minimum, maximum, ripple: maximum - minimum };
};
const beforeStep = mean(0.0016, 0.00199),
  lightLoad = mean(0.0036, 0.00399),
  final = mean(config.stop - 0.0004, config.stop);
// The upstream .meas named Vds_max actually measures V(drain) to ground.
// Read every linearized export row; display reduction and trace-count-dependent
// extrema buckets must not determine the measurement interval or its peak.
const { drainPeakV, fullRunDrainPeakV } = full;
assert.ok(Number.isFinite(drainPeakV));
const upstreamText = await readFile(
  'resources/example-catalog/sources/emc-flyback/simulation/README.md',
  'utf8',
);
const upstreamManifest = JSON.parse(
  await readFile('resources/example-catalog/sources/emc-flyback/source-manifest.json', 'utf8'),
) as { commit: string; files: { path: string; sha256: string }[] };
const upstreamSha256 = createHash('sha256').update(upstreamText).digest('hex');
assert.equal(
  upstreamManifest.files.find((file) => file.path === 'simulation/README.md')!.sha256,
  upstreamSha256,
);
const comparison = {
  sameOperatingPoint: false,
  reason:
    'The Home bench uses a 100 ohm external resistor plus the retained 0.5 A step. Upstream measurements use 24.4 ohm, so their numeric tolerances do not apply to this run.',
  upstream: {
    commit: upstreamManifest.commit,
    reference: 'simulation/README.md',
    sha256: upstreamSha256,
    url: `https://github.com/ChengminLi/AI-PCB-layout/blob/${upstreamManifest.commit}/examples/emc-flyback-demo/simulation/README.md`,
    conditions:
      '24 V input, Rg 4.7 ohm, CTR 1, external resistor 24.4 ohm plus 0.5 A; upstream power balance uses 2 ns.',
  },
};
const measurements = {
  externalLoadOhms: emcFlybackLoadOhms,
  additionalLoadStepA: 0.5,
  exportedOutputRows: full.rows,
  window: { startS: full.final.startS, endS: full.final.endS },
  drainMeasurement: {
    reference: 'The ASC .meas Vds_max measures V(drain) relative to simulator ground.',
    method:
      'Every linearized-export drain-to-ground sample, with interpolation at the final-window boundary, before display reduction.',
    fullRunDrainPeakV,
    modelDrainSourcePeakV: full.final.maximums[3],
    note: 'The differential model-pin drain-source peak is reported separately and is not the same measurement as the upstream 66 V reference.',
  },
  final: {
    outputVoltageV: full.final.means[0],
    outputRippleV: full.final.maximums[0] - full.final.minimums[0],
    inputPowerW: full.final.means[1],
    outputPowerW: full.final.means[2],
    efficiencyPercent: (100 * full.final.means[2]) / full.final.means[1],
    primaryCurrentPeakA: full.final.maximums[4],
    diodeMeanCurrentsA: full.final.means.slice(5),
    diodePeakCurrentsA: full.final.maximums.slice(5),
  },
};
const destination = 'test-results/emc-flyback-simulation';
await mkdir(destination, { recursive: true });
await writeFile(`${destination}/circuit.cir`, deck.netlist);
for (const [index, id] of (deck.modelIds ?? []).entries())
  await writeFile(
    `${destination}/example-model-${index}.lib`,
    await projectModels.store(id, new AbortController().signal),
  );
await writeFile(`${destination}/result.json`, JSON.stringify(result));
const summary = {
  solver: result.version,
  config,
  elapsedMs: Date.now() - started,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  snapshotSha256: createHash('sha256').update(snapshot).digest('hex'),
  deckSha256: createHash('sha256').update(deck.netlist).digest('hex'),
  samples: result.time.length,
  traces: result.traces.length,
  beforeStep,
  lightLoad,
  final,
  dissipation: result.dissipation,
  measurements,
  comparison,
  assumptions: deck.assumptions,
};
await writeFile(`${destination}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
for (const window of [beforeStep, lightLoad, final])
  assert.ok(window.mean > 11.8 && window.mean < 12.7, JSON.stringify(window));
assert.ok(result.time.at(-1)! >= config.stop * (1 - 1e-6));
assert.ok(result.dissipation && result.dissipation.sampleCount > result.time.length);
assert.equal(result.dissipation.startS, config.stop * 0.8);
assert.equal(result.dissipation.endS, config.stop);
for (const entry of result.dissipation.powers)
  assert.ok(Number.isFinite(entry.powerW) && entry.powerW >= -1e-9, entry.vector);
const deliveredCurrent = full.final.means[5] + full.final.means[6];
const expectedLoadCurrent = full.final.means[0] / emcFlybackLoadOhms + 0.5;
assert.ok(
  Math.abs(deliveredCurrent - expectedLoadCurrent) < 0.03,
  'Final mean rectifier current must supply the 100 ohm resistor and retained 0.5 A load.',
);
