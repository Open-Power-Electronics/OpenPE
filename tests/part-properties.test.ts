import { parameterizedHomeProject } from './fixtures/model-parameters';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleProject } from '../lib/project-example';
import { displayPartValue, partFields } from '../lib/library';
import {
  preparePartProperties,
  simulationSourceProperties,
  type FieldRow,
} from '../lib/part-properties';
import { exportKiCad, importDocument, parseProject, serializeProject } from '../lib/project';
import { createHomeExample } from '../lib/create-home-example';
import { buildSpiceDeck, defaultTransient } from '../plugins/spice-simulation/domain/spice';

test('source controls edit DC literals, bound DC values and pulse parameters without changing model mappings', () => {
  const buck = parameterizedHomeProject();
  const home = createHomeExample('reference-lm2598-to220-7-buck');
  const pulse = parameterizedHomeProject('PULSE');
  for (const [project, ref, key, input] of [
    [buck, 'V1', 'dc', '18'],
    [pulse, 'V1', 'y2', '10'],
    [home, 'V1', 'dc', '25'],
  ] as const) {
    const part = project.schematic.parts.find((part) => part.ref === ref)!;
    const fields = partFields(part),
      source = simulationSourceProperties(part)!;
    const rows = [
      ...Object.entries(fields)
        .filter(([name]) => name !== 'Sim.Params')
        .map(([name, value]) => ({ name, value })),
      ...source.rows,
    ];
    assert.equal(preparePartProperties(part, part.ref, displayPartValue(part), rows), null);
    const editedRows = rows.map((row) =>
      'sourceKey' in row && row.sourceKey === key ? { ...row, value: input } : row,
    );
    const change = preparePartProperties(part, part.ref, displayPartValue(part), editedRows)!;
    const edited = structuredClone(project);
    Object.assign(
      edited.schematic.parts.find((p) => p.id === part.id)!,
      change,
    );
    for (const name of ['Sim.Device', 'Sim.Type', 'Sim.Pins'])
      assert.equal(change.fields[name], fields[name]);
    if (project === buck) assert.equal(change.fields['Sim.Params'], undefined);
    if (project === home) assert.equal(change.fields['Sim.Params'], `dc=${input}`);
    if (part.value === '${SIM.PARAMS}') assert.equal(change.value, part.value);
    const reopened = importDocument(exportKiCad(edited, 'schematic'));
    assert.equal(
      partFields(reopened.schematic.parts.find((p) => p.ref === ref)!)['Sim.Params'],
      change.fields['Sim.Params'],
    );
    const deck = buildSpiceDeck(edited.schematic, defaultTransient(edited.schematic));
    assert.match(deck.netlist, key === 'dc' ? new RegExp(`DC ${input}($|\\s)`) : /PULSE\(0 10 /);
    assert.throws(() =>
      preparePartProperties(
        part,
        part.ref,
        displayPartValue(part),
        editedRows.map((row) =>
          'sourceKey' in row && row.sourceKey === key ? { ...row, value: 'NaN' } : row,
        ),
      ),
    );
  }
});

test('numeric simulation Properties share compiler limits and retain engineering notation', () => {
  const part = exampleProject().schematic.parts[0];
  const current = partFields(part);
  const before = structuredClone(part);
  for (const [name, accepted, rejected] of [
    ['OpenPE.SeriesResistance', '100m', ['-1', '10.01', 'NaN', '50m Ω']],
    ['OpenPE.InitialVoltage', '-5', ['1001', '-1001', 'Infinity', '5V']],
    ['OpenPE.Coupling', '0.99', ['0', '-0.1', '1.01', '1e999']],
  ] as const) {
    const rows = (value: string) =>
      Object.entries({ ...current, [name]: value }).map(([name, value]) => ({ name, value }));
    assert.equal(
      preparePartProperties(part, part.ref, displayPartValue(part), rows(accepted))!.fields[name],
      accepted,
    );
    for (const value of ['', '.control', '{value}', ...rejected])
      assert.throws(
        () => preparePartProperties(part, part.ref, displayPartValue(part), rows(value)),
        Error,
        `${name}: ${value}`,
      );
  }
  assert.deepEqual(
    part,
    before,
    'Preparing edits and validation failures never mutate accepted data.',
  );
});

test('SIN source edits retain omitted defaults and reject invalid frequency and delay', () => {
  const original = parameterizedHomeProject().schematic.parts.find((part) => part.ref === 'V1')!;
  const part = {
    ...original,
    value: 'VSIN',
    fields: { ...partFields(original), 'Sim.Type': 'SIN', 'Sim.Params': ' ampl=1 f=50 ' },
  };
  const source = simulationSourceProperties(part)!;
  const rows = [
    ...Object.entries(partFields(part))
      .filter(([name]) => name !== 'Sim.Params')
      .map(([name, value]) => ({ name, value })),
    ...source.rows,
  ];
  assert.equal(preparePartProperties(part, part.ref, part.value, rows), null);
  const frequency = rows.map((row) =>
    'sourceKey' in row && row.sourceKey === 'f' ? { ...row, value: '60' } : row,
  );
  const changed = preparePartProperties(part, part.ref, part.value, frequency)!;
  assert.equal(changed.fields['Sim.Params'], 'ampl=1 f=60');
  for (const [key, value] of [
    ['f', '0'],
    ['td', '-1'],
    ['ampl', '.include'],
  ])
    assert.throws(() =>
      preparePartProperties(
        part,
        part.ref,
        part.value,
        rows.map((row) => ('sourceKey' in row && row.sourceKey === key ? { ...row, value } : row)),
      ),
    );
});

test('property blur skips unchanged and empty new rows, while preserving fields and input data', () => {
  const part = exampleProject().schematic.parts[0];
  const before = structuredClone(part);
  const fields = partFields(part);
  const rows: FieldRow[] = Object.entries({ Footprint: '', ...fields }).map(([name, value]) => ({
    name,
    value,
  }));
  rows.push({ name: '', value: '', fresh: true });
  assert.equal(preparePartProperties(part, part.ref, part.value, rows), null);
  const changed = preparePartProperties(part, part.ref, '2.2k', rows)!;
  assert.deepEqual(changed, { ref: part.ref, value: '2.2k', fields });
  const nextRows = rows.filter((row) => row.name !== 'Footprint');
  nextRows.push({ name: 'Footprint', value: 'Resistor_SMD:R_0805_2012Metric' });
  assert.equal(
    preparePartProperties(part, part.ref, part.value, nextRows)!.fields.Footprint,
    'Resistor_SMD:R_0805_2012Metric',
  );
  assert.deepEqual(part, before);
  assert.deepEqual(rows.at(-1), { name: '', value: '', fresh: true });
});

test('property commits reject invalid drafts and support explicit field removal', () => {
  const part = exampleProject().schematic.parts[0];
  const fields = partFields(part);
  const rows = Object.entries(fields).map(([name, value]) => ({ name, value }));
  for (const name of ['', 'Reference', 'Value', '__proto__', 'constructor', 'prototype']) {
    assert.throws(() =>
      preparePartProperties(part, part.ref, part.value, [...rows, { name, value: 'x' }]),
    );
  }
  assert.throws(() => preparePartProperties(part, ' ', part.value, rows));
  assert.throws(() => preparePartProperties(part, part.ref, '', rows));
  assert.throws(() =>
    preparePartProperties(part, part.ref, part.value, [
      ...rows,
      { name: 'Custom', value: '1' },
      { name: ' Custom ', value: '2' },
    ]),
  );
  const customPart = { ...part, fields: { ...fields, Custom: '1' } };
  assert.deepEqual(preparePartProperties(customPart, part.ref, part.value, rows)!.fields, fields);
});

test('resolved simulation values stay clean on blur and preserve edits to other properties', () => {
  const project = parameterizedHomeProject();
  const part = project.schematic.parts.find((part) => part.ref === 'L1')!;
  const before = serializeProject(project);
  const fields = partFields(part);
  const rows = Object.entries(fields).map(([name, value]) => ({ name, value }));
  assert.equal(part.value, '${SIM.PARAMS}');
  assert.equal(displayPartValue(part), '100u');
  assert.equal(preparePartProperties(part, part.ref, '100u', rows), null);
  const renamed = preparePartProperties(part, 'L102', '100u', rows)!;
  assert.equal(renamed.value, '${SIM.PARAMS}');
  assert.deepEqual(renamed.fields, fields);
  const simulationEdit = preparePartProperties(
    part,
    part.ref,
    '100u',
    rows.map((row) => (row.name === 'Sim.Params' ? { ...row, value: 'l=220u' } : row)),
  )!;
  assert.equal(simulationEdit.fields['Sim.Params'], 'l=220u');
  assert.equal(simulationEdit.value, '${SIM.PARAMS}');
  assert.equal(serializeProject(project), before);
});

test('editing a resolved value updates its simulation field through JSON and KiCad round trips', () => {
  const project = parameterizedHomeProject();
  const part = project.schematic.parts.find((part) => part.ref === 'L1')!;
  const rows = Object.entries(partFields(part)).map(([name, value]) => ({ name, value }));
  const change = preparePartProperties(part, part.ref, '220u', rows)!;
  assert.equal(change.value, '${SIM.PARAMS}');
  assert.equal(change.fields['Sim.Params'], 'l=220u');
  Object.assign(part, change);
  for (const restored of [
    parseProject(serializeProject(project)),
    importDocument(exportKiCad(project, 'schematic')),
  ]) {
    const restoredPart = restored.schematic.parts.find((item) => item.id === part.id)!;
    assert.equal(restoredPart.value, '${SIM.PARAMS}');
    assert.equal(partFields(restoredPart)['Sim.Params'], 'l=220u');
    assert.equal(displayPartValue(restoredPart), '220u');
  }
});

test('unresolved and compound value templates are not materialized by an unchanged blur', () => {
  const part = exampleProject().schematic.parts[0];
  for (const params of ['', 'r=1k']) {
    for (const template of ['${SIM.PARAMS}', 'Model: ${SIM.PARAMS}']) {
      const templated = {
        ...part,
        value: template,
        fields: { ...partFields(part), 'Sim.Params': params },
      };
      const rows = Object.entries(partFields(templated)).map(([name, value]) => ({ name, value }));
      assert.equal(
        preparePartProperties(templated, part.ref, displayPartValue(templated), rows),
        null,
      );
    }
  }
});

test('single simulation parameters display only their values and retain their names on edit', () => {
  const base = exampleProject().schematic.parts[0];
  for (const [params, displayed, edited, stored] of [
    ['l=100u', '100u', '220u', 'l=220u'],
    ['c=100u', '100u', '47u', 'c=47u'],
    [' R = 1k  ', '1k', '2.2k', ' R = 2.2k  '],
    ['dc=12', '12', '24', 'dc=24'],
  ]) {
    const part = { ...base, value: '${SIM.PARAMS}', fields: { 'Sim.Params': params } };
    const rows = Object.entries(partFields(part)).map(([name, value]) => ({ name, value }));
    assert.equal(displayPartValue(part), displayed);
    assert.equal(preparePartProperties(part, part.ref, displayed, rows), null);
    const change = preparePartProperties(part, part.ref, edited, rows)!;
    assert.equal(change.value, '${SIM.PARAMS}');
    assert.equal(change.fields['Sim.Params'], stored);
    assert.throws(
      () => preparePartProperties(part, part.ref, 'l=220u', rows),
      /only the component value/,
    );
  }
  assert.equal(displayPartValue({ ...base, value: 'gain=2' }), 'gain=2');
});
