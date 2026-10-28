import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lm2596AdjustableDerivedModel as model } from '../lib/ti-dcdc';
import { deriveLm2596AdjustableModel, adaptLm2596Adjustable } from '../server/spice-lm2596-adj.mjs';
import { adaptSpiceModels } from '../server/spice-model-adapters.mjs';
import { createReferenceExample } from '../lib/reference-examples';
import { buildSpiceDeck, defaultTransient, spiceNets } from '../lib/spice';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';
import { partFields } from '../lib/library';
import { exportKiCad, parseProject, serializeProject } from '../lib/project';
import { children, parseSExpr, val } from '../lib/sexpr';

async function original(context: { skip(message: string): void }) {
  try {
    return await readFile(
      `resources/example-catalog/simulation/models/${model.sourceModelId}-${model.sourceSha256}.lib`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    context.skip('Prepare the original offline TI 5 V model to check the derivative.');
    return undefined;
  }
}
const example = () => createReferenceExample('reference-lm2596-to220-5-buck');

test('ADJ model changes only the named controller feedback path and preserves original notice/helper bytes', async (context) => {
  const bytes = await original(context);
  if (!bytes) return;
  const before = Buffer.from(bytes);
  const derivative = deriveLm2596AdjustableModel(bytes);
  assert.deepEqual(bytes, before);
  assert.deepEqual(deriveLm2596AdjustableModel(bytes), derivative);
  const source = bytes.toString('latin1'),
    derived = derivative.toString('latin1');
  assert.match(derived, /^\* OpenPE-derived.*NOT a TI-issued ADJ model/m);
  assert.ok(derived.includes(model.sourceSha256));
  assert.ok(
    derived.includes(source.slice(0, source.indexOf('.SUBCKT'))),
    'Original notice bytes remain intact.',
  );
  assert.equal(
    derived.slice(derived.indexOf('.SUBCKT  Current_Limit')),
    source.slice(source.indexOf('.SUBCKT  Current_Limit')),
    'All helper subcircuits remain byte-identical.',
  );
  const restored = derived
    .slice(derived.indexOf('*$'))
    .replaceAll(model.subcircuit, model.sourceSubcircuit)
    .replace('E_U1_E5 U1_N16912605 0 VALUE { V(FB, GND) }', /^E_U1_E5[^\r\n]*/m.exec(source)![0])
    .replace(
      /^\.ENDS LM2596_5P0_TRANS/m,
      `${/^R_RFB2[^\r\n]*/m.exec(source)![0]}\n${/^R_RFB1[^\r\n]*/m.exec(source)![0]}\n.ENDS LM2596_5P0_TRANS`,
    );
  // Compare element lines without relying on line endings or removed-resistor position.
  const lines = (text: string) => text.split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(lines(restored), lines(source));
  assert.doesNotMatch(derived, /FB_INT|^R_RFB[12]\b/m);
  assert.match(derived, /U1_N16912781\)<1\.235/);
});

test('derivation fails closed for missing, changed or substituted original models', () => {
  for (const bytes of [undefined, Buffer.alloc(0), Buffer.from('other vendor model')])
    assert.throws(() => deriveLm2596AdjustableModel(bytes), /pinned SHA-256/);
});

test('ADJ Home identity, E96 feedback, PCB values and native exports agree without changing copper', () => {
  const project = parseProject(serializeProject(example())),
    d = project.schematic;
  const part = (ref: string) => d.parts.find((p) => p.ref === ref)!;
  assert.equal(part('U1').value, 'LM2596T-ADJ');
  assert.equal(part('R1').value, '3.09k');
  assert.equal(part('R2').value, '1.01k');
  assert.equal(partFields(part('U1'))['Sim.Library'], model.library);
  assert.equal(partFields(part('U1'))['Sim.Name'], model.subcircuit);
  assert.match(partFields(part('U1')).Description, /OpenPE-derived.*Not a TI-issued ADJ model/);
  const nets = spiceNets(d);
  assert.equal(nets.node(part('R1'), '2'), nets.node(part('U1'), '4'));
  assert.equal(nets.node(part('R2'), '1'), nets.node(part('U1'), '4'));
  assert.equal(nets.node(part('R2'), '2'), '0');
  assert.notEqual(nets.node(part('R1'), '1'), nets.node(part('U1'), '4'));
  const nativeBoard = parseSExpr(exportKiCad(project, 'pcb'));
  for (const ref of ['U1', 'R1', 'R2']) {
    const footprint = project.pcb!.footprints.find((f) => f.symbolId === part(ref).id)!;
    assert.ok(footprint);
    const native = children(nativeBoard, 'footprint').find((f) =>
      children(f, 'property').some((p) => val(p) === 'Reference' && val(p, 2) === ref),
    )!;
    assert.ok(native);
    assert.equal(
      val(
        children(native, 'property').find((p) => val(p) === 'Value'),
        2,
      ),
      part(ref).value,
    );
  }
  const source = serializeProject(project),
    deck = buildSpiceDeck(d, defaultTransient(d));
  assert.deepEqual(serviceDeck(d, defaultTransient(d)), deck);
  assert.deepEqual(deck.modelIds, [model.sourceModelId]);
  assert.deepEqual(
    project.simulationModels?.map((m) => [m.id, m.sha256]),
    [[model.sourceModelId, model.sourceSha256]],
  );
  const provenance = project.extensions['org.openpe.reference-example'] as {
    simulation: { derivedModel: typeof model };
  };
  assert.deepEqual(provenance.simulation.derivedModel, model);
  assert.match(deck.netlist, /OPENPE_DERIVED_LM2596_ADJ_TRANS/);
  assert.ok(deck.assumptions.some((s) => /OpenPE-derived/.test(s)));
  assert.equal(serializeProject(project), source);
  // Editing the real divider changes the generated electrical deck without changing the board.
  const board = structuredClone(project.pcb);
  part('R1').value = '1.69k';
  assert.notEqual(buildSpiceDeck(d, defaultTransient(d)).netlist, deck.netlist);
  assert.deepEqual(project.pcb, board);
});

test('ADJ support cannot be changed into an unverified model by editing its name, library or chip identity', () => {
  for (const [key, value] of [
    ['Sim.Name', model.sourceSubcircuit],
    ['Sim.Name', 'CUSTOM_ADJ_MODEL'],
    ['Sim.Library', `TI:${model.sourceModelId}`],
    ['Sim.Library', 'custom.lib'],
    ['Value', 'LM2596T-5'],
  ]) {
    const project = example(),
      d = project.schematic,
      controller = d.parts.find((p) => p.ref === 'U1')!;
    if (key === 'Value') controller.value = value;
    else controller.fields = { ...partFields(controller), [key]: value };
    assert.throws(
      () => buildSpiceDeck(d, defaultTransient(d)),
      /identity|simulation field|pin assignment/,
    );
  }
});

test('only verified generated ADJ calls activate the derivative; fixed-output models retain identity', async (context) => {
  const bytes = await original(context);
  if (!bytes) return;
  const project = example(),
    deck = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
  const before = structuredClone(deck),
    models = new Map([[model.sourceModelId, bytes]]);
  const prepared = adaptSpiceModels(deck, models);
  assert.deepEqual(deck, before);
  assert.equal(prepared.compatibility, 'psa');
  assert.equal(prepared.stop, deck.stop);
  assert.equal(prepared.traces, deck.traces);
  assert.match(
    prepared.netlist,
    /^\.SUBCKT OPENPE_DERIVED_LM2596_ADJ_TRANS VIN FB OUT GND ON_OFF_N$/m,
  );
  assert.match(prepared.netlist, /^\.include example-model-0\.lib$/m);
  assert.notEqual(
    createHash('sha256').update(prepared.netlist).digest('hex'),
    createHash('sha256').update(deck.netlist).digest('hex'),
  );
  const fixed = {
    ...deck,
    netlist: deck.netlist.replaceAll(model.subcircuit, model.sourceSubcircuit),
  };
  assert.equal(adaptLm2596Adjustable(fixed, new Map()), fixed);
  for (const invalid of [
    { ...deck, modelIds: [] },
    { ...deck, modelIds: [model.sourceModelId, model.sourceModelId] },
    { ...deck, netlist: deck.netlist.replace('.include example-model-0.lib', '') },
    { ...deck, netlist: deck.netlist.replace('.save ', '.save v(extra)\n.save ') },
    { ...deck, netlist: deck.netlist.replace(model.subcircuit, `extra ${model.subcircuit}`) },
    prepared,
  ])
    assert.throws(() => adaptLm2596Adjustable(invalid, models), /derived-model preparation failed/);
  assert.throws(() => adaptLm2596Adjustable(deck, new Map()), /pinned SHA-256/);
});
