import assert from 'node:assert/strict';
import test from 'node:test';
import { createExample } from '../lib/examples';
import { createHomeExample } from '../lib/create-home-example';
import { displayPartValue, partFields } from '../lib/library';
import { prepareSourceConversion } from '../lib/simulation-source-conversion';
import { simulationSourceProperties } from '../lib/part-properties';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { ProjectCore } from '../core/project-core';
import { exportKiCad, importDocument } from '../lib/project';

function convert(core: ProjectCore, ref: string, type: 'DC' | 'PULSE' | 'SIN') {
  const project = core.getSnapshot().project!,
    part = project.schematic.parts.find((p) => p.ref === ref)!;
  const rows = [
    ...Object.entries(partFields(part))
      .filter(([key]) => key !== 'Sim.Params')
      .map(([name, value]) => ({ name, value })),
    ...simulationSourceProperties(part)!.rows,
  ];
  const change = prepareSourceConversion(part, part.ref, displayPartValue(part), rows, type);
  if (change)
    core.execute('part.properties', {
      schematicId: project.schematic.id,
      partId: part.id,
      reference: change.ref,
      value: change.value,
      fields: Object.entries(change.fields).map(([name, value]) => ({ name, value })),
    });
  return core.getSnapshot().project!.schematic.parts.find((p) => p.id === part.id)!;
}

test('source waveform conversion compiles the selected type, preserves geometry and is one undo edit', () => {
  const project = createExample('kicad-buck'),
    core = new ProjectCore(project);
  const before = core.getSnapshot();
  const original = before.project!.schematic.parts.find((p) => p.ref === 'V102')!;
  for (const type of ['PULSE', 'SIN', 'DC'] as const) {
    const changed = convert(core, 'V102', type);
    assert.equal(changed.id, original.id);
    assert.equal(changed.libId, original.libId);
    assert.deepEqual(
      [changed.x, changed.y, changed.rotation],
      [original.x, original.y, original.rotation],
    );
    assert.equal(partFields(changed)['Sim.Pins'], partFields(original)['Sim.Pins']);
    assert.equal(simulationSourceProperties(changed)!.type, type);
    const state = core.getSnapshot();
    assert.deepEqual(state.project!.schematic.wires, before.project!.schematic.wires);
    assert.deepEqual(state.project!.pcb, before.project!.pcb);
    const deck = buildSpiceDeck(
      state.project!.schematic,
      defaultTransient(state.project!.schematic),
    );
    assert.match(deck.netlist, new RegExp(type === 'DC' ? ' DC ' : ` ${type}\\(`));
    const reopened = importDocument(exportKiCad(state.project!, 'schematic'));
    assert.equal(
      simulationSourceProperties(reopened.schematic.parts.find((p) => p.ref === 'V102')!)!.type,
      type,
    );
  }
  assert.equal(core.getSnapshot().undoDepth, 3);
  core.undo();
  core.undo();
  core.undo();
  assert.equal(core.getSnapshot().source, before.source);
});

test('official reference inputs use converted source fields, while the IRF gate stays bounded to PULSE', () => {
  const core = new ProjectCore(createHomeExample('reference-lm2598-to220-7-buck'));
  for (const type of ['PULSE', 'SIN', 'DC'] as const) {
    convert(core, 'V1', type);
    const d = core.getSnapshot().project!.schematic;
    assert.match(
      buildSpiceDeck(d, defaultTransient(d)).netlist,
      new RegExp(type === 'DC' ? ' DC ' : ` ${type}\\(`),
    );
  }
  const buck = new ProjectCore(createExample('kicad-buck'));
  convert(buck, 'V101', 'DC');
  const d = buck.getSnapshot().project!.schematic;
  assert.throws(
    () => buildSpiceDeck(d, defaultTransient(d)),
    /unsupported simulation device or type/,
  );
});

test('invalid source drafts and cross-family changes never convert or mutate the accepted source', () => {
  const project = createExample('kicad-buck'),
    part = project.schematic.parts.find((p) => p.ref === 'V102')!;
  const before = structuredClone(part);
  const rows = [
    ...Object.entries(partFields(part)).map(([name, value]) => ({ name, value })),
    ...simulationSourceProperties(part)!.rows.map((row) => ({ ...row, value: 'invalid' })),
  ];
  assert.throws(() =>
    prepareSourceConversion(part, part.ref, displayPartValue(part), rows, 'PULSE'),
  );
  const resistor = project.schematic.parts.find((p) => p.libId === 'Device:R')!;
  assert.throws(
    () => prepareSourceConversion(resistor, resistor.ref, resistor.value, [], 'PULSE'),
    /compatible/,
  );
  assert.deepEqual(part, before);
});
