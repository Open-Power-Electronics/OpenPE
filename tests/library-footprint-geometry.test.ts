import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit } from '../lib/circuit';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import {
  createEmptyPCB,
  createPCBFootprint,
  flipPCBFootprint,
  readLibraryFootprint,
} from '../lib/pcb-layout';
import { padCopperLayers } from '../lib/pcb-connectivity';
import { padHasMaskOpening } from '../lib/pcb-solder-mask';
import { insidePolygon } from '../lib/pcb-collision';
import { setPCBPadProperties } from '../lib/pcb-properties';
import { pcbFootprintTextRotation } from '../lib/pcb-display';
import { createProject, validateProject } from '../lib/project';
import { child, children, parseSExpr, val } from '../lib/sexpr';

// Original parser fixtures, rather than redistributed vendor library assets.
const circle = `(fp_circle (center -1.905 4.0145) (end -1.905 3.8145)
  (stroke (width 0) (type default)) (fill solid) (layer "F.SilkS")
  (uuid "8ed971fa-96c7-4564-8828-a83e95235ddf"))`;
const outline = `(fp_circle (center 2.123456 -1) (end 3.123456 -1)
  (stroke (width 0.000001) (type solid)) (fill none) (layer "B.Fab"))`;
const arc = `(fp_arc (start -3 -2) (mid -2.123456 -3.234567) (end -1 -2)
  (stroke (width 0.123456) (type default)) (layer "F.Fab"))`;
const polygon = `(fp_poly (pts (xy -2 -1) (xy 2 -1) (xy 1.234567 2) (xy -2 1))
  (stroke (width 0) (type solid)) (fill yes) (layer "F.SilkS"))`;
const unfilled = `(fp_poly (pts (xy -2.449 1.95) (xy 2.449 1.95) (xy 2.45 1.949)
  (xy 2.45 -1.949) (xy -2.45 -1.949) (xy -2.45 1.949))
  (stroke (width 0.12) (type default)) (fill none) (layer "F.Fab"))`;
const attributes = `(thermal_bridge_angle 45) (solder_mask_margin 0.025)
  (solder_paste_margin -0.012345) (solder_paste_margin_ratio -0.1) (zone_connect 2)`;
const source = (
  graphics = [circle, outline, arc, polygon, unfilled].join('\n'),
  padAttributes = attributes,
) =>
  `(footprint "NativeArtwork" (version 20240108) (generator "test") (layer "F.Cu")
    (uuid "0eb98be6-060f-4f58-a6cd-7d380035565c")
    ${graphics}
    (pad "1" smd oval (at -1.905 2.682) (size 0.63 1.865)
      (layers "F.Cu" "F.Paste" "F.Mask") ${padAttributes}
      (uuid "cf233ea8-d635-47c0-bf9c-fb0d3e827e55"))
    (pad "2" smd rect (at 1.905 -2.682 30) (size 0.63 1.865)
      (layers "F.Cu" "F.Paste" "F.Mask")))`;

function fixture(text = source()) {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 12.7, 12.7);
  circuit.parts.push(part);
  const detail = { id: 'Test:NativeArtwork', footprint: parseSExpr(text) };
  const footprint = createPCBFootprint(detail, circuit, part.id, { x: 25.4, y: 25.4 });
  const project = createProject(circuit);
  project.pcb = { ...createEmptyPCB(), footprints: [footprint] };
  validateProject(project);
  return { circuit, part, detail, footprint, project };
}

test('mask and paste apertures retain native geometry through linked placement, flip and reopen', () => {
  const withApertures = (front: string) =>
    source(
      `(pad "" smd roundrect (at 4 2 37) (size 1.25 2.5) (layers ${front})
        (roundrect_rratio 0.22) (solder_paste_margin -0.125))
       (pad "" smd circle (at 4 -2) (size 0.8 0.8) (layers "B.Paste"))
       (pad "" smd rect (at 3 -2) (size 0.9 0.75) (layers "F.Mask" "F.Paste"))`,
    );
  const { footprint, project } = fixture(withApertures('"F.Paste"'));
  const [front, back, mask] = footprint.pads;
  assert.equal(front.number, '');
  assert.deepEqual(front.layers, ['F.Paste']);
  assert.equal(front.rotation, 37);
  assert.equal(front.roundrectRatio, 0.22);
  assert.deepEqual(front.size, { x: 1.25, y: 2.5 });
  assert.deepEqual(back.layers, ['B.Paste']);
  assert.deepEqual(mask.layers, ['F.Mask', 'F.Paste']);
  for (const aperture of [front, back, mask]) {
    assert.equal(aperture.netId, null);
    assert.deepEqual(padCopperLayers(project.pcb!, footprint, aperture), []);
  }
  const flipped = flipPCBFootprint(footprint);
  assert.deepEqual(flipped.pads[0].layers, ['B.Paste']);
  assert.deepEqual(flipped.pads[1].layers, ['F.Paste']);
  assert.deepEqual(flipped.pads[2].layers, ['B.Mask', 'B.Paste']);
  project.pcb!.footprints[0] = flipped;
  const reopened = projectFromNativeFiles(projectNativeFiles(project));
  assert.deepEqual(reopened.pcb!.footprints[0].pads.slice(0, 3), flipped.pads.slice(0, 3));
  const invalid = structuredClone(project);
  const netId = '87a32ef1-8c78-449c-a5ff-959cce19dcaa';
  invalid.pcb!.nets.push({ id: netId, name: 'ApertureNet' });
  invalid.pcb!.footprints[0].pads[0].netId = netId;
  assert.throws(() => validateProject(invalid), /apertures cannot carry a net/);
  for (const layers of ['"F.Paste" "B.Paste"', '"F.Mask" "B.Paste"'])
    assert.throws(() => fixture(withApertures(layers)), /Custom pad layer sets are not supported/);
});

test('catalog copper with an empty pad number remains unassigned through linked placement and reopen', () => {
  const blank = '(pad "" smd rect (at 4 2) (size 2 1) (layers "F.Cu" "F.Mask"))';
  const { footprint, project, circuit, part } = fixture(source(blank));
  const reopened = projectFromNativeFiles(projectNativeFiles(project));
  for (const owner of [footprint, reopened.pcb!.footprints[0]]) {
    const [pad] = owner.pads;
    assert.equal(pad.number, '');
    assert.equal(pad.netId, null);
    assert.equal(pad.unconnected, true);
    assert.deepEqual(padCopperLayers(project.pcb!, owner, pad), ['F.Cu']);
  }
  const detail = {
    id: 'Test:NativeArtwork',
    footprint: parseSExpr(`(footprint "NativeArtwork" (layer "F.Cu") ${blank})`),
  };
  assert.equal(readLibraryFootprint(detail).pads.length, 1);
  assert.throws(
    () => createPCBFootprint(detail, circuit, part.id, { x: 0, y: 0 }),
    /footprint with numbered electrical pads/,
  );
  assert.throws(() => fixture(source(blank.replace('pad ""', 'pad "  "'))), /only whitespace/);
});

test('plated holes retain a one-sided mask opening and mirror it on a footprint flip', () => {
  const { footprint, project } = fixture(
    source(`
    (pad "1" thru_hole circle (at 3 0) (size 1.2 1.2) (drill 0.6) (layers "*.Cu" "F.Mask"))
    (pad "" np_thru_hole circle (at 4 0) (size 0.8 0.8) (drill 0.8) (layers "*.Cu" "*.Mask"))`),
  );
  const [plated, mechanical] = footprint.pads;
  assert.equal(padHasMaskOpening(footprint, plated, 'front'), true);
  assert.equal(padHasMaskOpening(footprint, plated, 'back'), false);
  assert.deepEqual(padCopperLayers(project.pcb!, footprint, plated), ['F.Cu', 'B.Cu']);
  assert.deepEqual(padCopperLayers(project.pcb!, footprint, mechanical), []);
  const flipped = flipPCBFootprint(footprint);
  project.pcb!.footprints[0] = flipped;
  const reopened = projectFromNativeFiles(projectNativeFiles(project)).pcb!.footprints[0];
  assert.deepEqual(reopened.pads[0].layers, ['*.Cu', 'B.Mask']);
  assert.equal(padHasMaskOpening(reopened, reopened.pads[0], 'front'), false);
  assert.equal(padHasMaskOpening(reopened, reopened.pads[0], 'back'), true);
});

test('abutting custom pad rectangles preserve their exact union with the native anchor', () => {
  const withRectangles = (secondLeft: string) =>
    source(`
    (pad "1" smd custom (at 4 2) (size 2 2) (layers "F.Cu" "F.Mask")
      (options (clearance outline) (anchor rect))
      (primitives
        (gr_poly (pts (xy 1 -0.8) (xy 2.000001 -0.8) (xy 2.000001 -0.2) (xy 1 -0.2)) (width 0) (fill yes))
        (gr_poly (pts (xy ${secondLeft} 0.2) (xy 2 0.2) (xy 2 0.8) (xy ${secondLeft} 0.8)) (width 0) (fill yes))))`);
  const { footprint, project } = fixture(withRectangles('1'));
  const [pad] = footprint.pads;
  const outline = { outer: pad.outline!, holes: [] };
  assert.equal(Math.max(...outline.outer.map(({ x }) => x)), 2.000001);
  assert.equal(insidePolygon({ x: 1.5, y: -0.5 }, outline), true);
  assert.equal(insidePolygon({ x: 1.5, y: 0.5 }, outline), true);
  assert.equal(insidePolygon({ x: 1.5, y: 0 }, outline), false);
  const reopened = projectFromNativeFiles(projectNativeFiles(project)).pcb!.footprints[0];
  assert.deepEqual(reopened.pads[0].outline, pad.outline);
  assert.throws(() => fixture(withRectangles('1.5')), /single outline without holes/);
});

test('placement and native pad edits preserve the exact heatsink fabrication property', () => {
  const heatsink = '(property pad_prop_heatsink)';
  const { footprint, project } = fixture(source(circle, heatsink));
  const [pad] = footprint.pads;
  assert.equal(pad.heatsink, true);
  const native = projectNativeFiles(project);
  const board = native.files.find(({ name }) => name.endsWith('.kicad_pcb'))!;
  assert.ok(board.source.includes(heatsink));
  const reopened = projectFromNativeFiles(native);
  assert.equal(reopened.pcb!.footprints[0].pads[0].heatsink, true);
  reopened.pcb = setPCBPadProperties(reopened.pcb!, pad.id, { x: pad.x + 0.1 });
  const edited = projectNativeFiles(reopened);
  const editedBoard = edited.files.find(({ name }) => name.endsWith('.kicad_pcb'))!;
  assert.ok(editedBoard.source.includes(heatsink));
  assert.equal(projectFromNativeFiles(edited).pcb!.footprints[0].pads[0].heatsink, true);
  assert.throws(
    () => fixture(source(circle, '(property pad_prop_castellated)')),
    /fabrication property/,
  );
  assert.throws(() => fixture(source(circle, `${heatsink} ${heatsink}`)), /repeats property/);
});

test('library placement retains package-level mask and paste margins through native Save and reopen', () => {
  const withMargins = (settings: string) =>
    source().replace('(layer "F.Cu")', `(layer "F.Cu") ${settings}`);
  const native =
    '(solder_mask_margin 0.0625) (solder_paste_margin -0.02) (solder_paste_margin_ratio 0)';
  const { footprint, project } = fixture(withMargins(native));
  const nativeFiles = projectNativeFiles(project);
  const reopened = projectFromNativeFiles(nativeFiles).pcb!.footprints[0];
  for (const item of [footprint, reopened]) {
    assert.equal(item.solderMaskMargin, 0.0625);
    assert.equal(item.solderPasteMargin, -0.02);
    assert.equal(item.solderPasteMarginRatio, 0);
    assert.equal(item.pads[0].solderMaskMargin, 0.025);
  }
  const board = nativeFiles.files.find(({ name }) => name.endsWith('.kicad_pcb'))!;
  const placed = child(parseSExpr(board.source), 'footprint')!;
  for (const key of ['solder_mask_margin', 'solder_paste_margin', 'solder_paste_margin_ratio'])
    assert.ok(child(placed, key));
  assert.throws(
    () => fixture(withMargins('(solder_mask_margin 0) (solder_mask_margin 0.02)')),
    /repeats solder_mask_margin/,
  );
  assert.throws(
    () => fixture(withMargins('(solder_paste_margin 0.001 0.002)')),
    /unsupported coordinates or dimensions/,
  );
});

test('custom circular anchors retain their native shape, contained outline and diameter', () => {
  const packageWithAnchor = (size: string, vertices: string) =>
    `(footprint "NativeArtwork" (version 20240108) (layer "F.Cu")
      (pad "1" smd custom (at 0 0) (size ${size}) (layers "F.Cu" "F.Paste" "F.Mask")
        (options (clearance outline) (anchor circle))
        (primitives (gr_poly (pts ${vertices}) (width 0) (fill yes)))))`;
  const diamond = '(xy -0.8 0) (xy 0 -0.8) (xy 0.8 0) (xy 0 0.8)';
  const { footprint, project } = fixture(packageWithAnchor('1 1', diamond));
  const pad = footprint.pads[0];
  assert.equal(pad.customAnchor, 'circle');
  assert.deepEqual(pad.outline, [
    { x: -0.8, y: 0 },
    { x: 0, y: -0.8 },
    { x: 0.8, y: 0 },
    { x: 0, y: 0.8 },
  ]);
  project.pcb = setPCBPadProperties(project.pcb!, pad.id, { size: { x: 0.9, y: 1 } });
  validateProject(project);
  const files = projectNativeFiles(project);
  assert.match(
    files.files.find(({ name }) => name.endsWith('.kicad_pcb'))!.source,
    /\(anchor circle\)/,
  );
  const restored = projectFromNativeFiles(files).pcb!.footprints[0].pads[0];
  assert.deepEqual(restored.size, { x: 0.9, y: 0.9 });
  assert.deepEqual(restored.outline, pad.outline);
  assert.equal(restored.customAnchor, 'circle');

  const edge = '(xy -1 -1) (xy 1 -1) (xy 1 0) (xy -1 0)';
  assert.doesNotThrow(() => fixture(packageWithAnchor('0.000001 0.000001', edge)));
  assert.throws(() => fixture(packageWithAnchor('0.1 0.1', edge)), /enclose its circular anchor/);
  assert.throws(() => fixture(packageWithAnchor('0.9 1', diamond)), /equal dimensions/);
  assert.throws(
    () => fixture(packageWithAnchor('1.2 1.2', diamond)),
    /enclose its circular anchor/,
  );
});

test('filled catalog rectangles retain exact corners and technical-layer artwork through Save', () => {
  const rect =
    '(fp_rect (start 1 2) (end 4 6) (layer "F.Paste") (stroke (width 0) (type solid)) (fill solid))';
  const drawing =
    '(fp_line (start 0 0) (end 1 1) (layer "Dwgs.User") (stroke (width 0.1) (type solid)))';
  const label = '(fp_text user "K" (at 0 0) (layer "Cmts.User") (effects (font (size 1 1))))';
  const { footprint, project } = fixture(source([rect, drawing, label].join(' ')));
  const [region, line, text] = footprint.graphics;
  assert.deepEqual(
    [region.kind, region.start, region.points, region.end, region.fill, region.width],
    [
      'polygon',
      { x: 1, y: 2 },
      [
        { x: 4, y: 2 },
        { x: 4, y: 6 },
      ],
      { x: 1, y: 6 },
      true,
      0,
    ],
  );
  assert.deepEqual([region.layer, line.layer, text.layer], ['F.Paste', 'Dwgs.User', 'Cmts.User']);
  const reopened = projectFromNativeFiles(projectNativeFiles(project)).pcb!.footprints[0];
  assert.deepEqual(reopened.graphics[0], region);
  assert.deepEqual(
    reopened.graphics.slice(1, 3).map(({ layer }) => layer),
    ['Dwgs.User', 'Cmts.User'],
  );
  assert.throws(() => fixture(source(rect.replace('(end 4 6)', '(end 1 6)'))), /positive area/);
  assert.throws(() => fixture(source(rect.replace('F.Paste', 'Edge.Cuts'))), /unfilled contour/);
  assert.throws(
    () => fixture(source(rect.replace('(width 0)', '(width 0.1)'))),
    /without a stroke/,
  );
});

test('native pad corner and paste ratios keep their dimensionless precision through Save and reopen', () => {
  const rounded = '0.1388888888888889';
  const chamfer = '0.2173913043478261';
  const paste = '-0.00000001000001';
  const text = source()
    .replace('(solder_paste_margin_ratio -0.1)', `(solder_paste_margin_ratio ${paste})`)
    .replace('"1" smd oval', '"1" smd roundrect')
    .replace(
      '(size 0.63 1.865)',
      `(size 0.63 1.865) (roundrect_rratio ${rounded}) (chamfer_ratio ${chamfer}) (chamfer top_left)`,
    );
  const { project, footprint } = fixture(text);
  const reopened = projectFromNativeFiles(projectNativeFiles(project)).pcb!.footprints[0];
  for (const {
    pads: [pad],
  } of [footprint, reopened]) {
    assert.equal(pad.roundrectRatio, Number(rounded));
    assert.equal(pad.chamferRatio, Number(chamfer));
    assert.equal(pad.solderPasteMarginRatio, Number(paste));
  }
});

test('library placement retains exact circles, arc anchors, polygon vertices, fills and pad settings', () => {
  const { footprint } = fixture();
  assert.equal(footprint.graphics.length, 7);
  const artwork = footprint.graphics.filter((graphic) => graphic.kind !== 'text');
  assert.deepEqual(
    artwork.map(({ id: _id, ...graphic }) => graphic),
    [
      {
        kind: 'circle',
        start: { x: -1.905, y: 4.0145 },
        end: { x: -1.905, y: 3.8145 },
        width: 0,
        layer: 'F.SilkS',
        stroke: 'default',
        fill: true,
      },
      {
        kind: 'circle',
        start: { x: 2.123456, y: -1 },
        end: { x: 3.123456, y: -1 },
        width: 0.000001,
        layer: 'B.Fab',
        stroke: 'solid',
        fill: false,
      },
      {
        kind: 'arc',
        start: { x: -3, y: -2 },
        mid: { x: -2.123456, y: -3.234567 },
        end: { x: -1, y: -2 },
        width: 0.123456,
        layer: 'F.Fab',
        stroke: 'default',
      },
      {
        kind: 'polygon',
        start: { x: -2, y: -1 },
        points: [
          { x: 2, y: -1 },
          { x: 1.234567, y: 2 },
        ],
        end: { x: -2, y: 1 },
        width: 0,
        layer: 'F.SilkS',
        stroke: 'solid',
        fill: true,
      },
      {
        kind: 'polygon',
        start: { x: -2.449, y: 1.95 },
        points: [
          { x: 2.449, y: 1.95 },
          { x: 2.45, y: 1.949 },
          { x: 2.45, y: -1.949 },
          { x: -2.45, y: -1.949 },
        ],
        end: { x: -2.45, y: 1.949 },
        width: 0.12,
        layer: 'F.Fab',
        stroke: 'default',
        fill: false,
      },
    ],
  );
  const {
    thermalBridgeAngle,
    solderMaskMargin,
    solderPasteMargin,
    solderPasteMarginRatio,
    zoneConnect,
  } = footprint.pads[0];
  assert.deepEqual(
    {
      thermalBridgeAngle,
      solderMaskMargin,
      solderPasteMargin,
      solderPasteMarginRatio,
      zoneConnect,
    },
    {
      thermalBridgeAngle: 45,
      solderMaskMargin: 0.025,
      solderPasteMargin: -0.012345,
      solderPasteMarginRatio: -0.1,
      zoneConnect: 2,
    },
  );
  assert.equal(footprint.pads[1].thermalBridgeAngle, undefined);
  assert.ok(footprint.pads.every((pad) => pad.netId === null));
});

test('new native library artwork and pad settings survive Save and reopening without approximations', () => {
  const { project, footprint } = fixture();
  const files = projectNativeFiles(project, 'artwork.kicad_pro');
  const board = parseSExpr(files.files.find((file) => file.name === 'artwork.kicad_pcb')!.source);
  const native = children(board, 'footprint')[0];
  assert.equal(children(native, 'fp_circle').length, 2);
  assert.equal(children(native, 'fp_arc').length, 1);
  assert.equal(children(native, 'fp_poly').length, 2);
  assert.equal(children(native, 'fp_line').length, 0);
  assert.equal(val(child(children(native, 'pad')[0], 'thermal_bridge_angle')), '45');
  const reopened = projectFromNativeFiles(files);
  assert.deepEqual(reopened.pcb!.footprints[0].graphics, footprint.graphics);
  assert.deepEqual(
    reopened.pcb!.footprints[0].pads.map(({ layers: _layers, ...pad }) => pad),
    footprint.pads,
  );
  assert.deepEqual(projectNativeFiles(reopened, files.entry), files);
});

test('each placement owns fresh UUIDs and independent geometry without changing the library source', () => {
  const { detail, circuit, part, footprint } = fixture();
  const unchanged = structuredClone(detail);
  const another = createPCBFootprint(detail, circuit, part.id, { x: 0, y: 0 });
  const identities = (placed: typeof footprint) => [
    placed.id,
    ...placed.pads.map((pad) => pad.id),
    ...placed.graphics.map((graphic) => graphic.id),
  ];
  const all = [...identities(footprint), ...identities(another)];
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.every((id) => !JSON.stringify(detail).includes(id)));
  another.graphics[0].start.x += 1;
  another.graphics.find((graphic) => graphic.kind === 'polygon')!.points![0].x += 1;
  another.pads[0].size.x += 1;
  assert.deepEqual(detail, unchanged);
  assert.equal(footprint.graphics[0].start.x, -1.905);
  assert.equal(footprint.graphics.find((graphic) => graphic.kind === 'polygon')!.points![0].x, 2);
  assert.equal(footprint.pads[0].size.x, 0.63);
});

test('library artwork rejects malformed and unsupported geometry instead of dropping source fields', () => {
  for (const graphic of [
    circle.replace('(center -1.905 4.0145)', '(center -1.905 4.0145 0)'),
    circle.replace('(center -1.905 4.0145)', '(center -1.905 NaN)'),
    circle.replace('(center -1.905 4.0145)', '(center 100000.000001 4.0145)'),
    circle.replace('(end -1.905 3.8145)', '(end -1.905 3.8145001)'),
    circle.replace('(fill solid)', '(fill gradient)'),
    circle.replace('(fill solid)', '(fill "")'),
    circle.replace('(fill solid)', '(fill solid extra)'),
    circle.replace('(fill solid)', '(fill solid) (fill no)'),
    circle.replace('(width 0)', '(width -0.000001)'),
    circle.replace('(width 0)', '(width 1000.000001)'),
    circle.replace('(width 0)', '(width 0 extra)'),
    circle.replace('(type default)', '(type dash)'),
    circle.replace('(type default)', '(type default extra)'),
    circle.replace('(layer "F.SilkS")', '(layer "F.Cu")'),
    circle.replace('(layer "F.SilkS")', '(layer "F.SilkS" extra)'),
    circle.replace('(fill solid)', '(fill solid) locked'),
    circle.replace('(type default)', '(type default) unknown'),
    circle.replace('(fill solid)', '(fill solid) (angle 90)'),
    arc.replace('(mid -2.123456 -3.234567)', ''),
    arc.replace('(mid -2.123456 -3.234567)', '(mid -2.123456 -3.234567 0)'),
    arc.replace('(layer "F.Fab")', '(layer "F.Fab") (fill yes)'),
    polygon.replace('(xy 2 -1) (xy 1.234567 2)', ''),
    polygon.replace('(xy -2 -1)', '(arc (start -2 -1) (end 2 -1))'),
    polygon.replace('(xy -2 -1)', '(xy -2 -1 0)'),
    polygon.replace('(xy -2 -1)', '(xy Infinity -1)'),
  ]) {
    assert.throws(() => fixture(source(graphic)), /Layout:/, graphic);
  }
  const excessive = polygon.replace(
    '(xy -2 -1) (xy 2 -1) (xy 1.234567 2) (xy -2 1)',
    '(xy 0 0) '.repeat(10001),
  );
  assert.throws(() => fixture(source(excessive)), /between 3 and 10000 vertices/);
});

test('library pad settings retain canonical boundary values and reject invalid, repeated or malformed fields', () => {
  const { footprint } = fixture(
    source(
      circle,
      `(thermal_bridge_angle -360) (solder_mask_margin -100000)
    (solder_paste_margin 100000) (solder_paste_margin_ratio 1) (zone_connect 0)`,
    ),
  );
  assert.equal(footprint.pads[0].thermalBridgeAngle, -360);
  assert.equal(footprint.pads[0].solderMaskMargin, -100000);
  assert.equal(footprint.pads[0].solderPasteMargin, 100000);
  assert.equal(footprint.pads[0].solderPasteMarginRatio, 1);
  assert.equal(footprint.pads[0].zoneConnect, 0);
  for (const invalid of [
    '(thermal_bridge_angle -360.000001)',
    '(thermal_bridge_angle 360.000001)',
    '(thermal_bridge_angle NaN)',
    '(thermal_bridge_angle 45 90)',
    '(thermal_bridge_angle 45) (thermal_bridge_angle 90)',
    '(solder_mask_margin -100000.000001)',
    '(solder_paste_margin 100000.000001)',
    '(solder_paste_margin_ratio -1.000001)',
    '(solder_paste_margin_ratio 1.000001)',
    '(zone_connect -1)',
    '(zone_connect 4)',
    '(zone_connect 1.5)',
    '(zone_connect (value 2))',
  ])
    assert.throws(() => fixture(source(circle, invalid)), /Layout:/, invalid);
});

test('native KiCad 6 vendor artwork retains width records and user polarity text through Save', () => {
  const text = source(
    `(fp_text user "K" (at 0 -1.8 30) (layer "F.SilkS")
      (effects (font (size 1 0.8) (thickness 0.15) bold italic) (justify left top))
      (tstamp "cb41aad9-a3b5-44b7-b9ea-925af42f0e37"))
    (fp_text user "K" (at 0 -1.8) (layer "F.Fab") hide
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text user "\${REFERENCE}" (at 4.11 0) (layer "F.Fab")
      (effects (font (size 0.8 0.8) (thickness 0.12))))
    (fp_line (start 5.93 -1.12) (end 1.69 -1.12) (layer "F.SilkS") (width 0.12)
      (tstamp "f64d6c89-dfe1-4815-a8ce-60ab3646fc1f"))`,
    '',
  ).replace('(version 20240108)', '(version 20211014) (tedit 5AE50CD5)');
  const { project, footprint } = fixture(text);
  const [silk, fab, reference, line] = footprint.graphics;
  assert.deepEqual(silk.start, { x: 0, y: -1.8 });
  assert.deepEqual(silk.text, {
    value: 'K',
    rotation: 30,
    size: { x: 1, y: 0.8 },
    thickness: 0.15,
    justify: ['left', 'top'],
    bold: true,
    italic: true,
  });
  assert.equal(fab.text?.hidden, true);
  assert.equal(reference.text?.value, '${REFERENCE}');
  assert.deepEqual(reference.start, { x: 4.11, y: 0 });
  assert.equal(line.kind, undefined);
  assert.equal(line.width, 0.12);
  assert.deepEqual(line.start, { x: 5.93, y: -1.12 });
  assert.deepEqual(line.end, { x: 1.69, y: -1.12 });
  const files = projectNativeFiles(project, 'vendor.kicad_pro');
  const reopened = projectFromNativeFiles(files);
  assert.deepEqual(
    reopened.pcb!.footprints[0].graphics.slice(0, 3),
    footprint.graphics.slice(0, 3),
  );
  const { stroke, ...restoredLine } = reopened.pcb!.footprints[0].graphics[3];
  assert.equal(stroke, 'default');
  assert.deepEqual(restoredLine, line);
  assert.deepEqual(projectNativeFiles(reopened, files.entry), files);
});

test('free footprint text orientation survives placement, rotation and native reopen', () => {
  const text = '(fp_text user "PIN 1" (at 1 2 30) (layer "F.SilkS") (effects (font (size 1 1))))';
  const modern = text.replace('(at 1 2 30)', '(at 1 2 30) (unlocked yes)');
  const legacy = text.replace('(at 1 2 30)', '(at 1 2 30 unlocked)');
  for (const native of [modern, legacy]) {
    const { footprint, project } = fixture(source(native));
    const graphic = footprint.graphics[0];
    assert.equal(graphic.keepUpright, false);
    assert.equal(graphic.locked, undefined);
    footprint.rotation = 180;
    const files = projectNativeFiles(project);
    const board = files.files.find(({ name }) => name.endsWith('.kicad_pcb'))!;
    assert.match(board.source, /\(at 1 2 210\) \(unlocked yes\)/);
    const reopened = projectFromNativeFiles(files);
    const next = reopened.pcb!.footprints[0].graphics[0];
    assert.equal(next.keepUpright, false);
    assert.equal(pcbFootprintTextRotation(next.text!.rotation, 180, next.keepUpright), 30);
    assert.equal(pcbFootprintTextRotation(next.text!.rotation, 180), -150);
    delete next.keepUpright;
    assert.equal(
      projectFromNativeFiles(projectNativeFiles(reopened)).pcb!.footprints[0].graphics[0]
        .keepUpright,
      undefined,
    );
  }
  assert.throws(
    () => fixture(source(modern.replace('unlocked yes', 'unlocked other'))),
    /orientation/,
  );
  assert.throws(
    () => fixture(source(legacy.replace('(layer', '(unlocked no) (layer'))),
    /orientation/,
  );
});

test('native text and width syntax rejects unsupported or ambiguous source content', () => {
  const label = `(fp_text user "K" (at 0 -1.8 30) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15))))`;
  for (const graphic of [
    label.replace('(at 0 -1.8 30)', '(at 0 -1.8 30 40)'),
    label.replace('(size 1 1)', '(size 0 1)'),
    label.replace('(size 1 1)', '(size 1 1000.000001)'),
    label.replace('(thickness 0.15)', '(thickness -0.1)'),
    label.replace('(thickness 0.15)', '(thickness 0.15 1)'),
    label.replace('(thickness 0.15)', '(thickness 0.15) (face "Unsupported")'),
    label.replace('(thickness 0.15)', '(thickness 0.15) (bold yes) bold'),
    label.replace('(thickness 0.15)', '(thickness 0.15) (italic maybe)'),
    label.replace('(font', '(justify left right top bottom) (font'),
    label.replace('(font', '(justify left left) (font'),
    label.replace('(font', '(justify center) (font'),
    label.replace('(layer "F.SilkS")', '(layer "F.Cu")'),
    label.replace('(layer "F.SilkS")', '(layer "F.SilkS") locked'),
    label.replace('(layer "F.SilkS")', '(layer "F.SilkS") (hide yes no)'),
    label
      .replace('(font', '(hide yes no) (font')
      .replace('(layer "F.SilkS")', '(layer "F.SilkS") hide'),
    label.replace('"K"', '"' + 'K'.repeat(4097) + '"'),
  ])
    assert.throws(() => fixture(source(graphic)), /Layout:/, graphic);
  const nativeLine = '(fp_line (start 0 0) (end 1 1) (width 0.12) (layer "F.SilkS"))';
  assert.equal(
    fixture(source(nativeLine).replace('(version 20240108)', '(version 20210108)')).footprint
      .graphics[0].width,
    0.12,
  );
  assert.throws(() => fixture(source(nativeLine)), /native width field/);
  for (const line of [
    nativeLine.replace('(width 0.12)', '(width 0.12 extra)'),
    nativeLine.replace('(width 0.12)', '(width 0.12) (stroke (width 0.12) (type solid))'),
    nativeLine.replace('(width 0.12)', '(width 0.12) (width 0.2)'),
  ])
    assert.throws(
      () => fixture(source(line).replace('(version 20240108)', '(version 20211014)')),
      /Layout:/,
      line,
    );
});
