import test from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit, pinPositions, libraries, uid } from '../lib/circuit';
import { createLibraryPart } from '../lib/library';
import {
  createProject,
  serializeProject,
  parseProject,
  exportKiCad,
  importDocument,
} from '../lib/project';
import {
  defaultSimulationParticipation,
  participatesInSimulation,
} from '../lib/simulation-participation';
import { buildSpiceDeck, defaultTransient, simulationSupportError, spiceNets } from '../lib/spice';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';
import { createReferenceExample, referenceExamples } from '../lib/reference-examples';
import { createExample } from '../lib/examples';
import { switchingStageFixture } from './fixtures/switching-stage';
import { PCBProjectSync } from '../lib/pcb-project-sync';
import { child, quote } from '../lib/sexpr';

test('new connectors default off, physical passives default on, and existing instances retain their flags', () => {
  const d = emptyCircuit();
  const connector = createPart(d, 'Port', 0, 0);
  assert.equal(participatesInSimulation(connector), false);
  assert.equal(participatesInSimulation(createPart(d, 'R', 0, 0)), true);
  const old = { ...connector, excludeFromSimulation: undefined };
  assert.equal(participatesInSimulation(old), true);
  const excluded = structuredClone(libraries['Device:R']);
  const flag = child(excluded, 'exclude_from_sim');
  if (flag) flag[1] = 'yes';
  else excluded.push(['exclude_from_sim', 'yes']);
  assert.equal(defaultSimulationParticipation(excluded), false);
  const multi = createLibraryPart(d, libraries['Device:R'], 0, 0);
  multi.excludeFromSimulation = true;
  d.parts.push(multi);
  assert.equal(
    participatesInSimulation(createLibraryPart(d, libraries['Device:R'], 0, 0, 2)),
    false,
  );
});

test('participation survives canonical JSON and native exports, and can override an imported flag', () => {
  const d = emptyCircuit();
  const p = createPart(d, 'Port', 0, 0);
  d.parts.push(p);
  const source = serializeProject(createProject(d));
  const saved = JSON.parse(source).schematic.components[0];
  assert.equal(saved.simulation.excluded, true);
  let reopened = parseProject(source);
  assert.equal(participatesInSimulation(reopened.schematic.parts[0]), false);
  const native = exportKiCad(reopened, 'schematic');
  assert.match(native, /\(exclude_from_sim yes\)/);
  assert.equal(participatesInSimulation(importDocument(native).schematic.parts[0]), false);
  reopened.schematic.parts[0].excludeFromSimulation = false;
  reopened = parseProject(serializeProject(reopened));
  assert.equal(participatesInSimulation(reopened.schematic.parts[0]), true);
  assert.equal(
    JSON.parse(serializeProject(reopened)).schematic.components[0].simulation?.excluded,
    undefined,
  );
});

const fixtures = [
  ['generic switching stage', switchingStageFixture],
  ['official model Buck', () => createExample('kicad-buck').schematic],
  ...referenceExamples.map(
    (entry) => [entry.title, () => createReferenceExample(entry.id).schematic] as const,
  ),
] as const;
test('simulation participation changes preserve existing example boards and embedded package aliases', () => {
  for (const entry of referenceExamples) {
    const project = createReferenceExample(entry.id);
    const sync = new PCBProjectSync(project);
    const before = JSON.stringify(project.pcb);
    project.schematic.parts.find((p) => p.ref === 'U1')!.excludeFromSimulation = true;
    const result = sync.prepare(project);
    assert.ok(result, `${entry.title}: no footprint library fetch is required.`);
    assert.equal(JSON.stringify(result.project.pcb), before, entry.title);
  }
});
for (const [name, factory] of fixtures) {
  test(`${name}: excluded connector and passive never stamp a model or current vector`, () => {
    const d = factory();
    const connector = createPart(d, 'Port', 300, 300);
    const originalId = connector.libId;
    connector.libId = 'Connector_Test:Terminals';
    d.libraries[connector.libId] = structuredClone(d.libraries[originalId]);
    d.libraries[connector.libId][1] = quote(connector.libId);
    // An excluded model string remains data; it is never read as a model or directive.
    connector.fields = { 'Sim.Library': 'unsafe.lib', 'Sim.Params': '.include unsafe.lib' };
    d.parts.push(connector);
    d.noConnects = [{ id: uid(), ...pinPositions(connector, d.libraries[connector.libId])[0] }];
    const passive = createPart(d, 'R', 320, 320);
    passive.value = 'not a solver number';
    passive.excludeFromSimulation = true;
    d.parts.push(passive);
    assert.equal(simulationSupportError(d), '');
    const deck = buildSpiceDeck(d, defaultTransient(d));
    assert.ok(!deck.netlist.includes('unsafe'));
    for (const part of [connector, passive])
      assert.ok(!deck.traces.some((t) => t.targets?.some((target) => target.id === part.id)));
    assert.equal(serviceDeck(d, defaultTransient(d)).netlist, deck.netlist);
    connector.excludeFromSimulation = false;
    assert.ok(simulationSupportError(d));
    assert.throws(() => buildSpiceDeck(d, defaultTransient(d)));
  });
}

test('excluding an active load removes its stamp; excluded pins retain physical wire anchors without shorting', () => {
  const d = switchingStageFixture();
  const load = d.parts.find((p) => p.ref === 'R1')!;
  const before = buildSpiceDeck(d, defaultTransient(d));
  assert.ok(before.traces.some((t) => t.unit === 'A' && t.targets?.some((p) => p.id === load.id)));
  const nets = spiceNets(d);
  load.excludeFromSimulation = true;
  const after = buildSpiceDeck(d, defaultTransient(d));
  assert.ok(!after.traces.some((t) => t.targets?.some((p) => p.id === load.id)));
  assert.equal(after.netlist.match(/^R\d+ /gm), null);
  const excluded = spiceNets(d);
  assert.equal(nets.node(load, '1'), excluded.node(load, '1'));
  assert.notEqual(excluded.node(load, '1'), excluded.node(load, '2'));
  load.excludeFromSimulation = false;
  assert.equal(buildSpiceDeck(d, defaultTransient(d)).netlist, before.netlist);
});

test('excluding the input source or controller does not silently substitute the chip or its source', () => {
  for (const reference of ['V1', 'U1']) {
    const d = createReferenceExample(referenceExamples[0].id).schematic;
    d.parts.find((p) => p.ref === reference)!.excludeFromSimulation = true;
    assert.throws(
      () => buildSpiceDeck(d, defaultTransient(d)),
      /input voltage source|official controller/,
    );
  }
});

test('excluding a component cannot hide a connected active no-connect marker', () => {
  const d = switchingStageFixture();
  const active = d.parts.find((p) => p.ref === 'R1')!;
  d.noConnects = [{ id: uid(), ...pinPositions(active, d.libraries[active.libId])[0] }];
  assert.throws(() => buildSpiceDeck(d, defaultTransient(d)), /no-connect/);
  // The public and private schemas reject nonboolean editor flags.
  (active as unknown as { excludeFromSimulation: string }).excludeFromSimulation = 'yes';
  assert.throws(() => serializeProject(createProject(d)), /excludeFromSimulation|Invalid/);
});
