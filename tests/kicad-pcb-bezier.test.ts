import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PCBGraphic from '../components/PCBGraphic';
import { ProjectCore } from '../core/project-core';
import { prepareFootprintDrawing, readFootprintDrawing } from '../lib/footprint-drawing';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { GerberLayer } from '../lib/manufacturing-gerber';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { exportBoardOutlineDxf } from '../lib/pcb-dxf';
import { pcbGraphicPoints } from '../lib/pcb-geometry';
import { pcbBounds } from '../lib/pcb-layout';
import { boardPolygons } from '../lib/pcb-polygons';
import { defaultPCBSelectionFilters, selectPCBPoint } from '../lib/pcb-selection';
import { child, children, parseSExpr } from '../lib/sexpr';

const name = 'Curves.kicad_pcb';
const points = '(pts (xy 0 0) (xy 0 -8) (xy 20 -8) (xy 20 0))';
const pin = 'c0d625b3-2ca6-44ad-98e6-de2a9ed5b782';
const curve = `(gr_curve ${points} (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "${pin}"))`;
const source = `(kicad_pcb
  (version 20260206) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "f.silkscreen") (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  ${curve}
  (gr_curve (pts (xy 20 0) (xy 20 0) (xy 20 0) (xy 20 0)) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
  (gr_line (start 20 0) (end 20 10) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
  (gr_line (start 20 10) (end 0 10) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
  (gr_line (start 0 10) (end 0 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
  (footprint "Test:CurvedArtwork" (layer "F.Cu") (at 10 5)
    (fp_curve (pts (xy -1 0) (xy -1 2) (xy 1 2) (xy 1 0)) (stroke (width 0.12) (type solid)) (layer "F.SilkS")))
  (group "Cubic" (uuid "da5b84fc-a56b-4b42-80f2-2b537ecd99e0") (members "${pin}"))
)
`;
const open = (boardSource = source) =>
  projectFromNativeFiles({ entry: name, files: [{ name, source: boardSource }] });

test('native board and footprint cubics render and round-trip without flattening control points', () => {
  const project = open();
  const board = project.pcb!;
  const edge = board.graphics.find((g) => g.id === pin)!;
  assert.equal(edge.kind, 'curve');
  assert.deepEqual(edge.points, [
    { x: 0, y: -8 },
    { x: 20, y: -8 },
  ]);
  assert.equal(Math.min(...pcbGraphicPoints(edge).map((p) => p.y)), -6);
  const svg = renderToStaticMarkup(createElement(PCBGraphic, { graphic: edge, color: 'black' }));
  assert.match(svg, /d="M 0 0 C 0 -8 20 -8 20 0"/);
  const [material] = boardPolygons(board);
  assert.equal(Math.min(...material.outer.map((p) => p.y)), -6);
  const pick = (x: number, y: number) =>
    selectPCBPoint(board, defaultPCBDisplay(), defaultPCBSelectionFilters(), { x, y }, 0.01);
  assert.deepEqual(pick(10, -6), [{ kind: 'graphic', id: pin }]);
  assert.deepEqual(pick(10, 0), []);

  const footprint = board.footprints[0];
  const posed = { ...board, graphics: [], footprints: [{ ...footprint, rotation: 45 }] };
  assert.ok(pcbBounds(posed).maxX > footprint.x + 1.2);
  const drawing = readFootprintDrawing(footprint);
  assert.equal(
    prepareFootprintDrawing(board, { footprintId: footprint.id, name: 'CurvedArtwork', drawing })
      .board,
    board,
  );

  const core = new ProjectCore(project);
  const pcbSource = () => core.getNativeFiles().files.find((f) => f.name === name)!.source;
  assert.equal(pcbSource(), source);
  assert.equal(core.replaceBoard({ ...board, thickness: 1.5 }), true);
  const generated = parseSExpr(pcbSource());
  assert.deepEqual(child(children(generated, 'gr_curve')[0], 'pts'), parseSExpr(points));
  assert.deepEqual(
    child(child(generated, 'footprint')!, 'fp_curve')?.[1],
    parseSExpr('(pts (xy -1 0) (xy -1 2) (xy 1 2) (xy 1 0))'),
  );
  assert.deepEqual(open(pcbSource()).pcb!.graphics, board.graphics);
  assert.deepEqual(open(pcbSource()).pcb!.footprints[0].graphics, board.footprints[0].graphics);
  assert.throws(
    () => open(source.replace(points, '(pts (xy 0 0) (xy 20 -8) (xy 20 0))')),
    /four XY points/,
  );
});

test('native cubic edges keep copper editing behind the Source gate', () => {
  const project = open();
  const board = project.pcb!;
  const core = new ProjectCore(project);
  const edge = board.graphics.find((g) => g.id === pin)!;
  assert.throws(
    () => core.replaceBoard({ ...board, graphics: board.graphics.filter((g) => g !== edge) }),
    /Bézier graphics.*native Source/,
  );
});

test('native cubic exports retain curve control points in DXF and chord detail in Gerber', () => {
  const board = open().pcb!;
  const dxf = exportBoardOutlineDxf(board);
  const [, spline, extra] = dxf.split('\r\nSPLINE\r\n');
  assert.equal(extra, undefined);
  assert.match(spline, /AcDbSpline\r\n[\s\S]*?71\r\n3\r\n72\r\n8\r\n73\r\n4\r\n74\r\n0\r\n/);
  const knots = [0, 0, 0, 0, 1, 1, 1, 1].flatMap((knot) => [40, knot]);
  const controls = [
    [0, 0],
    [0, 8],
    [20, 8],
    [20, 0],
  ].flatMap(([x, y]) => [10, x, 20, y, 30, 0]);
  assert.ok(spline.includes([...knots, ...controls].join('\r\n')));
  const layer = new GerberLayer('Profile,NP');
  for (const curve of board.graphics.filter(({ kind }) => kind === 'curve')) layer.graphic(curve);
  const gerber = layer.finish();
  assert.equal((gerber.match(/D02\*/g) ?? []).length, 1);
  assert.match(gerber, /X0Y0D02\*/);
  assert.match(gerber, /X10000000Y6000000D01\*/);
  assert.match(gerber, /X20000000Y0D01\*\nM02\*/);
  assert.ok((gerber.match(/D01\*/g) ?? []).length > 100);
});
