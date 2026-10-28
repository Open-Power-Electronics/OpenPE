import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createExample } from '../lib/examples';
import { buildSpiceDeck, defaultTransient, simulationSupportError, spiceNets } from '../lib/spice';
import { buckPinMap } from '../lib/spice-buck';
import { validatedSimulationResult } from '../lib/waveform';
import { runSimulation } from '../server/spice.mjs';
import { children, child } from '../lib/sexpr';
import { unitGraphics } from '../lib/library';
import model from '../lib/buck-simulation.json';

const fixture = () => createExample('kicad-buck').schematic;
test('bundled Buck model matches the pinned upstream source', async () => {
  const source = await readFile('resources/spice/IRF-Power-VDMOS.mod', 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), model.modelSha256);
  assert.ok(source.split(/\r?\n/).includes(model.definition));
  assert.equal(model.license, 'CC-BY-SA-4.0');
});

test('official Buck produces a numeric VDMOS deck with preserved Sim.Pins, sources and probes', () => {
  const d = fixture(),
    before = JSON.stringify(d),
    c = defaultTransient(d);
  assert.equal(simulationSupportError(d), '');
  assert.equal(c.voltage, 12);
  assert.equal(c.frequency, 20000);
  assert.equal(c.duty, 50);
  const deck = buildSpiceDeck(d, c);
  assert.match(deck.netlist, /\.model IRF540N vdmos/);
  assert.doesNotMatch(deck.netlist, /OPENPE_SWITCH|\.include|\$\{SIM.PARAMS\}/);
  const pulse = deck.netlist
    .match(/PULSE\(([^)]+)\)/)![1]
    .split(' ')
    .map(Number);
  [0, 15, 2e-8, 2e-8, 2e-8, 25e-6, 50e-6].forEach((expected, i) =>
    assert.ok(Math.abs(pulse[i] - expected) < 1e-12),
  );
  const q = d.parts.find((p) => p.ref === 'Q1')!,
    nets = spiceNets(d);
  assert.deepEqual(
    [...buckPinMap(d, q)],
    [
      ['D', '1'],
      ['G', '2'],
      ['S', '3'],
    ],
  );
  // Assign nodes in deck order before comparing the generated MOS terminal order.
  nets.node(
    d.parts.find((p) => p.id === c.outputId)!,
    '1',
  );
  d.parts
    .filter((p) => p.libId !== 'power:GND')
    .forEach((p) => [...buckPinMap(d, p).values()].forEach((pin) => nets.node(p, pin)));
  assert.ok(deck.netlist.includes(`M2 sense2 ${nets.node(q, '2')} ${nets.node(q, '3')} IRF540N`));
  assert.match(
    deck.traces.find((t) =>
      t.targets?.some((target) => target.kind === 'current' && target.id === q.id),
    )!.label,
    /pin 1 → 3/,
  );
  for (const entry of spiceNets(d).probeNodes()) {
    const found = deck.traces.some((t) =>
      t.targets?.some(
        (target) =>
          target.id === entry.target.id &&
          target.kind === entry.target.kind &&
          target.pin === entry.target.pin,
      ),
    );
    assert.equal(found, entry.node !== '0');
  }
  assert.equal(JSON.stringify(d), before);
});

test('model path, expressions, extra fields, malformed mappings and altered pins fail visibly', () => {
  for (const [ref, key, value] of [
    ['Q1', 'Sim.Library', '../IRF-Power-VDMOS.mod'],
    ['Q1', 'Sim.Name', 'OTHER'],
    ['Q1', 'Sim.Params', 'vto=4'],
    ['Q1', 'Sim.Pins', '1=D 1=G 3=S'],
    ['Q1', 'Sim.Pins', '1=D 2=G'],
    ['Q1', 'Sim.Pins', '1=D 2=G 4=S'],
    ['Q1', 'Spice_Netlist_Enabled', 'Y'],
    ['Q1', 'Sim.Type', 'SUBCKT'],
    ['R103', 'Sim.Params', 'r={param}'],
    ['R103', 'Sim.Params', 'r=5 r=10'],
    ['R103', 'Sim.Params', 'r=5\n.control'],
    ['V101', 'Sim.Params', 'y1=0 y2=15'],
    ['D101', 'Sim.Library', 'IRF-Power-VDMOS.mod'],
  ]) {
    const d = fixture(),
      p = d.parts.find((p) => p.ref === ref)!;
    p.fields = { ...p.fields, [key]: value };
    assert.throws(() => buildSpiceDeck(d, defaultTransient(d)), Error, `${ref} ${key} ${value}`);
  }
  const d = fixture(),
    cap = d.parts.find((p) => p.ref === 'C101')!;
  const pin = unitGraphics(d.libraries[cap.libId]).flatMap((s) => children(s, 'pin'))[0];
  child(pin, 'at')![1] = '100';
  assert.throws(() => buildSpiceDeck(d, defaultTransient(d)), /modified pin/);
});

test('changed explicit pin mappings are honored and electrical overrides remain rejected', () => {
  const d = fixture(),
    q = d.parts.find((p) => p.ref === 'Q1')!;
  q.fields = { ...q.fields, 'Sim.Pins': '1=G 2=D 3=S' };
  const pulse = d.parts.find((p) => p.ref === 'V101')!;
  pulse.fields = {
    ...pulse.fields,
    'Sim.Params': 'y1=0 y2=15 td=20n tr=20n tf=20n tw=12.5u per=50u',
  };
  const c = defaultTransient(d),
    deck = buildSpiceDeck(d, c);
  assert.match(deck.traces.find((t) => t.label.startsWith('I(Q1)'))!.label, /pin 2 → 3/);
  const pulseValues = deck.netlist
    .match(/PULSE\(([^)]+)\)/)![1]
    .split(' ')
    .map(Number);
  assert.ok(Math.abs(pulseValues[5] - 12.5e-6) < 1e-12);
  assert.ok(Math.abs(pulseValues[6] - 50e-6) < 1e-12);
  for (const patch of [
    { duty: 0 },
    { voltage: 24 },
    { duty: 50 },
    { step: 0 },
    { stop: 0 },
    { frequency: 1e6, duty: 99 },
  ])
    assert.throws(() => buildSpiceDeck(d, { ...c, ...patch }));
  q.fields['Sim.Pins'] = '1=D 2=G 3=S';
  const ground = d.parts.find((p) => p.libId === 'power:GND')!;
  assert.throws(() => buildSpiceDeck(d, { ...c, outputId: ground.id }), /read from the schematic/);
});

test(
  'real bundled ngspice runs the original Buck and responds to PWM duty',
  { skip: !process.env.OPENPE_TEST_NGSPICE },
  async () => {
    const d = fixture(),
      before = JSON.stringify(d);
    const run = async (duty: number) => {
      const edited = structuredClone(d);
      const pulse = edited.parts.find((p) => p.ref === 'V101')!;
      pulse.fields = {
        ...pulse.fields,
        'Sim.Params': `y1=0 y2=15 td=20n tr=20n tf=20n tw=${duty / 2}u per=50u`,
      };
      const deck = buildSpiceDeck(edited, defaultTransient(edited));
      const result = validatedSimulationResult(
        await runSimulation(deck, new AbortController().signal),
        deck,
      );
      assert.match(result.version, /ngspice-47/);
      const start = result.time.findIndex((t) => t > 0.0018);
      let area = 0;
      for (let i = start + 1; i < result.time.length; i++)
        area +=
          ((result.time[i] - result.time[i - 1]) *
            (result.traces[0].values[i] + result.traces[0].values[i - 1])) /
          2;
      return area / (result.time.at(-1)! - result.time[start]);
    };
    const half = await run(50),
      quarter = await run(25);
    assert.ok(half > 2 && half < 8, `stored pin mapping, 50% duty: ${half} V`);
    assert.ok(quarter > 0 && quarter < half, `stored pin mapping, 25% duty: ${quarter} V`);
    assert.equal(JSON.stringify(d), before);
  },
);
