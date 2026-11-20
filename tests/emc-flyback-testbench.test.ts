import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ProjectCore } from '../core/project-core';
import { parseCircuit, pinPositions } from '../lib/circuit';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/project';
import { displayPartValue, partFields } from '../lib/library';
import { preparePartProperties, simulationSourceProperties } from '../lib/part-properties';
import { prepareSourceConversion } from '../lib/simulation-source-conversion';
import {
  buildSpiceDeck,
  defaultTransient,
  spiceNets,
} from '../plugins/spice-simulation/domain/spice';
import { schematicPCBNets, pcbPinKey } from '../lib/pcb-sync';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import { onWire, samePoint } from '../lib/wiring';
import {
  prepareEmcFlybackNativeTestbench,
  isEmcDatasheetSection,
  isEmcCircuitFrame,
} from '../scripts/emc-flyback-testbench';

const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const filename = 'examples/project/emc-flyback/emc-flyback.kicad_pro';
const refs = ['V1', 'R21', 'V2', 'R22', 'I1'];

test('the actual native EMC testbench has explicit virtual supplies/loads and preserves ground isolation', async () => {
  const project = projectFromNativeFiles(await readNativeProject(filename));
  const d = project.schematic;
  assert.ok(!children(d.original!, 'text').some((text) => /^7\./.test(val(text))));
  const frame = children(d.original!, 'polyline').find((line) =>
    children(child(line, 'pts')!, 'xy').some((point) => Number(point[2]) < 0),
  );
  assert.ok(frame, 'A top testbench frame must be present.');
  const bench = refs.map((ref) => d.parts.find((part) => part.ref === ref)!);
  const x = bench.map((part) => part.x).sort((a, b) => a - b);
  for (let i = 2; i < x.length; i++) assert.ok(Math.abs(x[i] - x[i - 1] - (x[1] - x[0])) < 1e-8);
  assert.ok(bench.every((part) => part.y === bench[0].y && part.y < 22.86));
  const flagRails = d.parts
    .filter((part) => part.libId === 'power:PWR_FLAG')
    .map((flag) => {
      const [pin] = pinPositions(flag, d.libraries[flag.libId]);
      assert.equal(pin.y, bench[0].y);
      assert.ok(!d.wires.some((wire) => onWire(pin, wire)));
      const labels = d.labels.filter((label) => samePoint(label, pin));
      assert.equal(labels.length, 1);
      return labels[0].text;
    });
  assert.deepEqual(flagRails.sort(), ['CHASSIS', 'PGND', 'SGND', 'VBUS', 'VOUT']);
  const frames = children(d.original!, 'polyline').map((line) => {
    const points = children(child(line, 'pts')!, 'xy');
    return {
      left: Math.min(...points.map((p) => Number(p[1]))),
      right: Math.max(...points.map((p) => Number(p[1]))),
      top: Math.min(...points.map((p) => Number(p[2]))),
      bottom: Math.max(...points.map((p) => Number(p[2]))),
    };
  });
  const gaps: number[] = [];
  for (const a of frames) {
    const right = frames
      .filter((b) => b.left > a.right && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top))
      .map((b) => b.left - a.right);
    const below = frames
      .filter((b) => b.top > a.bottom && Math.min(a.right, b.right) > Math.max(a.left, b.left))
      .map((b) => b.top - a.bottom);
    if (right.length) gaps.push(Math.min(...right));
    if (below.length) gaps.push(Math.min(...below));
  }
  assert.ok(
    gaps.length > 6 && gaps.every((gap) => Math.abs(gap - gaps[0]) < 1e-8),
    'Adjacent panel gaps must be uniform in both directions.',
  );
  const native = schematicPCBNets(d);
  const electrical = (ref: string, pin: string) =>
    native.findIndex((net) => net.pins.includes(pcbPinKey(ref, pin)));
  for (const [a, b] of [
    [
      ['V1', '1'],
      ['R21', '1'],
    ],
    [
      ['R21', '2'],
      ['T1', '1'],
    ],
    [
      ['V1', '2'],
      ['U1', '5'],
    ],
    [
      ['V2', '1'],
      ['U1', '7'],
    ],
    [
      ['V2', '2'],
      ['U1', '5'],
    ],
    [
      ['R22', '1'],
      ['D3', '1'],
    ],
    [
      ['I1', '1'],
      ['D3', '1'],
    ],
    [
      ['R22', '2'],
      ['U3', '3'],
    ],
    [
      ['I1', '2'],
      ['U3', '3'],
    ],
  ]) {
    assert.notEqual(electrical(a[0], a[1]), -1);
    assert.equal(electrical(a[0], a[1]), electrical(b[0], b[1]), `${a} must connect to ${b}`);
  }
  assert.notEqual(
    electrical('V1', '2'),
    electrical('R22', '2'),
    'Native PGND/SGND remain distinct.',
  );
  const sim = spiceNets(d, ['PGND', 'SGND']);
  for (const ref of refs) {
    const part = d.parts.find((part) => part.ref === ref)!;
    assert.equal((partFields(part).Footprint || '').trim(), '');
    assert.notEqual(part.excludeFromSimulation, true);
    assert.ok(!project.pcb!.footprints.some((footprint) => footprint.symbolId === part.id));
    if (ref !== 'R21') assert.equal(sim.node(part, '2'), '0');
  }
  const deck = buildSpiceDeck(d, defaultTransient(d));
  assert.match(deck.netlist, /^V1 \w+ 0 DC 24$/m);
  assert.match(deck.netlist, /^V2 \w+ 0 DC 12$/m);
  assert.doesNotMatch(deck.netlist, /^(?:VVIN|VVCC|RVIN|RLOAD|ILOAD)\s/m);
  assert.equal(deck.traces.filter((trace) => trace.dissipation).length, 17);
  for (const ref of ['R21', 'R22'])
    assert.equal(
      deck.traces.find((trace) => trace.vector === `@${ref.toLowerCase()}[i]`)?.dissipation,
      undefined,
    );
});

test('native source/current edits change the solver stamps through Core and preserve PCB bytes and undo', async () => {
  const project = projectFromNativeFiles(await readNativeProject(filename));
  const core = new ProjectCore(project);
  const board = () =>
    projectNativeFiles(core.getSnapshot().project!).files.find((file) =>
      file.name.endsWith('.kicad_pcb'),
    )!.source;
  const before = core.getSnapshot().source;
  const boardBefore = board();
  const edit = (ref: string, key: string, value: string) => {
    const project = core.getSnapshot().project!,
      part = project.schematic.parts.find((part) => part.ref === ref)!;
    const source = simulationSourceProperties(part)!;
    const rows = [
      ...Object.entries(partFields(part))
        .filter(([name]) => name !== 'Sim.Params')
        .map(([name, value]) => ({ name, value })),
      ...source.rows.map((row) => (row.sourceKey === key ? { ...row, value } : row)),
    ];
    const change = preparePartProperties(part, part.ref, displayPartValue(part), rows)!;
    core.execute('part.properties', {
      schematicId: project.schematic.id,
      partId: part.id,
      reference: change.ref,
      value: change.value,
      fields: Object.entries(change.fields).map(([name, value]) => ({ name, value })),
    });
  };
  edit('V1', 'dc', '30');
  edit('V2', 'dc', '13');
  edit('I1', 'y1', '0.75');
  const current = core.getSnapshot().project!;
  const deck = buildSpiceDeck(current.schematic, defaultTransient(current.schematic));
  assert.match(deck.netlist, /^V1 \w+ 0 DC 30$/m);
  assert.match(deck.netlist, /^V2 \w+ 0 DC 13$/m);
  assert.match(deck.netlist, /^I1 \w+ 0 PULSE\(0\.75 /m);
  assert.equal(
    simulationSourceProperties(current.schematic.parts.find((part) => part.ref === 'I1')!)!.rows[0]
      .label,
    'Initial current (A)',
  );
  assert.equal(board(), boardBefore);
  const reopened = projectFromNativeFiles(projectNativeFiles(current));
  assert.equal(
    buildSpiceDeck(reopened.schematic, defaultTransient(reopened.schematic)).netlist,
    deck.netlist,
  );
  for (let i = 0; i < 3; i++) core.undo();
  assert.equal(core.getSnapshot().source, before);
});

test('current-source waveform conversion stays in its family; missing or malformed bench devices never use injected defaults', async () => {
  const project = projectFromNativeFiles(await readNativeProject(filename));
  const part = project.schematic.parts.find((part) => part.ref === 'I1')!;
  const rows = [
    ...Object.entries(partFields(part))
      .filter(([name]) => name !== 'Sim.Params')
      .map(([name, value]) => ({ name, value })),
    ...simulationSourceProperties(part)!.rows,
  ];
  const change = prepareSourceConversion(part, part.ref, displayPartValue(part), rows, 'SIN')!;
  Object.assign(part, change);
  assert.equal(
    simulationSourceProperties(part)!.rows.find((row) => row.sourceKey === 'ampl')!.unit,
    'A',
  );
  assert.match(
    buildSpiceDeck(project.schematic, defaultTransient(project.schematic)).netlist,
    /^I1 \w+ 0 SIN\(/m,
  );
  part.fields!['Sim.Params'] = 'ampl=1 f=100\n.control';
  assert.throws(
    () => buildSpiceDeck(project.schematic, defaultTransient(project.schematic)),
    /simulation parameter/i,
  );
  project.schematic.parts = project.schematic.parts.filter((part) => part.ref !== 'V2');
  assert.throws(
    () => buildSpiceDeck(project.schematic, defaultTransient(project.schematic)),
    /complete bundled/,
  );
});

test('native testbench generation is idempotent and retains electrical records while removing section 7 notes', () => {
  const source = readFileSync(
    'resources/example-catalog/sources/emc-flyback/design/emc_flyback.kicad_sch',
    'utf8',
  );
  const before = parseSExpr(source);
  const afterText = prepareEmcFlybackNativeTestbench(source);
  const after = parseSExpr(afterText);
  assert.equal(prepareEmcFlybackNativeTestbench(afterText), afterText);
  for (const node of before.filter(Array.isArray)) {
    if (isEmcDatasheetSection(node) || isEmcCircuitFrame(node)) continue;
    if (node[0] === 'lib_symbols') {
      for (const symbol of children(node, 'symbol'))
        assert.deepEqual(
          children(child(after, 'lib_symbols')!, 'symbol').find(
            (item) => val(item) === val(symbol),
          ),
          symbol,
        );
    } else
      assert.ok(
        after.some((item) => JSON.stringify(item) === JSON.stringify(node)),
        `Retain ${node[0]} ${val(child(node, 'uuid'))}`,
      );
  }
  const native = parseCircuit(afterText);
  assert.equal(native.parts.length, parseCircuit(source).parts.length + 5);
});
