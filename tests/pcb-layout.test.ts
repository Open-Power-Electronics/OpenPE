import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createPart, emptyCircuit, uid } from '../lib/circuit';
import {
  createEmptyPCB,
  createPCBFootprint,
  deletePCBSelection,
  flipPCBFootprint,
  footprintPoint,
  movePCBSelection,
  padPosition,
  padRotation,
  pcbBounds,
  projectPointToTrack,
  rotatePCBSelection,
  routePoints,
  type PCBSelection,
} from '../lib/pcb-layout';
import {
  createProject,
  exportKiCad,
  parseProject,
  serializeProject,
  validateProject,
} from '../lib/project';
import { child, children, num, parseSExpr, val } from '../lib/sexpr';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';

// Parser fixtures deliberately use a test identity rather than posing as library assets.
const source = `(footprint "TwoPin"
  (version 20260206) (generator "test") (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -3 0) (layer "F.SilkS"))
  (property "Value" "TwoPin" (at 0 3 0) (layer "F.Fab"))
  (fp_rect (start -2 -1) (end 2 1) (stroke (width 0.12) (type solid)) (fill no) (layer "F.SilkS"))
  (pad "1" thru_hole rect (at -1.27 0.635 30) (size 1.8 1.4) (drill 0.8) (layers "*.Cu" "*.Mask"))
  (pad "2" thru_hole oval (at 1.27 0) (size 1.8 1.4) (drill 0.8) (layers "*.Cu" "*.Mask")))`;
function fixture(text = source) {
  const circuit = emptyCircuit();
  const symbol = createPart(circuit, 'R', 12.7, 12.7);
  circuit.parts.push(symbol);
  const detail = { id: 'Test:TwoPin', footprint: parseSExpr(text) };
  const footprint = createPCBFootprint(detail, circuit, symbol.id, { x: 25.4, y: 25.4 });
  const project = createProject(circuit);
  project.pcb = { ...createEmptyPCB(), footprints: [footprint] };
  return { circuit, symbol, detail, footprint, project };
}

test('empty board is valid; placement embeds all supported geometry with stable IDs through JSON and native export', () => {
  const empty = createProject();
  empty.pcb = createEmptyPCB();
  validateProject(empty);
  const { project, footprint, detail } = fixture();
  validateProject(project);
  assert.equal(footprint.graphics.filter((g) => g.kind !== 'text').length, 4);
  const fields = footprint.graphics.filter((g) => g.kind === 'text');
  assert.deepEqual(
    fields.map((g) => [g.text?.property, g.layer]),
    [
      ['Reference', 'F.SilkS'],
      ['Value', 'F.Fab'],
    ],
  );
  assert.equal(footprint.pads.length, 2);
  assert.ok(footprint.pads.every((p) => p.netId === null));
  assert.equal(val(detail.footprint), 'TwoPin');
  const reopened = parseProject(serializeProject(project));
  assert.deepEqual(reopened.pcb, project.pcb);
  const native = parseSExpr(exportKiCad(reopened, 'pcb'));
  const exported = children(native, 'footprint')[0];
  assert.equal(val(exported), detail.id);
  assert.equal(val(child(exported, 'uuid')), footprint.id);
  assert.equal(children(exported, 'fp_line').length, 4);
  assert.deepEqual(
    children(exported, 'property').map((field) => val(child(field, 'uuid'))),
    fields.map((field) => field.id),
  );
  assert.deepEqual(
    children(exported, 'pad').map((p) => val(child(p, 'uuid'))),
    footprint.pads.map((p) => p.id),
  );
  assert.deepEqual(
    children(exported, 'pad').map((p) => [num(child(p, 'at')), num(child(p, 'at'), 2)]),
    footprint.pads.map((p) => [p.x, p.y]),
  );
});

test('reject unsupported or changed physical geometry instead of manufacturing an approximation', () => {
  const mutations = [
    source.replace('thru_hole rect', 'thru_hole roundrect'),
    source.replace('thru_hole rect', 'np_thru_hole circle'),
    source.replace('(drill 0.8)', '(drill oval 0.8 1)'),
    source.replace('(drill 0.8)', '(drill 0.8 (offset 0.1 0))'),
    source.replace('(drill 0.8)', '(drill 2)'),
    source.replace('(fill no)', '(fill solid)'),
    source.replace('(type solid)', '(type dash)'),
    source.replace('(fill no) (layer "F.SilkS")', '(fill no) (layer "F.Cu")'),
    source.replace('(pad "2"', '(pad "9"'),
    source.replace('(size 1.8 1.4)', '(size 1.8 0)'),
    source.replace('(at -1.27 0.635 30)', '(at -1.27 0.6350001 30)'),
    source.replace('(at -1.27 0.635 30)', '(at -1.27 NaN 30)'),
    source.replace('(layers "*.Cu" "*.Mask")', '(layers "F.Cu" "F.Mask")'),
    source.replace(
      '(layers "*.Cu" "*.Mask")',
      '(layers "*.Cu" "*.Mask") (remove_unused_layers yes)',
    ),
    source.replace('(generator "test")', '(generator "test") (zone_connect 2)'),
    source.replace(
      '(generator "test")',
      '(generator "test") (fp_arc (start 0 0) (mid 1 1) (end 2 0))',
    ),
    source.replace('(generator "test")', '(generator "test") (fp_text user "Polarity")'),
    source.replace(
      '(generator "test")',
      '(generator "test") (property "Polarity" "+" (layer "F.SilkS"))',
    ),
    source.replace('(size 1.8 1.4)', '(size 1.8 1.4) (size 1 1)'),
    source.replace('(size 1.8 1.4)', '(size 1.8 1.4 1)'),
    source.replace('(at -1.27 0.635 30)', '(at -1.27 0.635 30 40)'),
    source
      .replace('thru_hole rect', 'thru_hole roundrect')
      .replace('(size 1.8 1.4)', '(size 1.8 1.4) (roundrect_rratio 0.6)'),
    source
      .replace('thru_hole rect', 'thru_hole roundrect')
      .replace('(size 1.8 1.4)', '(size 1.8 1.4) (roundrect_rratio NaN)'),
    source.replace('(size 1.8 1.4)', '(size 1.8 1.4) (roundrect_rratio 0.25)'),
  ];
  for (const text of mutations) {
    assert.notEqual(text, source);
    assert.throws(() => fixture(text), /Layout:/);
  }
  const { detail, circuit, symbol } = fixture();
  assert.throws(
    () => createPCBFootprint(detail, circuit, uid(), { x: 0, y: 0 }),
    /primary schematic/,
  );
  assert.throws(
    () => createPCBFootprint({ ...detail, id: 'Test:Wrong' }, circuit, symbol.id, { x: 0, y: 0 }),
    /library identity/,
  );
});

test('bundled 0805 placement preserves six-decimal artwork and rounded pad corners through native save and reopen', () => {
  const raw = parseSExpr(
    readFileSync(
      'resources/kicad/10.0.0/footprints/Resistor_SMD.pretty/R_0805_2012Metric.kicad_mod',
      'utf8',
    ),
  );
  const { circuit, symbol } = fixture();
  const footprint = createPCBFootprint(
    { id: 'Resistor_SMD:R_0805_2012Metric', footprint: raw },
    circuit,
    symbol.id,
    { x: 20, y: 20 },
  );
  assert.deepEqual(footprint.graphics[0].start, { x: -0.227064, y: -0.735 });
  assert.deepEqual(footprint.graphics[0].end, { x: 0.227064, y: -0.735 });
  assert.ok(
    footprint.pads.every((pad) => pad.shape === 'roundrect' && pad.roundrectRatio === 0.243902),
  );
  const project = {
    ...createProject(circuit),
    pcb: { ...createEmptyPCB(), footprints: [footprint] },
  };
  validateProject(project);
  const files = projectNativeFiles(project, 'placed.kicad_pro');
  const reopened = projectFromNativeFiles(files);
  const restored = reopened.pcb!.footprints[0];
  for (const graphic of footprint.graphics) {
    const { stroke: _stroke, ...actual } = restored.graphics.find((item) => item.id === graphic.id)!;
    assert.deepEqual(actual, graphic);
  }
  const padGeometry = (pad: (typeof footprint.pads)[number]) => ({
    id: pad.id,
    number: pad.number,
    x: pad.x,
    y: pad.y,
    size: pad.size,
    shape: pad.shape,
    rotation: pad.rotation,
    roundrectRatio: pad.roundrectRatio,
  });
  assert.deepEqual(restored.pads.map(padGeometry), footprint.pads.map(padGeometry));
  const unchanged = projectNativeFiles(reopened, files.entry);
  assert.deepEqual(unchanged, files);
});

test(
  'placement handles a real bundled official pin header without replacing its pad or line geometry',
  {
    skip: !existsSync(
      'resources/kicad/10.0.0/footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical.kicad_mod',
    ),
  },
  () => {
    const { circuit, symbol } = fixture();
    const raw = parseSExpr(
      readFileSync(
        'resources/kicad/10.0.0/footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical.kicad_mod',
        'utf8',
      ),
    );
    const footprint = createPCBFootprint(
      { id: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', footprint: raw },
      circuit,
      symbol.id,
      { x: 0, y: 0 },
    );
    assert.equal(
      footprint.graphics.filter((g) => g.kind !== 'text').length,
      children(raw, 'fp_line').length + 4 * children(raw, 'fp_rect').length,
    );
    assert.deepEqual(
      footprint.pads.map((p) => [p.number, p.x, p.y, p.drill]),
      [
        ['1', 0, 0, 1],
        ['2', 0, 2.54, 1],
      ],
    );
    const project = createProject(circuit);
    project.pcb = { ...createEmptyPCB(), footprints: [footprint] };
    validateProject(project);
  },
);

test('rotated and back-side pad positions match native export local coordinates without a second mirror', () => {
  const { project, footprint } = fixture();
  footprint.rotation = 90;
  assert.deepEqual(footprintPoint(footprint, { x: 2, y: 1 }), { x: 26.4, y: 23.4 });
  assert.deepEqual(padPosition(footprint, footprint.pads[0]), { x: 26.035, y: 26.67 });
  assert.equal(padRotation(footprint, footprint.pads[0]), 120);
  const before = structuredClone(footprint);
  const back = flipPCBFootprint(footprint);
  assert.deepEqual(footprint, before);
  assert.equal(back.side, 'back');
  assert.equal(back.pads[0].id, footprint.pads[0].id);
  assert.ok(
    back.graphics.every((g) => g.layer === (g.text?.property === 'Value' ? 'B.Fab' : 'B.SilkS')),
  );
  assert.deepEqual(padPosition(back, back.pads[0]), { x: 26.035, y: 24.13 });
  assert.deepEqual(flipPCBFootprint(back), before);
  project.pcb!.footprints = [back];
  validateProject(project);
  const exported = children(parseSExpr(exportKiCad(project, 'pcb')), 'footprint')[0];
  assert.equal(val(child(exported, 'layer')), 'B.Cu');
  const pad = children(exported, 'pad')[0];
  const at = child(pad, 'at');
  assert.equal(((num(at, 3) % 360) + 360) % 360, padRotation(back, back.pads[0]));
  assert.deepEqual(
    footprintPoint(back, { x: num(at), y: num(at, 2) }),
    padPosition(back, back.pads[0]),
  );
});

test('move, rotate and delete preserve UUIDs, nets and unrelated board content as independent edits', () => {
  const { project, footprint } = fixture();
  const board = project.pcb!;
  const net = { id: uid(), name: 'OUT' };
  board.nets.push(net);
  footprint.pads[0].netId = net.id;
  board.tracks.push({
    id: uid(),
    start: { x: 0, y: 0 },
    end: { x: 5.08, y: 0 },
    width: 0.25,
    layer: 'F.Cu',
    netId: net.id,
  });
  board.vias.push({ id: uid(), x: 5.08, y: 0, diameter: 0.8, drill: 0.4, netId: net.id });
  board.zones.push({
    id: uid(),
    netId: net.id,
    layer: 'B.Cu',
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    clearance: 0.3,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  });
  const original = structuredClone(board);
  const selection = { kind: 'footprint' as const, id: footprint.id };
  const moved = movePCBSelection(board, selection, { x: 1.27, y: -2.54 });
  assert.deepEqual(board, original);
  assert.equal(moved.footprints[0].id, footprint.id);
  assert.deepEqual(moved.footprints[0].pads, footprint.pads);
  assert.equal(moved.tracks[0], board.tracks[0]);
  const rotated = rotatePCBSelection(moved, selection);
  assert.equal(rotated.footprints[0].rotation, 90);
  assert.deepEqual(rotated.zones, board.zones);
  const removed = deletePCBSelection(rotated, selection);
  assert.equal(removed.footprints.length, 0);
  assert.deepEqual(removed.tracks, board.tracks);
  assert.deepEqual(removed.nets, board.nets);
  project.pcb = removed;
  validateProject(project);
  assert.equal(movePCBSelection(board, selection, { x: 0, y: 0 }), board);
  assert.equal(rotatePCBSelection(board, selection, 360), board);
  assert.throws(() => movePCBSelection(board, selection, { x: Infinity, y: 0 }), /Coordinates/);
});

test('group rotation uses one arbitrary pivot for footprints, copper and complete artwork geometry', () => {
  const { project, circuit, footprint, detail } = fixture();
  const board = project.pcb!;
  footprint.x = 12.5;
  footprint.y = -2.75;
  footprint.rotation = 270;
  const otherPart = createPart(circuit, 'R', 20.32, 12.7);
  circuit.parts.push(otherPart);
  const otherFootprint = createPCBFootprint(detail, circuit, otherPart.id, { x: 40, y: 50 });
  board.footprints.push(otherFootprint);
  const net = { id: uid(), name: 'OUT' };
  board.nets.push(net);
  board.tracks.push({
    id: uid(),
    start: { x: 11, y: -3.75 },
    end: { x: 13, y: -1.75 },
    width: 0.3,
    layer: 'B.Cu',
    netId: net.id,
  });
  board.vias.push({ id: uid(), x: 14, y: -3.75, diameter: 0.8, drill: 0.4, netId: net.id });
  board.graphics.push(
    {
      id: uid(),
      kind: 'arc',
      start: { x: 11, y: -3.75 },
      mid: { x: 12, y: -4.75 },
      end: { x: 13, y: -3.75 },
      width: 0.12,
      layer: 'Dwgs.User',
      stroke: 'dash',
    },
    {
      id: uid(),
      kind: 'polygon',
      start: { x: 11, y: -3.75 },
      points: [{ x: 13, y: -3.75 }],
      end: { x: 13, y: -1.75 },
      width: 0.1,
      layer: 'F.SilkS',
      fill: true,
    },
    {
      id: uid(),
      kind: 'text',
      start: { x: 11, y: -3.75 },
      end: { x: 11, y: -3.75 },
      width: 0.1,
      layer: 'F.SilkS',
      text: {
        value: 'OUT',
        rotation: 350,
        size: { x: 1, y: 1 },
        thickness: 0.1,
        justify: ['left', 'mirror'],
      },
    },
    {
      id: uid(),
      kind: 'dimension',
      start: { x: 11, y: -3.75 },
      end: { x: 13, y: -1.75 },
      width: 0.1,
      layer: 'Dwgs.User',
      dimension: {
        type: 'aligned',
        height: 2,
        format: { prefix: '', suffix: ' mm', units: 3, unitsFormat: 1, precision: 2 },
        style: { arrowLength: 1, textPositionMode: 0, extensionOffset: 0.5 },
        caption: {
          x: 12,
          y: -2.75,
          value: '2.83',
          rotation: 315,
          size: { x: 1, y: 1 },
          thickness: 0.1,
        },
      },
    },
  );
  board.zones.push({
    id: uid(),
    netId: net.id,
    layer: 'B.Cu',
    outline: [
      { x: 11, y: -3.75 },
      { x: 13, y: -3.75 },
      { x: 13, y: -1.75 },
      { x: 11, y: -1.75 },
    ],
    holes: [
      [
        { x: 11.5, y: -3.25 },
        { x: 12.5, y: -3.25 },
        { x: 12, y: -2.25 },
      ],
    ],
    filledPolygons: [
      {
        points: [
          { x: 11.1, y: -3.65 },
          { x: 12.9, y: -3.65 },
          { x: 12.9, y: -1.85 },
        ],
        island: true,
      },
    ],
    clearance: 0.3,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    priority: 2,
  });
  validateProject(project);
  const original = structuredClone(board);
  const selection: PCBSelection[] = [
    { kind: 'footprint', id: footprint.id },
    { kind: 'track', id: board.tracks[0].id },
    { kind: 'via', id: board.vias[0].id },
    ...board.graphics.map((g) => ({ kind: 'graphic' as const, id: g.id })),
    { kind: 'zone', id: board.zones[0].id },
  ];
  const pivot = { x: 10, y: -3.75 };
  const rotated = rotatePCBSelection(board, selection, 90, pivot);
  assert.deepEqual(board, original);
  assert.deepEqual(pivot, { x: 10, y: -3.75 });
  assert.deepEqual(rotated.footprints[0], { ...footprint, x: 11, y: -6.25, rotation: 0 });
  assert.equal(rotated.footprints[0].pads, footprint.pads);
  assert.equal(rotated.footprints[0].graphics, footprint.graphics);
  assert.equal(rotated.footprints[1], otherFootprint);
  assert.equal(rotated.nets, board.nets);
  assert.deepEqual(rotated.tracks[0], {
    ...board.tracks[0],
    start: { x: 10, y: -4.75 },
    end: { x: 12, y: -6.75 },
  });
  assert.deepEqual(rotated.vias[0], { ...board.vias[0], x: 10, y: -7.75 });
  assert.deepEqual(rotated.graphics[0], {
    ...board.graphics[0],
    start: { x: 10, y: -4.75 },
    mid: { x: 9, y: -5.75 },
    end: { x: 10, y: -6.75 },
  });
  assert.deepEqual(rotated.graphics[1].points, [{ x: 10, y: -6.75 }]);
  assert.deepEqual(rotated.graphics[2].text, { ...board.graphics[2].text!, rotation: 80 });
  assert.deepEqual(rotated.graphics[3].dimension, {
    ...board.graphics[3].dimension!,
    caption: { ...board.graphics[3].dimension!.caption, x: 11, y: -5.75, rotation: 45 },
  });
  assert.deepEqual(rotated.zones[0].outline, [
    { x: 10, y: -4.75 },
    { x: 10, y: -6.75 },
    { x: 12, y: -6.75 },
    { x: 12, y: -4.75 },
  ]);
  assert.deepEqual(rotated.zones[0].holes, [
    [
      { x: 10.5, y: -5.25 },
      { x: 10.5, y: -6.25 },
      { x: 11.5, y: -5.75 },
    ],
  ]);
  assert.deepEqual(rotated.zones[0].filledPolygons, [
    {
      points: [
        { x: 10.1, y: -4.85 },
        { x: 10.1, y: -6.65 },
        { x: 11.9, y: -6.65 },
      ],
      island: true,
    },
  ]);
  project.pcb = rotated;
  validateProject(project);
  assert.deepEqual(parseProject(serializeProject(project)).pcb, rotated);
  assert.deepEqual(rotatePCBSelection(rotated, selection, -90, pivot), original);
});

test('a selected via rotates in either direction around a pivot without changing neighbours', () => {
  const board = createEmptyPCB();
  const net = { id: uid(), name: 'GND' };
  board.nets.push(net);
  const via = { id: uid(), x: -1.25, y: 5.5, diameter: 0.8, drill: 0.4, netId: net.id };
  const neighbour = { ...via, id: uid(), x: 8 };
  board.vias.push(via, neighbour);
  const selection = { kind: 'via' as const, id: via.id };
  const pivot = { x: -3.25, y: 4.5 };
  const clockwise = rotatePCBSelection(board, selection, -90, pivot);
  const counterclockwise = rotatePCBSelection(board, selection, 90, pivot);
  assert.deepEqual(clockwise.vias[0], { ...via, x: -4.25, y: 6.5 });
  assert.deepEqual(counterclockwise.vias[0], { ...via, x: -2.25, y: 2.5 });
  assert.equal(clockwise.vias[1], neighbour);
  assert.equal(counterclockwise.vias[1], neighbour);
  assert.deepEqual(rotatePCBSelection(clockwise, selection, 90, pivot), board);
  assert.equal(rotatePCBSelection(board, selection, 360, pivot), board);
  assert.throws(() => rotatePCBSelection(board, selection, 90, { x: NaN, y: 0 }), /Coordinates/);
  assert.throws(() => rotatePCBSelection(board, selection, 90, { x: 100001, y: 0 }), /Coordinates/);
  assert.throws(() => rotatePCBSelection(board, selection, Infinity, pivot), /Rotation/);
  assert.deepEqual(board.vias[0], via);
});

test('rotation without a group pivot retains local centers and keeps vias fixed', () => {
  const { project, footprint } = fixture();
  const board = project.pcb!;
  const net = { id: uid(), name: 'OUT' };
  board.nets.push(net);
  board.tracks.push({
    id: uid(),
    start: { x: 0, y: 0 },
    end: { x: 4, y: 0 },
    width: 0.25,
    layer: 'F.Cu',
    netId: net.id,
  });
  board.vias.push({ id: uid(), x: 6, y: 0, diameter: 0.8, drill: 0.4, netId: net.id });
  const selection: PCBSelection[] = [
    { kind: 'footprint', id: footprint.id },
    { kind: 'track', id: board.tracks[0].id },
    { kind: 'via', id: board.vias[0].id },
  ];
  const rotated = rotatePCBSelection(board, selection);
  assert.deepEqual(rotated.footprints[0], { ...footprint, rotation: 90 });
  assert.deepEqual(rotated.tracks[0], {
    ...board.tracks[0],
    start: { x: 2, y: 2 },
    end: { x: 2, y: -2 },
  });
  assert.equal(rotated.vias, board.vias);
});

test('45-degree routes keep precise pad endpoints and only axis-aligned or diagonal segments', () => {
  const start = { x: 1.1234, y: 2.5678 };
  for (const end of [
    { x: 9.4, y: 4.3 },
    { x: -5, y: -8 },
    { x: 1.1234, y: 15 },
  ]) {
    const route = routePoints(start, end);
    assert.deepEqual(route[0], start);
    assert.deepEqual(route.at(-1), end);
    for (let i = 1; i < route.length; i++) {
      const dx = Math.abs(route[i].x - route[i - 1].x),
        dy = Math.abs(route[i].y - route[i - 1].y);
      assert.ok(dx < 1e-9 || dy < 1e-9 || Math.abs(dx - dy) < 1e-9);
      assert.ok(dx + dy > 0);
    }
    assert.deepEqual(routePoints(start, end, 'straight'), [start, end]);
  }
  assert.deepEqual(routePoints(start, start), [start]);
});

test('track anchors project nearby clicks onto finite segments rather than the drawing grid', () => {
  const track = { start: { x: 0.1234, y: 0.5678 }, end: { x: 10.1234, y: 10.5678 } };
  assert.deepEqual(projectPointToTrack(track, { x: 5.1234, y: 4.5678 }), { x: 4.6234, y: 5.0678 });
  assert.deepEqual(projectPointToTrack(track, { x: -5, y: -8 }), track.start);
  assert.deepEqual(projectPointToTrack(track, { x: 15, y: 20 }), track.end);
  assert.deepEqual(
    projectPointToTrack({ start: track.start, end: track.start }, { x: 15, y: 20 }),
    track.start,
  );
  assert.deepEqual(
    projectPointToTrack({ start: { x: 2, y: 3 }, end: { x: 7, y: 3 } }, { x: 4.1234, y: 3.2 }),
    { x: 4.1234, y: 3 },
  );
  assert.throws(() => projectPointToTrack(track, { x: NaN, y: 0 }), /Coordinates/);
});

test('bounds include rotated copper pad extents, track widths, vias and zone outlines', () => {
  const board = createEmptyPCB();
  assert.deepEqual(pcbBounds(board), { minX: 0, minY: 0, maxX: 80, maxY: 60 });
  const pad = {
    id: uid(),
    number: '1',
    x: 0,
    y: 0,
    rotation: 0,
    type: 'smd' as const,
    shape: 'rect' as const,
    size: { x: 4, y: 2 },
    netId: null,
  };
  board.footprints.push({
    id: uid(),
    symbolId: uid(),
    libraryId: 'Test:Bound',
    x: 10,
    y: 10,
    rotation: 90,
    side: 'back',
    pads: [pad],
    graphics: [],
  });
  assert.deepEqual(pcbBounds(board), { minX: 9, minY: 8, maxX: 11, maxY: 12 });
  board.tracks.push({
    id: uid(),
    start: { x: -10, y: 0 },
    end: { x: 0, y: 0 },
    width: 2,
    layer: 'F.Cu',
    netId: uid(),
  });
  board.vias.push({ id: uid(), x: 20, y: 20, diameter: 2, drill: 1, netId: uid() });
  assert.deepEqual(pcbBounds(board), { minX: -11, minY: -1, maxX: 21, maxY: 21 });
  board.zones.push({
    id: uid(),
    netId: uid(),
    layer: 'B.Cu',
    outline: [
      { x: -30, y: -30 },
      { x: 30, y: -30 },
      { x: 30, y: 30 },
    ],
    clearance: 0.3,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  });
  assert.deepEqual(pcbBounds(board), { minX: -30, minY: -30, maxX: 30, maxY: 30 });
  const footprint = board.footprints[0];
  assert.deepEqual(footprintPoint({ ...footprint, x: 100000, rotation: 0 }, { x: 20, y: 0 }), {
    x: 100020,
    y: 10,
  });
});
