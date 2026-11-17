import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseCircuit } from '../lib/circuit';
import { parseProject, projectFromNativeFiles, projectNativeFiles } from '../lib/project';
import models from '../resources/emc-flyback-models-lock.json';
import { createSimulationModelStore } from '../server/example-models.mjs';
import { projectSimulationModels } from '../server/project-models.mjs';
import { prepareProjectModelFiles, readProjectModelFile } from '../server/project-model-files.mjs';
import {
  buildSpiceDeck,
  defaultTransient,
  simulationSupportError,
  simulationSpiceNets,
} from '../plugins/spice-simulation/domain/spice';
import profile from '../lib/emc-flyback-simulation.json';
import { prepareEmcFlybackValues } from '../scripts/emc-flyback-values';
import { prepareEmcFlybackModelBindings } from '../scripts/emc-flyback-model-bindings';
import { prepareEmcFlybackTestbench } from '../scripts/emc-flyback-testbench';

const source = readFileSync(
  'resources/example-catalog/sources/emc-flyback/design/emc_flyback.kicad_sch',
  'utf8',
);
const fixture = () => {
  const circuit = parseCircuit(source);
  prepareEmcFlybackValues(circuit);
  prepareEmcFlybackModelBindings(circuit);
  prepareEmcFlybackTestbench(circuit);
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
  assert.deepEqual(
    deck.modelIds,
    models.models.map((model) => model.id),
  );
  for (const [index, model] of models.models.entries()) {
    assert.match(deck.netlist, new RegExp(`^\\.include example-model-${index}\\.lib$`, 'm'));
    assert.equal(
      createHash('sha256')
        .update(readFileSync(`examples/project/emc-flyback/${model.file}`))
        .digest('hex'),
      model.sha256,
    );
  }
  assert.deepEqual(
    readFileSync('examples/project/emc-flyback/models/EMC_flyback_control.lib'),
    readFileSync(
      'resources/example-catalog/sources/emc-flyback/simulation/EMC_flyback_control.lib',
    ),
  );
  assert.match(deck.netlist, /MQ1 \w+ \w+ emc_source EMC_IRF520N/);
  assert.match(deck.netlist, /^R22 \w+ 0 100$/m);
  assert.match(deck.netlist, /^I1 \w+ 0 PULSE\(/m);
  const pulse = /^I1 \w+ 0 PULSE\(([^)]+)\)$/m.exec(deck.netlist)![1].split(' ').map(Number);
  for (const [index, expected] of [0.5, 0, 0.002, 0.00001, 0.00001, 0.002, 1].entries())
    assert.ok(Math.abs(pulse[index] - expected) < 1e-18);
  assert.doesNotMatch(deck.netlist, /^\.(?:model|subckt)\b/im);
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

test('EMC Flyback libraries survive native Save as, offline resolution and changed-byte rejection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-emc-models-'));
  try {
    const project = parseProject(readFileSync('lib/emc-flyback-example.json', 'utf8'));
    assert.deepEqual(project.simulationModels, models.models);
    const bundle = projectNativeFiles(project, 'copy.kicad_pro');
    const reopened = projectFromNativeFiles(bundle);
    assert.deepEqual(reopened.simulationModels, models.models);
    const destination = path.join(root, 'copy.kicad_pro');
    const store = createSimulationModelStore(root, async () => {
      throw new Error('EMC Flyback models must never use the network.');
    });
    const signal = new AbortController().signal;
    await prepareProjectModelFiles(reopened, destination, undefined, store, signal);
    const resolved = projectSimulationModels(
      reopened,
      undefined,
      {
        read: (_id: string, model: (typeof models.models)[number]) =>
          readProjectModelFile(destination, model),
        write: async () => {},
      },
      'isolated-project',
    );
    const deck = buildSpiceDeck(reopened.schematic, defaultTransient(reopened.schematic));
    const libraries: string[] = [];
    for (const id of deck.modelIds!)
      libraries.push((await resolved.store(id, signal)).toString('utf8'));
    const expanded = deck.netlist.replace(
      /^\.include example-model-(\d+)\.lib$/gm,
      (_line, index) => libraries[Number(index)],
    );
    assert.match(expanded, /^\.subckt UC3845B COMP FB ISENSE RTCT GN OUT VCC VREF$/m);
    assert.match(expanded, /^\.model EMC_IRF520N VDMOS\(Vto=3\.6 Kp=6 /m);
    assert.match(expanded, /^\.model EMC_ES2D D\(Is=1e-9 N=1\.8 /m);
    assert.match(expanded, /^\.model EMC_SS510C D\(Is=5e-5 N=1\.1 /m);
    const target = path.join(root, models.models[0].file);
    await writeFile(target, 'changed model');
    await assert.rejects(readProjectModelFile(destination, models.models[0]), /integrity check/);
    await assert.rejects(
      prepareProjectModelFiles(reopened, destination, undefined, store, signal),
      /integrity check/,
    );
    assert.equal(await readFile(target, 'utf8'), 'changed model');
    const bundled = path.join(root, 'bundle');
    await mkdir(path.join(bundled, 'emc-flyback'), { recursive: true });
    const missing = createSimulationModelStore(
      root,
      async () => {
        throw new Error('Unexpected download');
      },
      bundled,
    );
    await assert.rejects(missing(models.models[0].id, signal), /Missing bundled/);
    await assert.rejects(store(models.models[0].id, AbortSignal.abort()), /abort/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
