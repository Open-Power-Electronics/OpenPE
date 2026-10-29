import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCircuit } from '../lib/circuit';
import { parseProject } from '../lib/project';
import {
  buildSpiceDeck,
  defaultTransient,
  simulationSupportError,
  simulationSpiceNets,
} from '../lib/spice';
import profile from '../lib/emc-flyback-simulation.json';
import { prepareEmcFlybackValues } from '../scripts/emc-flyback-values';

const source = readFileSync(
  'resources/example-catalog/sources/emc-flyback/design/emc_flyback.kicad_sch',
  'utf8',
);
const fixture = () => {
  const circuit = parseCircuit(source);
  prepareEmcFlybackValues(circuit);
  return circuit;
};
test('the actual KiCad 10 Home template compiles every declared dissipative terminal vector', () => {
  const project = parseProject(readFileSync('lib/emc-flyback-example.json', 'utf8'));
  const before = JSON.stringify(project),
    deck = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
  assert.equal(simulationSupportError(project.schematic), '');
  const paths = deck.traces.filter((trace) => trace.dissipation);
  assert.equal(paths.length, 17);
  for (const trace of paths)
    for (const node of [trace.dissipation!.positiveNode, trace.dissipation!.negativeNode])
      assert.ok(
        node === '0' ||
          deck.traces.some((voltage) => voltage.unit === 'V' && voltage.vector === `v(${node})`),
      );
  assert.equal(JSON.stringify(project), before);
});
test('EMC Flyback model signatures and behavioural library bind the pinned source bytes', () => {
  assert.equal(createHash('sha256').update(source).digest('hex'), profile.sourceSha256);
  assert.equal(
    createHash('sha256')
      .update(
        readFileSync(
          'resources/example-catalog/sources/emc-flyback/simulation/EMC_flyback_control.lib',
        ),
      )
      .digest('hex'),
    profile.controlSha256,
  );
  const d = fixture(),
    before = JSON.stringify(d),
    config = defaultTransient(d),
    deck = buildSpiceDeck(d, config);
  assert.equal(simulationSupportError(d), '');
  assert.equal(config.stop, 0.01);
  assert.equal(config.step, 5e-9);
  assert.match(deck.netlist, /\.subckt UC3845B COMP FB ISENSE RTCT GN OUT VCC VREF/);
  assert.match(deck.netlist, /MQ1 \w+ \w+ emc_source EMC_IRF520N/);
  assert.match(deck.netlist, /^RLOAD \w+ 0 100$/m);
  assert.match(deck.netlist, /^ILOAD \w+ 0 PULSE\(0\.5 0 2m 10u 10u 2m 1\)$/m);
  assert.doesNotMatch(deck.netlist, /\.include|\.model IRF540N/);
  const q = d.parts.find((p) => p.ref === 'Q1')!,
    net = simulationSpiceNets(d);
  assert.equal(
    net.node(
      d.parts.find((p) => p.ref === 'U1')!,
      '5',
    ),
    '0',
  );
  assert.equal(
    net.node(
      d.parts.find((p) => p.ref === 'U3')!,
      '3',
    ),
    '0',
  );
  assert.deepEqual(
    deck.traces.find((t) =>
      t.targets?.some((target) => target.kind === 'current' && target.id === q.id),
    )?.dissipation,
    {
      positivePin: '2',
      negativePin: '3',
      positiveNode: deck.traces
        .find((t) =>
          t.targets?.some(
            (target) => target.kind === 'voltage' && target.id === q.id && target.pin === 1,
          ),
        )!
        .vector.slice(2, -1),
      negativeNode: 'emc_source',
      method: 'mosfet',
    },
  );
  assert.match(deck.traces[0].label, /VOUT/);
  assert.equal(JSON.stringify(d), before);
});
test('EMC Flyback permits supported native passive edits and only exposes timing controls', () => {
  const d = fixture(),
    r = d.parts.find((p) => p.ref === 'R15')!;
  r.value = '40k';
  const c = defaultTransient(d),
    deck = buildSpiceDeck(d, { ...c, stop: 0.007, step: 10e-9 });
  assert.match(deck.netlist, /R15 \w+ \w+ 40000/);
  assert.throws(() => buildSpiceDeck(d, { ...c, voltage: 30 }), /Electrical settings/);
  assert.throws(() => buildSpiceDeck(d, { ...c, step: 0 }), /Max. time step/);
});
test('EMC Flyback rejects changed topology, device substitution, unknown fields and unsupported assembly edits', () => {
  for (const mutate of [
    (d: ReturnType<typeof fixture>) => {
      d.parts.find((p) => p.ref === 'Q1')!.value = 'IRF540N';
    },
    (d: ReturnType<typeof fixture>) => {
      d.parts.find((p) => p.ref === 'R6')!.value = '23R';
    },
    (d: ReturnType<typeof fixture>) => {
      d.parts.find((p) => p.ref === 'R4')!.excludeFromSimulation = true;
    },
    (d: ReturnType<typeof fixture>) => {
      d.parts.find((p) => p.ref === 'R9')!.value = '4.7k\n.control';
    },
    (d: ReturnType<typeof fixture>) => {
      const p = d.parts.find((p) => p.ref === 'Q1')!;
      p.fields = { ...p.fields, 'Sim.Library': 'malicious.lib' };
    },
    (d: ReturnType<typeof fixture>) => {
      d.wires = [];
    },
  ]) {
    const d = fixture();
    mutate(d);
    assert.throws(() => buildSpiceDeck(d, defaultTransient(d)));
  }
});
