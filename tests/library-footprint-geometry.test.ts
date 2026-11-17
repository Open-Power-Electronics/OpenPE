import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit } from '../lib/circuit';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { createEmptyPCB, createPCBFootprint } from '../lib/pcb-layout';
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
