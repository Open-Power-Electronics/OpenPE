import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LayoutTrackMaskDrawing } from '../components/LayoutBoardDrawing';
import { ProjectCore } from '../core/project-core';
import { validateLayoutAnnotationContext } from '../lib/agent-annotations';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { exportProjectFile } from '../lib/manufacturing-export';
import {
  defaultPCBDisplay,
  pcbDisplayLayers,
  pcbLayerColor,
  pcbLayerPaintOrder,
} from '../lib/pcb-display';
import { isPCBCopperStack, pcbCopperLayers } from '../lib/pcb-layer-stack';
import { localPadDrillLine } from '../lib/pcb-drill';
import { footprintPoint } from '../lib/pcb-layout';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { pcbViaCopperLayers } from '../lib/pcb-native-via';
import { pcbPadOnLayer, pcbViaDiameter } from '../lib/pcb-padstack';
import {
  boardPolygons,
  filledCopperPolygons,
  fillCopperZone,
  fillCopperZones,
  pcbSavedZoneDisplayPath,
  pcbZoneOutlineDisplayPath,
  worldZones,
} from '../lib/pcb-polygons';
import {
  defaultPCBSelectionFilters,
  selectPCBPadPoint,
  selectPCBPoint,
} from '../lib/pcb-selection';
import { solderMaskOpenings } from '../lib/pcb-solder-mask';
import { pcbTrackMaskOpeningWidth, serializePCB, type PCB } from '../lib/pcb';
import { parseProject, serializeProject } from '../lib/project';
import { child, children, parseSExpr } from '../lib/sexpr';
import { prepareThermalGeometry } from '../plugins/layout-thermal/domain/thermal-geometry';
import { defaultThermalConfig } from '../plugins/layout-thermal/domain/thermal';

const filename = 'Multilayer.kicad_pcb';
const stack =
  '(0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" power "Ground") (8 "In3.Cu" power) (10 "In4.Cu" signal) (2 "B.Cu" signal)';
const zoneId = '78e81c6a-18f4-4a06-8385-4cd4ffce79b0';
const source = `(kicad_pcb
  (version 20260206) (generator "pcbnew")
  (general (thickness 1.6))
  (layers ${stack} (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 1 "GND")
  (segment (start 10 10) (end 15 10) (width 0.25) (layer "In3.Cu") (net "GND"))
  (via (at 15 10) (size 0.65) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND"))
  (gr_rect (start 0 0) (end 50 30) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts"))
  (zone (net "GND") (layers "*.Cu") (uuid "${zoneId}") (hatch edge 0.5)
    (connect_pads (clearance 0.2)) (min_thickness 0.25)
    (fill (thermal_gap 0.3) (thermal_bridge_width 0.3))
    (polygon (pts (xy 20 20) (xy 30 20) (xy 30 25) (xy 20 25))))
)\n`;
const open = (text = source) =>
  projectFromNativeFiles({ entry: filename, files: [{ name: filename, source: text }] });

test('native six-layer board preserves custom layer metadata, inner copper and wildcard zones', () => {
  const project = open();
  const board = project.pcb!;
  const layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'];
  assert.deepEqual(board.layers, layers);
  assert.deepEqual(
    board.zones.map((zone) => zone.layer),
    layers,
  );
  assert.equal(board.tracks[0].layer, 'In3.Cu');
  assert.deepEqual(parseProject(serializeProject(project)).pcb, board);
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === filename)?.source,
    source,
  );
  assert.match(
    serializePCB(board, project.schematic),
    /\(8 "In3.Cu" signal\) \(10 "In4.Cu" signal\)/,
  );

  const core = new ProjectCore(project);
  core.execute('layout.track.properties', {
    boardId: board.id,
    trackId: board.tracks[0].id,
    layer: 'In4.Cu',
  });
  const edited = core.getNativeFiles();
  const reopened = projectFromNativeFiles(edited);
  const boardSource = edited.files.find((file) => file.name === filename)!.source;
  const layerRecords = child(parseSExpr(boardSource), 'layers')!.filter(Array.isArray);
  assert.deepEqual(layerRecords[2], parseSExpr('(6 "In2.Cu" power "Ground")'));
  assert.equal(children(parseSExpr(boardSource), 'zone').length, 6);
  assert.deepEqual(reopened.pcb!.layers, layers);
  assert.equal(reopened.pcb!.tracks[0].layer, 'In4.Cu');

  const gerber = new TextDecoder().decode(exportProjectFile(project, 'gerber', filename).bytes);
  assert.match(gerber, /%TF.FileFunction,Copper,L4,Inr\*%/);
  assert.match(gerber, /%TF.FileFunction,Copper,L6,Bot\*%/);
  assert.throws(
    () => prepareThermalGeometry(board, defaultThermalConfig(board)),
    /two- or four-layer PCB/,
  );
});

test('multi-layer native zones without UUIDs keep deterministic per-layer identities', () => {
  const native = source
    .replace(` (uuid "${zoneId}")`, '')
    .replace('(hatch edge 0.5)', '(hatch full 0.5)');
  const project = open(native);
  const zones = project.pcb!.zones;
  assert.equal(zones.length, 6);
  assert.equal(new Set(zones.map(({ id }) => id)).size, zones.length);
  assert.deepEqual(zones, open(native).pcb!.zones);
  const saved = projectNativeFiles(project, 'Copy.kicad_pro');
  assert.equal(saved.files.find((file) => file.name === 'Copy.kicad_pcb')?.source, native);
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.zones, zones);

  const core = new ProjectCore(project);
  core.execute('layout.properties', { boardId: project.pcb!.id, thickness: 1.7 });
  const edited = core.getNativeFiles();
  const records = children(
    parseSExpr(edited.files.find((f) => f.name === filename)!.source),
    'zone',
  );
  assert.ok(records.every((record) => child(record, 'hatch')?.[1] === 'full'));
  assert.deepEqual(projectFromNativeFiles(edited).pcb!.zones, zones);
});

test('footprint rule areas keep dormant layer membership and separate scoped UUIDs', () => {
  const native = source.replace(
    '  (zone (net',
    `  (footprint "Test:Keepout" (layer "F.Cu") (at 10 10)
      (uuid "b479d5ff-5e37-426e-b4ee-eeb5048d9ada")
      (zone (layers "F.Cu" "In5.Cu") (uuid "${zoneId}") (hatch edge 0.5)
        (connect_pads (clearance 0)) (min_thickness 0.25)
        (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
        (fill (thermal_gap 0.3) (thermal_bridge_width 0.3))
        (polygon (pts (xy 1 1) (xy 3 1) (xy 3 3) (xy 1 3)))))
  (zone (net`,
  );
  const project = open(native);
  const board = project.pcb!;
  const zones = board.footprints[0].zones!;
  assert.equal(board.zones[0].id, zoneId);
  assert.deepEqual(
    zones.map(({ layer }) => layer),
    ['F.Cu', 'In5.Cu'],
  );
  assert.ok(zones.every(({ id }) => id !== zoneId));
  assert.deepEqual(open(native).pcb!.footprints[0].zones, zones);
  assert.ok(!pcbDisplayLayers(board).includes('In5.Cu'));
  assert.ok(!worldZones(board).some(({ layer }) => layer === 'In5.Cu'));
  const footprint = board.footprints[0];
  const [active, dormant] = zones;
  const target = footprintPoint(footprint, active.outline[0]);
  const hits = (zone: typeof active) =>
    selectPCBPoint(
      { ...board, footprints: [{ ...footprint, zones: [zone] }] },
      defaultPCBDisplay(),
      defaultPCBSelectionFilters(),
      target,
      0.001,
    );
  assert.deepEqual(hits(active), [{ kind: 'footprint', id: footprint.id }]);
  assert.deepEqual(hits(dormant), []);
  assert.equal(projectNativeFiles(project).files.find((f) => f.name === filename)?.source, native);

  const core = new ProjectCore(project);
  core.execute('layout.properties', { boardId: board.id, thickness: 1.7 });
  assert.deepEqual(projectFromNativeFiles(core.getNativeFiles()).pcb!.footprints[0].zones, zones);
  const ambiguous =
    native.trimEnd().slice(0, -1) +
    `
    (group "Ambiguous" (uuid "9d90b81d-b92f-42aa-b8db-a24556ee5371") (members "${zoneId}")))`;
  assert.throws(() => open(ambiguous), /duplicate/i);
});

test('enabled sheet placement areas keep their native rule geometry and placement source', () => {
  const placement = '(placement (enabled yes) (sheetname "/Channel A/"))';
  const keepout =
    '(keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))';
  const perLayer = [
    '(property (layer "F.Cu") (hatch_position (xy 1 2)))',
    '(property (layer "B.Cu") (hatch_position (xy 3 4)))',
  ];
  const nativeArea = source
    .replace('(net "GND") (layers "*.Cu")', '(layers "F.Cu" "B.Cu")')
    .replace(
      '(fill (thermal_gap 0.3)',
      `${keepout} ${placement} ${perLayer.join(' ')} (fill (thermal_gap 0.3)`,
    );
  const nativeGroup = `(group "Channel A" (uuid "6f24c2b7-82c0-4530-805b-af2707d3ca09") (members "${zoneId}"))`;
  const native = nativeArea.trimEnd().slice(0, -1) + `  ${nativeGroup}\n)\n`;
  const project = open(native);
  const zones = project.pcb!.zones;
  assert.deepEqual(
    zones.map(({ layer }) => layer),
    ['F.Cu', 'B.Cu'],
  );
  assert.ok(zones.every((zone) => zone.keepout && zone.netId === null && !zone.filledPolygons));
  const expected = { sourceKind: 'sheetname', sourceName: '/Channel A/' };
  assert.deepEqual(
    zones.map(({ nativePlacement }) => nativePlacement),
    [expected, expected],
  );
  assert.match(pcbZoneOutlineDisplayPath(zones[0]), /^M 20 20 L 30 20/);
  assert.equal(projectNativeFiles(project).files.find((f) => f.name === filename)?.source, native);

  const core = new ProjectCore(project);
  const basis = core.getSnapshot();
  assert.throws(
    () =>
      core.execute('layout.zone', {
        boardId: project.pcb!.id,
        zoneId: zones[0].id,
        outline: zones[0].outline.map(({ x, y }) => ({ x: x + 1, y })),
      }),
    /differing layers of a native placement area in Source/,
  );
  assert.equal(core.getSnapshot().revision, basis.revision);
  core.execute('layout.properties', { boardId: project.pcb!.id, thickness: 1.7 });
  const edited = core.getNativeFiles();
  const tree = parseSExpr(edited.files.find((f) => f.name === filename)!.source);
  const records = children(tree, 'zone');
  assert.equal(records.length, 1);
  assert.deepEqual(child(records[0], 'placement'), parseSExpr(placement));
  assert.deepEqual(child(records[0], 'layers'), parseSExpr('(layers "F.Cu" "B.Cu")'));
  assert.deepEqual(
    children(records[0], 'property'),
    perLayer.map((record) => parseSExpr(record)),
  );
  assert.deepEqual(child(tree, 'group'), parseSExpr(nativeGroup));
  assert.deepEqual(projectFromNativeFiles(edited).pcb!.zones, zones);
  assert.throws(() => open(native.replace('/Channel A/', '')), /a named source/);
});

test('a filled Edge.Cuts zone keeps its exact artwork outside copper and the substrate', () => {
  const native = source
    .replace('(net "GND") (layers "*.Cu")', '(layer "Edge.Cuts")')
    .replace('(fill (thermal_gap 0.3)', '(fill yes (thermal_gap 0.3)')
    .replace(
      '(polygon (pts (xy 20 20) (xy 30 20) (xy 30 25) (xy 20 25))))',
      '(polygon (pts (xy 60 20) (xy 70 20) (xy 70 25) (xy 60 25)))\n' +
        '    (filled_polygon (layer "Edge.Cuts") (pts (xy 61 21) (xy 69 21) (xy 69 24) (xy 61 24))))',
    );
  const project = open(native);
  const board = project.pcb!;
  const [zone] = board.zones;
  assert.equal(zone.layer, 'Edge.Cuts');
  assert.equal(zone.netId, null);
  assert.equal(zone.nativeUnassignedFill, undefined);
  assert.equal(pcbSavedZoneDisplayPath(zone), 'M 61 21 L 69 21 L 69 24 L 61 24 Z');
  assert.equal(filledCopperPolygons(board).size, 0);
  assert.equal(Math.max(...boardPolygons(board).flatMap((p) => p.outer.map(({ x }) => x))), 50);
  assert.equal(projectNativeFiles(project).files.find((f) => f.name === filename)?.source, native);
  const gerber = exportProjectFile(project, 'gerber', filename);
  assert.ok(Buffer.from(gerber.bytes).includes('%TF.FileFunction,OtherDrawing,EdgeCutsFill*%'));

  const core = new ProjectCore(project);
  assert.throws(
    () =>
      core.execute('layout.zone', {
        boardId: board.id,
        zoneId: zone.id,
        outline: zone.outline.map(({ x, y }) => ({ x: x + 1, y })),
      }),
    /Editing native filled Edge\.Cuts zones requires Source/,
  );
  core.execute('layout.properties', { boardId: board.id, thickness: 1.7 });
  assert.deepEqual(projectFromNativeFiles(core.getNativeFiles()).pcb!.zones, [zone]);
});

test('copper stacks and presentation use the same physical range and order', () => {
  assert.equal(pcbCopperLayers.length, 32);
  assert.equal(isPCBCopperStack(pcbCopperLayers), true);
  assert.equal(isPCBCopperStack(['F.Cu', 'In1.Cu', 'B.Cu']), false);
  assert.equal(isPCBCopperStack(['F.Cu', 'In2.Cu', 'In1.Cu', 'B.Cu']), false);
  assert.throws(
    () => open(source.replace('(10 "In4.Cu" signal)', '')),
    /Expected 2 to 32 ordered KiCad copper layers/,
  );
  const display = defaultPCBDisplay();
  assert.equal(display['In30.Cu'], true);
  assert.deepEqual(
    pcbLayerPaintOrder(['F.Cu', 'B.Cu', 'In1.Cu', 'In19.Cu', 'In3.Cu', 'In30.Cu', 'Edge.Cuts']),
    ['B.Cu', 'In30.Cu', 'In19.Cu', 'In3.Cu', 'In1.Cu', 'F.Cu', 'Edge.Cuts'],
  );
  assert.notEqual(pcbLayerColor('In3.Cu'), pcbLayerColor('In4.Cu'));
  validateLayoutAnnotationContext({
    version: 1,
    id: zoneId,
    circuitId: zoneId,
    basis: '1:2:3',
    thickness: 1.6,
    layers: pcbCopperLayers,
    counts: { nets: 0, footprints: 0, pads: 0, tracks: 0, vias: 0, graphics: 0, zones: 0 },
  });
});

test('native technical layer records preserve numeric identity, label and geometry', () => {
  const technical = source
    .replace(
      '(25 "Edge.Cuts" user))',
      '(25 "Edge.Cuts" user) (127 "User.45" user "Reference View"))',
    )
    .replace(
      '  (zone ',
      '  (gr_line (start 10 10) (end 11 11) (stroke (width 0.2) (type default)) (layer "User.45"))\n  (zone ',
    );
  const project = open(technical);
  assert.ok(project.pcb!.graphics.some((graphic) => graphic.layer === 'User.45'));
  assert.match(serializePCB(project.pcb!, project.schematic), /\(127 "User\.45" user\)/);
  const core = new ProjectCore(project);
  core.execute('layout.properties', { boardId: project.pcb!.id, thickness: 1.8 });
  const files = core.getNativeFiles();
  assert.match(
    files.files.find((file) => file.name === filename)!.source,
    /\(127\s+"User\.45"\s+user\s+"Reference View"\)/,
  );
  assert.ok(
    projectFromNativeFiles(files).pcb!.graphics.some((graphic) => graphic.layer === 'User.45'),
  );
});

test('net-bearing copper shapes preserve native side and solder mask expansion', () => {
  const graphic =
    '(gr_rect (start 4 4) (end 6 6) (stroke (width 0.1) (type default)) (fill yes) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.12) (net "GND"))';
  const copper = source
    .replace('(25 "Edge.Cuts" user))', '(25 "Edge.Cuts" user) (1 "F.Mask" user))')
    .replace('  (zone ', `  ${graphic}\n  (zone `);
  const project = open(copper);
  const board = project.pcb!;
  const shape = board.graphics.find((candidate) => candidate.layer === 'F.Cu')!;
  assert.equal(shape.netId, board.nets.find((net) => net.name === 'GND')!.id);
  assert.equal(shape.maskLayer, 'F.Mask');
  assert.equal(shape.solderMaskMargin, 0.12);
  assert.deepEqual(parseProject(serializeProject(project)).pcb, board);
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === filename)!.source,
    copper,
  );
  const rules = runPCBDesignRules(board, { minTrackWidth: 0.3 });
  assert.ok(rules.issues.some((issue) => issue.ruleId === 'pcb.track-width'));
  assert.ok(Buffer.from(exportProjectFile(project, 'gerber', filename).bytes).includes('C,0.34*%'));
  assert.throws(
    () => open(copper.replace('"F.Mask") (solder_mask_margin', '"B.Mask") (solder_mask_margin')),
    /mask/,
  );

  const core = new ProjectCore(project);
  assert.throws(
    () =>
      core.execute('layout.track.properties', {
        boardId: board.id,
        trackId: board.tracks[0].id,
        width: 0.35,
      }),
    /native net or mask copper graphics/,
  );
  core.execute('layout.properties', { boardId: board.id, thickness: 1.8 });
  const files = core.getNativeFiles();
  assert.deepEqual(
    projectFromNativeFiles(files).pcb!.graphics.find((candidate) => candidate.layer === 'F.Cu'),
    shape,
  );
});

test('native via spans and filled unassigned vias preserve geometry across save and reopen', () => {
  const viaId = 'e51b1264-a50a-4f3b-998d-9d4f935a66df';
  const native = source.replace(
    '  (zone ',
    `
    (via blind (at 36 18) (size 0.6) (drill 0.3) (layers "F.Cu" "In2.Cu") (net "GND") (uuid "${viaId}"))
    (via micro (at 36 20) (size 0.35) (drill 0.13) (layers "In4.Cu" "B.Cu") (net "GND"))
    (via (at 36 22) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (filling yes) (tenting (front yes) (back yes)) (net 0))
    (zone `,
  );
  const project = open(native);
  const board = project.pcb!;
  const [, blind, micro, filled] = board.vias;
  assert.deepEqual(blind.span, { kind: 'blind', start: 'F.Cu', end: 'In2.Cu' });
  assert.deepEqual(pcbViaCopperLayers(board.layers, blind), ['F.Cu', 'In1.Cu', 'In2.Cu']);
  assert.deepEqual(pcbViaCopperLayers(board.layers, micro), ['In4.Cu', 'B.Cu']);
  assert.equal(filled.netId, '');
  assert.deepEqual(filled.treatment, { filling: true });
  assert.deepEqual(
    board.nets.map((net) => net.name),
    ['GND'],
  );
  assert.deepEqual(parseProject(serializeProject(project)).pcb, board);
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === filename)!.source,
    native,
  );

  const show = (only: PCB['layers'][number]) => ({
    ...defaultPCBDisplay(),
    ...Object.fromEntries(board.layers.map((layer) => [layer, layer === only])),
  });
  const filters = defaultPCBSelectionFilters();
  assert.deepEqual(selectPCBPoint(board, show('In1.Cu'), filters, blind, 0.01), [
    { kind: 'via', id: viaId },
  ]);
  assert.deepEqual(selectPCBPoint(board, show('B.Cu'), filters, blind, 0.01), []);
  assert.equal(solderMaskOpenings(board, 'front').openings.length, 2);
  assert.equal(solderMaskOpenings(board, 'back').openings.length, 2);
  const rules = runPCBDesignRules(board);
  assert.equal(rules.complete, false);
  assert.ok(
    rules.issues.some(
      ({ ruleId, message }) => ruleId === 'pcb.coverage' && /treated/.test(message),
    ),
  );
  assert.ok(rules.checkedRules.includes('pcb.outline'));
  assert.throws(
    () => exportProjectFile(project, 'gerber', filename),
    /native via treatments is unsupported/,
  );
  assert.throws(
    () => exportProjectFile(project, 'drill', filename),
    /native via treatments is unsupported/,
  );
  assert.throws(
    () => open(native.replace('"In4.Cu" "B.Cu"', '"In2.Cu" "B.Cu"')),
    /Invalid native via span/,
  );

  const core = new ProjectCore(project);
  assert.throws(
    () => core.execute('layout.via.properties', { boardId: board.id, viaId, changes: { x: 37 } }),
    /native non-through, treated, or unassigned vias/,
  );
  const next = {
    ...board,
    graphics: [
      ...board.graphics,
      {
        id: 'a14c711d-f6ca-4c88-8774-13922bd1543f',
        kind: 'circle' as const,
        layer: 'F.SilkS' as const,
        start: { x: 3, y: 2 },
        end: { x: 3, y: 3 },
        width: 0.1,
      },
    ],
  };
  core.commitProject({ ...project, pcb: next });
  assert.deepEqual(projectFromNativeFiles(core.getNativeFiles()).pcb!.vias, board.vias);
  const rebuilt = serializePCB(board, project.schematic);
  assert.match(rebuilt, /\(via blind [^\n]+\(layers "F\.Cu" "In2\.Cu"\)/);
  assert.match(rebuilt, /\(net 0\)[^\n]+\(filling yes\)/);
});

test('native front_inner_back padstacks retain individual plated pad and via shapes', () => {
  const pcb = source.replace(
    '  (zone ',
    `
    (footprint "Test:StackedPad" (layer "F.Cu") (at 36 18)
      (pad "1" thru_hole circle (at 0 0) (size 1.8 1.8) (drill 1) (layers "*.Cu" "*.Mask")
        (padstack (mode front_inner_back)
          (layer "Inner" (shape circle) (size 1.3 1.3) (zone_connect 1))
          (layer "B.Cu" (shape rect) (size 2 2)))))
    (via (at 36 22) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND")
      (padstack (mode front_inner_back) (layer "Inner" (size 0.5)) (layer "B.Cu" (size 0))))
    (zone `,
  );
  const project = open(pcb);
  const board = project.pcb!;
  const {
    pads: [pad],
  } = board.footprints[0];
  const via = board.vias[1];
  assert.equal(pcbPadOnLayer(pad, 'F.Cu'), pad);
  assert.deepEqual(pcbPadOnLayer(pad, 'In3.Cu').size, { x: 1.3, y: 1.3 });
  assert.equal(pcbPadOnLayer(pad, 'In3.Cu').zoneConnect, 1);
  assert.equal(pcbPadOnLayer(pad, 'B.Cu').shape, 'rect');
  assert.equal(pcbViaDiameter(via, 'In4.Cu'), 0.5);
  assert.equal(pcbViaDiameter(via, 'B.Cu'), 0);
  assert.equal(via.drill, 0.3);

  const show = (only: PCB['layers'][number]) => ({
    ...defaultPCBDisplay(),
    ...Object.fromEntries(board.layers.map((layer) => [layer, layer === only])),
  });
  const filters = { ...defaultPCBSelectionFilters(), pad: true };
  assert.deepEqual(selectPCBPadPoint(board, show('B.Cu'), filters, { x: 36.92, y: 18.92 }, 0.01), [
    pad.id,
  ]);
  assert.deepEqual(
    selectPCBPadPoint(board, show('In1.Cu'), filters, { x: 36.92, y: 18.92 }, 0.01),
    [],
  );
  assert.deepEqual(selectPCBPoint(board, show('B.Cu'), filters, { x: 36.22, y: 22 }, 0.01), []);
  assert.deepEqual(selectPCBPoint(board, show('In2.Cu'), filters, { x: 36.22, y: 22 }, 0.01), [
    { kind: 'via', id: via.id },
  ]);
  assert.deepEqual(parseProject(serializeProject(project)).pcb, board);
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === filename)!.source,
    pcb,
  );
  const rebuilt = serializePCB(board, project.schematic);
  assert.deepEqual(open(rebuilt).pcb!.footprints[0].pads[0].padstack, pad.padstack);
  assert.deepEqual(open(rebuilt).pcb!.vias[1].padstack, via.padstack);
  const rules = runPCBDesignRules(board, { minAnnularRing: 0.2 });
  const padRing = rules.issues.find(
    (issue) => issue.ruleId === 'pcb.annular-ring' && issue.objectIds.includes(pad.id),
  );
  assert.match(padRing?.message ?? '', /0\.15 mm minimum annular ring/);
  const gerber = Buffer.from(exportProjectFile(project, 'gerber', filename).bytes);
  assert.ok(gerber.includes('C,1.8*%'));
  assert.ok(gerber.includes('C,1.3*%'));
});

test('a custom plated padstack projects the shifted back land around the shared drill', () => {
  const stack = `(padstack (mode custom)
    (layer "B.Cu" (shape oval) (size 3.5 1.4) (offset 1 0) (zone_connect -1)))`;
  const native = source.replace(
    '  (zone ',
    `(footprint "Test:ShiftedPad" (layer "F.Cu") (at 36 18)
      (pad "1" thru_hole circle (at 2 3 90) (size 1.4 1.4) (drill 0.84 (offset 0 0))
        (layers "*.Cu" "*.Mask") ${stack}))
    (zone `,
  );
  const project = open(native);
  const [pad] = project.pcb!.footprints[0].pads;
  const back = pcbPadOnLayer(pad, 'B.Cu');
  assert.equal(pcbPadOnLayer(pad, 'In1.Cu'), pad);
  assert.equal(pcbPadOnLayer(pad, 'F.Cu'), pad);
  assert.deepEqual(pcbPadOnLayer(pad, 'B.Mask'), back);
  assert.equal(back.shape, 'oval');
  assert.deepEqual(back.size, { x: 3.5, y: 1.4 });
  assert.deepEqual({ x: back.x, y: back.y }, { x: 2, y: 2 });
  assert.deepEqual(footprintPoint(back, localPadDrillLine(back)[0]), { x: 2, y: 3 });
  const core = new ProjectCore(project);
  const file = () => core.getNativeFiles().files.find((record) => record.name === filename)!.source;
  assert.equal(file(), native);
  core.execute('layout.properties', { boardId: project.pcb!.id, thickness: 1.8 });
  const compiledPad = children(child(parseSExpr(file()), 'footprint')!, 'pad')[0];
  assert.deepEqual(child(compiledPad, 'padstack'), parseSExpr(stack));
  assert.deepEqual(open(file()).pcb!.footprints[0].pads[0].padstack, pad.padstack);
  assert.throws(
    () => open(native.replace('"B.Cu" (shape oval)', '"In5.Cu" (shape oval)')),
    /unique board copper layers/,
  );

  const frontOverride = native.replace(
    '(mode custom)',
    '(mode custom) (layer "F.Cu" (shape rect) (size 2 2))',
  );
  const [frontPad] = open(frontOverride).pcb!.footprints[0].pads;
  assert.equal(pcbPadOnLayer(frontPad, 'F.Cu').shape, 'rect');
  assert.equal(pcbPadOnLayer(frontPad, 'In1.Cu').shape, 'rect');
  assert.equal(pcbPadOnLayer(frontPad, 'B.Cu').shape, 'oval');
});

test('a circular native copper pad uses its X diameter and preserves the stored Y dimension', () => {
  const native = source.replace(
    '  (zone ',
    `(footprint "Test:RoundPad" (layer "F.Cu") (at 36 18)
      (pad "" thru_hole circle (at 0 0) (size 2.7 4.7) (drill 1.2) (layers "*.Cu" "*.Mask")))
    (zone `,
  );
  const project = open(native);
  assert.deepEqual(project.pcb!.footprints[0].pads[0].size, { x: 2.7, y: 2.7 });
  const core = new ProjectCore(project);
  core.execute('layout.properties', { boardId: project.pcb!.id, thickness: 1.8 });
  const compiled = core.getNativeFiles();
  const file = compiled.files.find((record) => record.name === filename)!;
  assert.match(file.source, /\(size\s+2\.7\s+4\.7\)/);
  assert.deepEqual(projectFromNativeFiles(compiled).pcb!.footprints[0].pads[0].size, {
    x: 2.7,
    y: 2.7,
  });
});

test('native board and footprint assembly variants survive Layout edits and reopen', () => {
  const variants = '(variants (variant (name "THT") (description "Hand assembly")))';
  const footprintVariant =
    '(variant (name "THT") (dnp yes) (field (name "Value") (value "10 kΩ")))';
  const native = source.replace(
    '  (zone ',
    `${variants}
    (footprint "Test:Assembly" (layer "F.Cu") (at 36 18) ${footprintVariant}
      (pad "1" smd rect (at 0 0) (size 1.4 1.4) (layers "F.Cu")))
    (zone `,
  );
  const project = open(native);
  const core = new ProjectCore(project);
  core.execute('layout.properties', { boardId: project.pcb!.id, thickness: 1.8 });
  const compiled = core.getNativeFiles();
  const root = parseSExpr(compiled.files.find((record) => record.name === filename)!.source);
  assert.deepEqual(child(root, 'variants'), parseSExpr(variants));
  const footprint = child(root, 'footprint');
  assert.ok(footprint);
  assert.deepEqual(child(footprint, 'variant'), parseSExpr(footprintVariant));
  assert.deepEqual(projectFromNativeFiles(compiled).pcb!.footprints, project.pcb!.footprints);
  assert.throws(() => exportProjectFile(project, 'bom', filename), /native KiCad variants/);
  assert.throws(
    () => open(native.replace('(dnp yes)', '(dnp unknown)')),
    /native assembly variant/,
  );
});

test('native pruned via preserves its drill, known copper rings and saved zone connections', () => {
  const pcb = source.replace(
    '(layers "F.Cu" "B.Cu") (net "GND"))',
    '(layers "F.Cu" "B.Cu") (remove_unused_layers yes) (keep_end_layers yes) (zone_layer_connections "In2.Cu") (net "GND"))',
  );
  const project = open(pcb);
  const board = project.pcb!;
  const [via] = board.vias;
  assert.equal(via.removeUnusedLayers, true);
  assert.equal(via.drill, 0.3);
  assert.equal(pcbViaDiameter(via, 'F.Cu'), 0.65);
  assert.equal(pcbViaDiameter(via, 'B.Cu'), 0.65);
  assert.equal(pcbViaDiameter(via, 'In2.Cu'), 0.65);
  assert.equal(pcbViaDiameter(via, 'In3.Cu'), 0);
  assert.deepEqual(parseProject(serializeProject(project)).pcb, board);
  assert.deepEqual(open(serializePCB(board, project.schematic)).pcb!.vias, board.vias);
  assert.ok(runPCBDesignRules(board).checkedRules.includes('pcb.unrouted'));
});

test('end-only native via keeps both annuli and does not flash connected inner layers', () => {
  const pcb = source.replace(
    '(layers "F.Cu" "B.Cu") (net "GND"))',
    '(layers "F.Cu" "B.Cu") (start_end_only yes) (zone_layer_connections "In2.Cu") (net "GND"))',
  );
  const project = open(pcb);
  const [via] = project.pcb!.vias;
  assert.equal(via.startEndOnly, true);
  assert.equal(via.drill, 0.3);
  assert.equal(pcbViaDiameter(via, 'F.Cu'), 0.65);
  assert.equal(pcbViaDiameter(via, 'In2.Cu'), 0);
  assert.equal(pcbViaDiameter(via, 'B.Cu'), 0.65);
  assert.deepEqual(parseProject(serializeProject(project)).pcb, project.pcb);
  assert.deepEqual(
    open(serializePCB(project.pcb!, project.schematic)).pcb!.vias,
    project.pcb!.vias,
  );
});

test('native hatched zone settings and layer-specific hatch origins survive save', () => {
  const pcb = source
    .replace(
      '(fill (thermal_gap 0.3) (thermal_bridge_width 0.3))',
      '(fill yes (mode hatch) (thermal_gap 0.3) (thermal_bridge_width 0.3) (hatch_thickness 0.2) (hatch_gap 0.25) (hatch_orientation 22.5) (hatch_smoothing_level 1) (hatch_smoothing_value 0.2) (hatch_border_algorithm hatch_thickness) (hatch_min_hole_area 0.15))',
    )
    .replace(
      '(polygon (pts (xy 20 20)',
      '(property (layer "F.Cu") (hatch_position (xy 0 0))) (property (layer "B.Cu") (hatch_position (xy 0.25 -0.15))) (polygon (pts (xy 20 20)',
    );
  const project = open(pcb);
  const board = project.pcb!;
  assert.deepEqual(board.zones[0].hatchFill, {
    thickness: 0.2,
    gap: 0.25,
    orientation: 22.5,
    minHoleArea: 0.15,
    borderAlgorithm: 'hatch_thickness',
    smoothingLevel: 1,
    smoothingValue: 0.2,
  });
  assert.deepEqual(board.zones[0].hatchPosition, { x: 0, y: 0 });
  assert.equal(board.zones[1].hatchPosition, undefined);
  assert.deepEqual(board.zones.at(-1)!.hatchPosition, { x: 0.25, y: -0.15 });
  assert.deepEqual(parseProject(serializeProject(project)).pcb, board);
  assert.deepEqual(open(serializePCB(board, project.schematic)).pcb!.zones, board.zones);
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === filename)!.source,
    pcb,
  );
  assert.throws(
    () => fillCopperZones(board),
    /Copper refill for native hatch settings requires KiCad/,
  );
  assert.throws(
    () => open(pcb.replace('(property (layer "F.Cu")', '(property (layer "User.1")')),
    /Property layer disagrees with its multi-layer zone/,
  );
});

test('netless straight and arc tracks retain and paint their native mask openings', () => {
  const pcb = source
    .replace(
      '(layer "In3.Cu") (net "GND")',
      '(layers "F.Cu" "F.Mask") (solder_mask_margin 0.6) (net "")',
    )
    .replace(
      '  (via ',
      '  (arc (start 10 12) (mid 12 14) (end 14 12) (width 0.2) (layers "F.Mask" "F.Cu") (solder_mask_margin 0.7) (net ""))\n  (via ',
    );
  const project = open(pcb);
  const board = project.pcb!;
  const [track] = board.tracks;
  const [arc] = board.arcTracks!;
  assert.deepEqual([track.netId, arc.netId], ['', '']);
  assert.deepEqual(
    board.nets.map((net) => net.name),
    ['GND'],
  );
  assert.equal(track.layer, 'F.Cu');
  assert.equal(arc.maskLayer, 'F.Mask');
  assert.equal(pcbTrackMaskOpeningWidth(track), 1.45);
  assert.ok(Math.abs(pcbTrackMaskOpeningWidth(arc) - 1.6) < 1e-8);
  assert.ok(pcbDisplayLayers(board).includes('F.Mask'));
  assert.match(
    renderToStaticMarkup(createElement(LayoutTrackMaskDrawing, { track })),
    /stroke-width="1\.45"[^>]+stroke-linecap="round"/,
  );
  assert.match(
    renderToStaticMarkup(createElement(LayoutTrackMaskDrawing, { track: arc })),
    /d="M 10 12 A /,
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(LayoutTrackMaskDrawing, { track: { ...track, solderMaskMargin: undefined } }),
    ),
    '',
  );
  assert.deepEqual(parseProject(serializeProject(project)).pcb, board);
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === filename)!.source,
    pcb,
  );
  const rebuilt = open(serializePCB(board, project.schematic)).pcb!;
  assert.deepEqual(rebuilt.tracks, board.tracks);
  assert.deepEqual(rebuilt.arcTracks, board.arcTracks);
  const widthIssues = runPCBDesignRules(board, { minTrackWidth: 0.3 }).issues.filter(
    (issue) => issue.ruleId === 'pcb.track-width',
  );
  assert.deepEqual(
    widthIssues.map((issue) => issue.objectIds),
    [[track.id], [arc.id]],
  );
  const gerber = Buffer.from(exportProjectFile(project, 'gerber', filename).bytes);
  assert.ok(gerber.includes('C,1.45*%'));
  assert.ok(gerber.includes('C,1.6*%'));
  assert.throws(
    () =>
      open(
        pcb.replace('"F.Cu" "F.Mask") (solder_mask_margin', '"F.Cu" "B.Mask") (solder_mask_margin'),
      ),
    /solder mask must match/,
  );
});

test('native unassigned copper keeps its exact saved contour for read-only checks', () => {
  const pcb = source
    .replace('(zone (net "GND") (layers "*.Cu")', '(zone (layer "B.Cu")')
    .replace('(fill (thermal_gap', '(fill yes (thermal_gap')
    .replace(
      '(polygon (pts (xy 20 20) (xy 30 20) (xy 30 25) (xy 20 25))))',
      '(polygon (pts (xy 20 20) (xy 30 20) (xy 30 25) (xy 20 25))) (filled_polygon (layer "B.Cu") (pts (xy 21 21) (xy 29 21) (xy 29 24) (xy 21 24))))',
    );
  const project = open(pcb);
  const board = project.pcb!;
  const [zone] = board.zones;
  assert.equal(zone.netId, null);
  assert.deepEqual(zone.filledPolygons, [
    {
      points: [
        { x: 21, y: 21 },
        { x: 29, y: 21 },
        { x: 29, y: 24 },
        { x: 21, y: 24 },
      ],
    },
  ]);
  assert.match(pcbSavedZoneDisplayPath(zone), /21 21.*29 21.*29 24.*21 24/);
  assert.deepEqual(parseProject(serializeProject(project)).pcb, board);
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === filename)!.source,
    pcb,
  );
  assert.deepEqual(open(serializePCB(board, project.schematic)).pcb!.zones, board.zones);
  assert.equal(runPCBDesignRules(board).complete, true);
  assert.throws(() => fillCopperZones(board), /unassigned native copper fills requires KiCad/);
  const core = new ProjectCore(project);
  assert.throws(
    () =>
      core.execute('layout.track.properties', {
        boardId: board.id,
        trackId: board.tracks[0].id,
        width: 0.3,
      }),
    /unassigned native copper fills require native Source/,
  );
  assert.deepEqual(core.getSnapshot().project!.pcb!.zones, board.zones);
});

test('native polygon zone declarations retain unstroked contours and an omitted smoothing radius', () => {
  const native = source
    .replace('(min_thickness 0.25)', '(min_thickness 0.25) (filled_areas_thickness no)')
    .replace('(thermal_bridge_width 0.3))', '(thermal_bridge_width 0.3) (smoothing chamfer))');
  const project = open(native);
  const board = project.pcb!;
  for (const zone of board.zones) assert.deepEqual(zone.cornerSmoothing, { style: 'chamfer' });
  const tree = projectNativeFiles({ ...project, pcb: { ...board, thickness: 1.7 } });
  const text = tree.files.find(({ name }) => name === filename)!.source;
  for (const zone of children(parseSExpr(text), 'zone')) {
    assert.deepEqual(child(zone, 'filled_areas_thickness'), ['filled_areas_thickness', 'no']);
    assert.deepEqual(child(child(zone, 'fill')!, 'smoothing'), ['smoothing', 'chamfer']);
    assert.equal(child(child(zone, 'fill')!, 'radius'), undefined);
  }
  assert.deepEqual(open(text).pcb!.zones, board.zones);
  assert.throws(
    () => open(native.replace('filled_areas_thickness no', 'filled_areas_thickness yes')),
    /Only unstroked native zone contours/,
  );
});

test('empty zones with no area and circular rule areas retain their native records', () => {
  const polygon = '(polygon (pts (xy 20 20) (xy 30 20) (xy 30 25) (xy 20 25)))';
  const empty = source.replace(polygon, '').replace('(layers "*.Cu")', '(layer "F.Cu")');
  const emptyProject = open(empty);
  const emptyBoard = emptyProject.pcb!;
  assert.deepEqual(emptyBoard.zones[0].outline, []);
  assert.deepEqual(worldZones(emptyBoard), []);
  assert.throws(() => fillCopperZone(emptyBoard, zoneId), /needs an outline/);
  assert.deepEqual(
    open(serializePCB(emptyBoard, emptyProject.schematic)).pcb!.zones,
    emptyBoard.zones,
  );

  const circle = source
    .replace('(zone (net "GND") (layers "*.Cu")', '(zone (layers "F.Cu" "B.Cu")')
    .replace(
      polygon,
      `(keepout (copperpour not_allowed))
      (polygon (pts (arc (start 30 25) (mid 20 25) (end 30 25))))`,
    );
  const circleProject = open(circle);
  const circleBoard = circleProject.pcb!;
  for (const zone of circleBoard.zones) {
    assert.equal(zone.nativeCircularOutline, true);
    assert.deepEqual(zone.outline, [
      { x: 30, y: 25 },
      { x: 20, y: 25 },
    ]);
    assert.equal(pcbZoneOutlineDisplayPath(zone), 'M 30 25 A 5 5 0 1 0 20 25 A 5 5 0 1 0 30 25 Z');
  }
  const selection = { kind: 'zone', id: zoneId };
  assert.ok(
    selectPCBPoint(
      circleBoard,
      defaultPCBDisplay(),
      defaultPCBSelectionFilters(),
      { x: 25, y: 20 },
      0.01,
    ).some((candidate) => candidate.kind === selection.kind && candidate.id === selection.id),
  );
  const edited = { ...circleProject, pcb: { ...circleBoard, thickness: 1.7 } };
  const saved = projectNativeFiles(edited).files.find(({ name }) => name === filename)!.source;
  assert.deepEqual(open(saved).pcb!.zones, circleBoard.zones);
  assert.throws(() => fillCopperZones(circleBoard), /native curved rule areas/);
  assert.throws(
    () => open(circle.replace('(mid 20 25)', '(mid 30 25)')),
    /Invalid complete circular/,
  );

  const mixed = circle.replace(
    '(arc (start 30 25) (mid 20 25) (end 30 25))',
    '(xy 20 20) (xy 30 20) (arc (start 30 25) (mid 25 30) (end 20 25))',
  );
  const mixedProject = open(mixed);
  const mixedBoard = mixedProject.pcb!;
  assert.deepEqual(mixedBoard.zones[0].nativeOutlineArcs, [{ vertex: 2, mid: { x: 25, y: 30 } }]);
  assert.equal(
    pcbZoneOutlineDisplayPath(mixedBoard.zones[0]),
    'M 20 20 L 30 20 L 30 25 A 5 5 0 0 1 20 25 Z',
  );
  const mixedSaved = projectNativeFiles({
    ...mixedProject,
    pcb: { ...mixedBoard, thickness: 1.7 },
  }).files.find(({ name }) => name === filename)!.source;
  assert.deepEqual(open(mixedSaved).pcb!.zones, mixedBoard.zones);
});
