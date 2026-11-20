import { switchingStageFixture } from './fixtures/switching-stage';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyCircuit, createPart, pinPositions, uid } from '../lib/circuit';
import { createProject, serializeProject } from '../lib/project';
import {
  buildSpiceDeck,
  defaultTransient,
  passiveValue,
  spiceNets,
} from '../plugins/spice-simulation/domain/spice';
import {
  validatedSimulationResult,
  waveformIndices,
} from '../plugins/spice-simulation/domain/waveform';
import { parseWaveforms, runSimulation } from '../plugins/spice-simulation/host/spice.mjs';
import { startServer } from '../server/index.mjs';
import { child, children } from '../lib/sexpr';
import { unitGraphics } from '../lib/library';

test('Buck netlist uses actual pin numbers and source-referenced PWM without changing the project', () => {
  const d = switchingStageFixture(),
    before = JSON.stringify(d);
  const deck = buildSpiceDeck(d, defaultTransient(d));
  const { node } = spiceNets(d);
  const part = (ref: string) => d.parts.find((p) => p.ref === ref)!;
  const sw = part('Q1');
  assert.equal(node(part('J1'), '1'), node(sw, '2'));
  assert.equal(node(part('J3'), '1'), node(sw, '1'));
  assert.ok(deck.netlist.includes(`VPWM ${node(sw, '1')} ${node(sw, '3')} PULSE`));
  assert.ok(
    deck.netlist.includes(`D4 ${node(part('D1'), '2')} ${node(part('D1'), '1')} OPENPE_DIODE`),
  );
  assert.ok(deck.netlist.includes('i(l5)'));
  assert.ok(deck.netlist.includes('@d4[id]'));
  assert.doesNotMatch(deck.netlist, /^VSENSE\d+ /m);
  assert.equal(JSON.stringify(d), before);
  part('R1').ref = 'R1\n.control\nshell echo unsafe';
  assert.ok(!buildSpiceDeck(d, defaultTransient(d)).netlist.includes('unsafe'));
});

test('upstream symbol text styling is not a pin-map change, while moved electrical pins are rejected', () => {
  const d = switchingStageFixture();
  const p = d.parts.find((p) => p.libId === 'Device:C')!;
  const pin = unitGraphics(d.libraries[p.libId]).flatMap((unit) => children(unit, 'pin'))[0];
  const font = child(child(child(pin, 'number')!, 'effects')!, 'font');
  if (font) font.push('bold');
  assert.doesNotThrow(() => buildSpiceDeck(d, defaultTransient(d)));
  child(pin, 'at')![1] = '99';
  assert.throws(() => buildSpiceDeck(d, defaultTransient(d)), /modified pin definitions/);
});

test('net extraction joins T endpoints and named labels, but not incidental crossings', () => {
  const d = emptyCircuit();
  const terminal = (x: number, y: number) => {
    const p = createPart(d, 'Port', x, y);
    const pin = pinPositions(p, d.libraries[p.libId])[0];
    p.x += x - pin.x;
    p.y += y - pin.y;
    d.parts.push(p);
    return p;
  };
  const a = terminal(-10, 0),
    b = terminal(0, -10),
    c = terminal(20, 20);
  const ground = createPart(d, 'GND', -10, 0);
  d.parts.push(ground);
  d.wires = [
    { id: uid(), a: { x: -10, y: 0 }, b: { x: 10, y: 0 } },
    { id: uid(), a: { x: 0, y: -10 }, b: { x: 0, y: 10 } },
  ];
  let nets = spiceNets(d);
  assert.notEqual(nets.node(a, '1'), nets.node(b, '1'));
  d.labels = [
    { id: uid(), x: 0, y: -10, text: 'NET' },
    { id: uid(), x: 20, y: 20, text: 'NET' },
  ];
  nets = spiceNets(d);
  assert.equal(nets.node(b, '1'), nets.node(c, '1'));
  d.junctions.push({ id: uid(), x: 0, y: 0 });
  nets = spiceNets(d);
  assert.equal(nets.node(a, '1'), nets.node(b, '1'));
  d.junctions = [];
  d.wires[1].b = { x: 0, y: 0 };
  nets = spiceNets(d);
  assert.equal(nets.node(a, '1'), nets.node(b, '1'));
});

test('passive values preserve SI units and reject expressions or executable syntax', () => {
  assert.equal(passiveValue('10MΩ', 'R'), 1e7);
  assert.equal(passiveValue('10m', 'R'), 0.01);
  assert.equal(passiveValue('47uF / 50V', 'C'), 47e-6);
  assert.equal(passiveValue('22µH', 'L'), 22e-6);
  for (const value of [
    '0',
    '-10',
    'Infinity',
    '1e999',
    '{parameter}',
    '10k\n.control',
    '10XYZ',
    '1e-20',
  ])
    assert.throws(() => passiveValue(value, 'R'));
});

test('probe metadata binds every connected wire and pin to a net and preserves current directions', () => {
  const d = switchingStageFixture();
  const before = JSON.stringify(d);
  const deck = buildSpiceDeck(d, defaultTransient(d));
  const nets = spiceNets(d);
  // Node IDs are assigned on first use; compare electrical equivalence, not numbering.
  const vectorsByNode = new Map<string, string>();
  for (const entry of nets.probeNodes()) {
    const trace = deck.traces.find((t) =>
      t.targets?.some((target) => JSON.stringify(target) === JSON.stringify(entry.target)),
    );
    if (entry.node === '0') assert.equal(trace, undefined);
    else {
      assert.ok(trace);
      if (vectorsByNode.has(entry.node)) assert.equal(trace.vector, vectorsByNode.get(entry.node));
      else vectorsByNode.set(entry.node, trace.vector);
    }
  }
  assert.equal(new Set(vectorsByNode.values()).size, vectorsByNode.size);
  assert.equal(new Set(deck.traces.map((t) => t.vector)).size, deck.traces.length);
  for (const ref of ['R1', 'C1', 'L1', 'D1', 'Q1']) {
    const part = d.parts.find((p) => p.ref === ref)!;
    const trace = deck.traces.find((t) =>
      t.targets?.some((target) => target.kind === 'current' && target.id === part.id),
    );
    assert.equal(trace?.unit, 'A');
    assert.ok(deck.netlist.includes(trace!.vector));
    assert.match(trace!.label, ref === 'D1' ? /2 → 1/ : ref === 'Q1' ? /2 → 3/ : /1 → 2/);
  }
  assert.equal(JSON.stringify(d), before);
});

test('renderer rejects incomplete, nonfinite and incompatible traces and binds probes locally', () => {
  const d = switchingStageFixture();
  const deck = buildSpiceDeck(d, defaultTransient(d));
  const result = {
    version: 'fixture',
    log: 'test',
    time: [0, deck.stop],
    traces: deck.traces.map((trace) => ({ ...trace, targets: [], values: [0, 1] })),
  };
  assert.deepEqual(
    validatedSimulationResult(result, deck).traces[0].targets,
    deck.traces[0].targets,
  );
  assert.throws(
    () => validatedSimulationResult({ ...result, time: [0, deck.stop / 2] }, deck),
    /Incomplete/,
  );
  assert.throws(
    () => validatedSimulationResult({ ...result, traces: result.traces.slice(1) }, deck),
    /Restart/,
  );
  result.traces[0].values[1] = NaN;
  assert.throws(() => validatedSimulationResult(result, deck), /Invalid/);
});

test('invalid settings, unsupported components, islands and shorted drive are rejected', () => {
  const d = switchingStageFixture(),
    config = defaultTransient(d);
  for (const patch of [
    { duty: 0 },
    { duty: 100 },
    { step: 0 },
    { step: Infinity },
    { voltage: NaN },
    { stop: 0 },
    { inputId: config.outputId },
    { netlist: '.control' },
  ])
    assert.throws(() => buildSpiceDeck(d, { ...config, ...patch }));
  const other = structuredClone(d);
  other.parts[0].libId = 'Device:Unknown';
  assert.throws(() => buildSpiceDeck(other, config), /no simulation model/);
  const island = structuredClone(d);
  island.parts.push(createPart(island, 'R', 300, 300));
  assert.throws(() => buildSpiceDeck(island, config), /disconnected/);
  const custom = structuredClone(d);
  custom.parts[1].fields = { 'Sim.Model': 'vendor model' };
  assert.throws(() => buildSpiceDeck(custom, config), /custom SPICE/);
  const marked = structuredClone(d);
  marked.noConnects = [{ id: uid(), x: 1, y: 1 }];
  assert.throws(() => buildSpiceDeck(marked, config), /no-connect/);
});

test('waveform parser rejects partial, mismatched, nonfinite and non-monotonic solver output', () => {
  const d = switchingStageFixture(),
    deck = buildSpiceDeck(d, defaultTransient(d));
  const header = ['time', ...deck.traces.map((t) => t.vector)].join(' ');
  const good = `${header}\n0 ${deck.traces.map(() => 0).join(' ')}\n0.002 ${deck.traces.map((_, i) => [12, 24, 1.2][i] ?? 0).join(' ')}\n`;
  assert.deepEqual(parseWaveforms(good, deck).traces[0].values, [0, 12]);
  for (const text of [
    good.replace('time', 'frequency'),
    good.replace('0.002', '0.001'),
    good.replace('0.002', '0'),
    good.replace('\n0 0 0 0', '\n0.001 0 0 0'),
    good.replace('12 24', 'NaN 24'),
    good.replace('12 24', '12'),
  ])
    assert.throws(() => parseWaveforms(text, deck));
  const values = new Array(10000).fill(0);
  values[127] = 100;
  values[128] = -100;
  const indices = waveformIndices(values, 0, values.length - 1, 100);
  assert.ok(indices.includes(127) && indices.includes(128));
  assert.equal(indices[0], 0);
  assert.equal(indices.at(-1), 9999);
});

test('simulation API validates before running, rejects parallel runs, and aborts on disconnect/shutdown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-spice-api-'));
  let calls = 0;
  const signals: AbortSignal[] = [];
  let started: (() => void) | null = null;
  const server = await startServer({
    dataDir: directory,
    simulationDetector: async () => ({
      available: true,
      version: 'test solver',
      executable: '/private/path',
    }),
    simulationRunner: async (_deck: unknown, signal: AbortSignal) => {
      calls++;
      signals.push(signal);
      started?.();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      );
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const d = switchingStageFixture(),
    body = JSON.stringify({
      source: serializeProject(createProject(d)),
      config: defaultTransient(d),
    });
  const request = (payload: string, signal?: AbortSignal) =>
    fetch(server.base + '/api/simulation/transient', {
      method: 'POST',
      headers,
      body: payload,
      signal,
    });
  try {
    assert.equal((await fetch(server.base + '/api/simulation/status')).status, 401);
    assert.deepEqual(
      await (await fetch(server.base + '/api/simulation/status', { headers })).json(),
      { available: true, version: 'test solver' },
    );
    assert.equal((await request(JSON.stringify({ source: '{}', config: {} }))).status, 400);
    assert.equal(
      (
        await request(
          JSON.stringify({ source: JSON.parse(body).source, config: {}, executable: 'cmd.exe' }),
        )
      ).status,
      400,
    );
    assert.equal(calls, 0);
    const large = createProject(d);
    large.extensions.padding = '\\'.repeat(2_100_000);
    const largeResponse = await request(
      JSON.stringify({ source: serializeProject(large), config: {} }),
    );
    assert.equal(
      largeResponse.status,
      400,
      'JSON escaping must not reject a valid bounded project envelope.',
    );
    assert.match((await largeResponse.json()).error, /transient settings/);
    assert.equal(calls, 0);
    const control = new AbortController();
    let begin = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = request(body, control.signal).catch(() => null);
    await begin;
    assert.equal((await request(body)).status, 409);
    const aborted = new Promise<void>((resolve) =>
      signals[0].addEventListener('abort', () => resolve(), { once: true }),
    );
    control.abort();
    await pending;
    await aborted;
    begin = new Promise<void>((resolve) => {
      started = resolve;
    });
    const second = request(body).catch(() => null);
    await begin;
    server.close();
    await second;
    assert.ok(signals.every((signal) => signal.aborted));
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'real ngspice Buck transient responds to duty cycle',
  { skip: !process.env.OPENPE_TEST_NGSPICE },
  async () => {
    const d = switchingStageFixture();
    // 5 Ω keeps both duties in continuous conduction; the 10 Ω concept can enter DCM.
    d.parts.find((p) => p.ref === 'R1')!.value = '5Ω';
    const solve = async (duty: number) => {
      const config = { ...defaultTransient(d), duty, stop: 0.008, step: 2e-7 };
      const result = await runSimulation(buildSpiceDeck(d, config), new AbortController().signal);
      assert.match(result.version!, /ngspice-\d+/);
      const branch = (ref: string) => {
        const part = d.parts.find((p) => p.ref === ref)!;
        return result.traces.find((trace) =>
          trace.targets?.some((target) => target.kind === 'current' && target.id === part.id),
        )!.values;
      };
      const load = branch('R1'),
        capacitor = branch('C2'),
        inductor = branch('L1');
      for (let i = 1; i < result.time.length; i++) {
        assert.ok(
          Math.abs(load[i] - result.traces[0].values[i] / 5) < 1e-7,
          'Native resistor current must follow pin 1 → 2 and Ohm’s law.',
        );
        assert.ok(
          Math.abs(inductor[i] - load[i] - capacitor[i]) < 1e-5,
          'Native capacitor current must preserve the output-node current balance.',
        );
      }
      const start = result.time.findIndex((t) => t > 0.0079);
      let area = 0,
        currentArea = 0;
      for (let i = start + 1; i < result.time.length; i++) {
        const dt = result.time[i] - result.time[i - 1];
        area += (dt * (result.traces[0].values[i] + result.traces[0].values[i - 1])) / 2;
        currentArea += (dt * (result.traces[2].values[i] + result.traces[2].values[i - 1])) / 2;
      }
      const duration = result.time.at(-1)! - result.time[start];
      const voltage = area / duration;
      assert.ok(Math.abs(currentArea / duration - voltage / 5) < 0.2);
      return voltage;
    };
    const half = await solve(50),
      quarter = await solve(25);
    assert.ok(half > 11 && half < 13, `50% duty: ${half} V`);
    assert.ok(quarter > 5 && quarter < 7, `25% duty: ${quarter} V`);
  },
);
