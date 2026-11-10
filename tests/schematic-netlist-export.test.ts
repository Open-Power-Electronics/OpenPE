import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPart,
  emptyCircuit,
  pinPositions,
  serializeCircuit,
  uid,
  type Circuit,
  type Part,
} from '../lib/circuit';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { createProject, serializeProject } from '../lib/project';
import { exportSchematicNetlist } from '../lib/schematic-netlist-export';
import { child, children, parseSExpr, quote, val } from '../lib/sexpr';

const pins = (circuit: Circuit, part: Part) => pinPositions(part, circuit.libraries[part.libId]);

test('schematic XML carries canonical nets, escaped metadata and flags without a PCB', () => {
  const circuit = emptyCircuit();
  const left = createPart(circuit, 'R', 0, 0);
  circuit.parts.push(left);
  const right = createPart(circuit, 'R', 25.4, 0);
  circuit.parts.push(right);
  const ground = createPart(circuit, 'GND', 50.8, 0);
  circuit.parts.push(ground);
  const project = createProject(circuit);
  project.name = 'Design & review';
  const a = pins(circuit, left);
  const b = pins(circuit, right);
  const [gnd] = pins(circuit, ground);
  left.value = '10 kΩ & <trim> "雪"';
  left.fields = { ...left.fields, Footprint: 'Resistor_SMD:R_0603_1608Metric', Note: 'A\tB' };
  left.raw = children(parseSExpr(serializeCircuit(circuit)), 'symbol')[0];
  child(left.raw, 'dnp')![1] = 'yes';
  child(left.raw, 'in_bom')![1] = 'no';
  right.excludeFromSimulation = true;
  circuit.labels = [
    { ...a[0], id: uid(), text: 'Signal & "snow" ☃' },
    { ...b[0], id: uid(), text: 'Signal & "snow" ☃', scope: 'global' },
    { ...b[1], id: uid(), text: 'GND' },
  ];
  circuit.wires.push({ id: uid(), a: gnd, b: { x: gnd.x, y: gnd.y + 1.27 } });
  circuit.noConnects = [{ ...a[1], id: uid() }];
  const secondary = emptyCircuit();
  secondary.parts.push({ ...createPart(secondary, 'C', 0, 0), ref: 'C99' });
  project.additionalSchematics = [secondary];
  const before = serializeProject(project);
  const output = exportSchematicNetlist(project);
  assert.match(output, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<export version="E">/);
  assert.match(output, /<source>Design &amp; review\.kicad_sch<\/source>/);
  assert.match(output, /<value>10 kΩ &amp; &lt;trim&gt; &quot;雪&quot;<\/value>/);
  assert.match(output, /<footprint>Resistor_SMD:R_0603_1608Metric<\/footprint>/);
  assert.match(output, /<field name="Note">A&#9;B<\/field>/);
  assert.match(output, /<property name="dnp"\/>/);
  assert.match(output, /<property name="exclude_from_bom"\/>/);
  assert.match(output, /<property name="exclude_from_sim"\/>/);
  assert.match(output, /<libpart lib="Device" part="R">/);
  assert.match(output, /<pin num="1" name="" type="passive"\/>/);
  assert.match(
    output,
    /name="Signal &amp; &quot;snow&quot; ☃">\n      <node ref="R1" pin="1"[^\n]*\n      <node ref="R2" pin="1"/,
  );
  assert.match(output, /name="GND">\n      <node ref="R2" pin="2"/);
  assert.doesNotMatch(output, /#PWR|C99|<node ref="R1" pin="2"/);
  assert.equal(serializeProject(project), before);
});

test('schematic XML combines placed units into one physical reference', () => {
  const circuit = emptyCircuit();
  const first = createPart(circuit, 'R', 0, 0);
  const definition = circuit.libraries[first.libId];
  const secondUnit = structuredClone(
    children(definition, 'symbol').find((unit) => children(unit, 'pin').length)!,
  );
  secondUnit[1] = quote('R_2_1');
  for (const pin of children(secondUnit, 'pin')) {
    const number = child(pin, 'number')!;
    number[1] = quote(String(Number(val(number)) + 2));
  }
  definition.push(secondUnit);
  const second = { ...first, id: uid(), unit: 2, x: 25.4 };
  circuit.parts = [second, first];
  circuit.labels = [
    { ...pins(circuit, first)[0], id: uid(), text: 'Shared' },
    { ...pins(circuit, second)[0], id: uid(), text: 'Shared' },
  ];
  const project = createProject(circuit);
  const output = exportSchematicNetlist(project);
  assert.equal(output.match(/<comp ref="R1">/g)?.length, 1);
  assert.ok(output.includes(`<tstamps>${first.id} ${second.id}</tstamps>`));
  assert.match(
    output,
    /name="Shared">\n      <node ref="R1" pin="1"[^\n]*\n      <node ref="R1" pin="3"/,
  );
  assert.match(output, /<pin num="4" name="" type="passive"\/>/);
});

test('schematic XML names the native primary sheet even when it differs from the project entry', () => {
  const project = createProject();
  project.name = 'Power supply';
  const native = projectNativeFiles(project);
  native.files.find((file) => file.name.endsWith('.kicad_sch'))!.name = 'Power stage.kicad_sch';
  const output = exportSchematicNetlist(projectFromNativeFiles(native));
  assert.match(output, /<source>Power stage\.kicad_sch<\/source>/);
  assert.doesNotMatch(output, /Power supply\.kicad_sch/);
});

test('schematic XML rejects ambiguous nets and references, pin maps and invalid XML text', () => {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 0, 0);
  circuit.parts.push(part);
  const project = createProject(circuit);
  const [point] = pins(circuit, part);
  circuit.labels = ['IN', 'OUT'].map((text) => ({ ...point, text, id: uid() }));
  assert.throws(() => exportSchematicNetlist(project), /conflicting names/);
  circuit.labels = [];

  circuit.parts.push({ ...part, id: uid(), ref: 'r1' });
  assert.throws(() => exportSchematicNetlist(project), /references must be unique/);
  circuit.parts.pop();

  const definition = circuit.libraries[part.libId];
  definition.push(['pin_maps', ['pin_map', '"A"', ['entry', '"1"', '"2"']]]);
  assert.throws(() => exportSchematicNetlist(project), /pin maps/);
  definition.pop();

  part.value = 'unsupported\u0001';
  assert.throws(() => exportSchematicNetlist(project), /XML 1.0/);
});
