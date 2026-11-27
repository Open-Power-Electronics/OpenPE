import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LayoutFootprintGraphic } from '../components/LayoutFootprint';
import { createLayoutSelection } from '../components/LayoutSelection';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { exportProjectFile } from '../lib/manufacturing-export';
import { nativeCustomPadGraphics } from '../lib/pcb-native-custom-pad';
import { defaultPCBDisplay, pcbLayerPaintOrder } from '../lib/pcb-display';
import type { BoardLayer } from '../lib/pcb';
import {
  displayPadPolygons,
  fillCopperZones,
  nativeCustomPadCopperPolygons,
} from '../lib/pcb-polygons';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { child, parseSExpr, val } from '../lib/sexpr';

const name = 'Native.kicad_pcb';
const primitives = `(primitives
 (gr_circle (center 0 -0.25) (end 0.5 -0.25) (width 0) (fill yes))
 (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1) (xy 0 1)) (width 0.1) (fill yes))
 (gr_line (start 0 0) (end -1 0) (width 0.1)))`;
const source = `(kicad_pcb (version 20260206) (generator "pcbnew")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (setup (pad_to_mask_clearance 0))
 (footprint "" (layer "F.Cu") (at 2 3)
  (pad "1" connect custom (at 0 0) (size 0.4 0.7) (layers "F.Cu" "F.Mask")
   (net "Copper") (options (clearance outline) (anchor circle)) ${primitives})))\n`;
const open = (text = source) =>
  projectFromNativeFiles({ entry: name, files: [{ name, source: text }] });

test('retained native connector pad renders primitive copper and reopens without rewriting it', () => {
  const project = open();
  const core = new ProjectCore(project);
  const board = project.pcb!;
  const footprint = board.footprints[0];
  const pad = footprint.pads[0];
  assert.equal(board.thickness, 1.6);
  assert.equal(footprint.libraryId, '');
  assert.equal(footprint.nativeMissingReference, true);
  assert.equal(footprint.nativeMissingValue, true);
  assert.equal(pad.nativeConnect, true);
  assert.deepEqual(pad.nativeCustomPad?.primitives, parseSExpr(primitives).slice(1));
  assert.equal(nativeCustomPadGraphics(pad).length, 3);
  assert.ok(displayPadPolygons(footprint, pad).length);
  const readBoard = () => core.getNativeFiles().files.find((file) => file.name === name)!.source;
  assert.equal(readBoard(), source);
  assert.ok(core.replaceBoard({ ...board, thickness: 1.8 }));
  const savedFootprint = child(parseSExpr(readBoard()), 'footprint')!;
  assert.equal(child(savedFootprint, 'property'), undefined);
  assert.equal(val(child(savedFootprint, 'pad'), 2), 'connect');
  assert.deepEqual(child(child(savedFootprint, 'pad')!, 'primitives'), parseSExpr(primitives));
  assert.deepEqual(projectFromNativeFiles(core.getNativeFiles()).pcb!.footprints[0], footprint);
  const checked = open(
    source.replace(
      ' (setup ',
      ' (segment (start 2.85 4.2) (end 3.15 4.2) (width 0.1) (layer "F.Cu") (net "Other"))\n (setup ',
    ),
  ).pcb!;
  const rules = runPCBDesignRules(checked, { clearance: 0.2 });
  const gap = rules.issues.find((issue) => issue.ruleId === 'pcb.clearance');
  assert.ok(gap);
  assert.ok(gap.objectIds.includes(checked.footprints[0].pads[0].id));
  assert.match(gap.message, /0\.1 mm/);
  assert.throws(() => fillCopperZones(board), /native custom pad primitives/);
  assert.throws(() => core.replaceBoard({ ...board, footprints: [] }), /native Source/);
});

test('native custom pads reject unknown primitive fields before admission', () => {
  assert.throws(
    () => open(source.replace('(width 0) (fill yes)', '(width 0) (fill yes) (unknown 1)')),
    /native custom pad primitive field/,
  );
});

test('native custom pad Gerber exports the anchor and full dark primitive geometry', () => {
  const text = source
    .replace('(2 "B.Cu" signal))', '(2 "B.Cu" signal) (25 "Edge.Cuts" user))')
    .replace(
      '(footprint',
      `(gr_rect (start 0 0) (end 10 10) (stroke (width 0.05) (type default))
        (fill no) (layer "Edge.Cuts")) (footprint`,
    )
    .replace('(layers "F.Cu" "F.Mask")', '(layers "F.Cu" "F.Mask" "F.Paste")');
  const project = open(text);
  const footprint = project.pcb!.footprints[0];
  const [pad] = footprint.pads;
  const copper = nativeCustomPadCopperPolygons(footprint, pad);
  assert.equal(copper.length, 1);
  assert.ok(copper[0].outer.some(({ x, y }) => x < 1 && y > 2.9 && y < 3.1));
  assert.ok(copper[0].outer.some(({ x, y }) => x >= 3 && y >= 4));

  const archive = exportProjectFile(project, 'gerber', name).bytes;
  const output = new TextDecoder().decode(archive);
  assert.match(output, /%TF.FileFunction,Copper,L1,Top\*%/);
  assert.match(output, /%ADD\d+C,0\.4\*%/);
  assert.match(output, /X2000000Y-3000000D03\*/);
  assert.equal(output.match(/X2000000Y-2750000D03\*/g)?.length, 3);
  assert.equal(output.match(/X3000000Y-4000000D01\*/g)?.length, 6);
  assert.equal(output.match(/X1000000Y-3000000D01\*/g)?.length, 3);
  assert.doesNotMatch(output, /%LPC\*%/);
  const repeatedEdge = text.replace('(xy 1 0) (xy 1 1)', '(xy 1 0) (xy 1 1) (xy 1 0) (xy 1 1)');
  assert.deepEqual(exportProjectFile(open(repeatedEdge), 'gerber', name).bytes, archive);
  assert.throws(
    () =>
      exportProjectFile(
        open(text.replace('pad_to_mask_clearance 0', 'pad_to_mask_clearance 0.1')),
        'gerber',
        name,
      ),
    /requires zero mask and paste margins/,
  );
  assert.throws(
    () =>
      exportProjectFile(
        open(text.replace('(xy 1 0) (xy 1 1) (xy 0 1)', '(xy 1 1) (xy 0 1) (xy 1 0)')),
        'gerber',
        name,
      ),
    /non-simple filled polygon/,
  );
  assert.equal(
    new ProjectCore(project).getNativeFiles().files.find((file) => file.name === name)?.source,
    text,
  );
});

test('an empty native custom pad keeps its rectangular copper anchor and Source spelling', () => {
  const text = source
    .replace('(anchor circle)', '(anchor rect)')
    .replace(primitives, '(primitives)');
  const project = open(text);
  const board = project.pcb!;
  const footprint = board.footprints[0];
  const [pad] = footprint.pads;
  assert.deepEqual(pad.nativeCustomPad, { clearance: 'outline', primitives: [] });
  assert.deepEqual(nativeCustomPadGraphics(pad), []);
  const [polygon] = displayPadPolygons(footprint, pad);
  assert.deepEqual(polygon.outer.map(({ x, y }) => `${x},${y}`).sort(), [
    '1.8,2.65',
    '1.8,3.35',
    '2.2,2.65',
    '2.2,3.35',
  ]);
  const core = new ProjectCore(project);
  assert.equal(core.getNativeFiles().files.find((file) => file.name === name)?.source, text);
  assert.ok(core.replaceBoard({ ...board, thickness: 1.8 }));
  const saved = core.getNativeFiles();
  const native = parseSExpr(saved.files.find((file) => file.name === name)!.source);
  const savedPad = child(child(native, 'footprint')!, 'pad')!;
  assert.deepEqual(child(savedPad, 'primitives'), ['primitives']);
  assert.equal(val(child(child(savedPad, 'options')!, 'anchor')), 'rect');
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.footprints[0].pads[0], pad);
});

test('native embedded footprint version and generator fields survive a board transaction', () => {
  const header = '(version 20260206) (generator "pcbnew") (generator_version "10.0")';
  const text = source.replace('(footprint ""', `(footprint "" ${header}`);
  const project = open(text);
  const core = new ProjectCore(project);
  assert.equal(core.getNativeFiles().files.find((file) => file.name === name)?.source, text);
  assert.ok(core.replaceBoard({ ...project.pcb!, thickness: 1.8 }));
  const saved = core.getNativeFiles();
  const native = child(
    parseSExpr(saved.files.find((file) => file.name === name)!.source),
    'footprint',
  )!;
  assert.deepEqual(child(native, 'version'), ['version', '20260206']);
  assert.deepEqual(child(native, 'generator'), ['generator', '"pcbnew"']);
  assert.deepEqual(child(native, 'generator_version'), ['generator_version', '"10.0"']);
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.footprints[0], project.pcb!.footprints[0]);
  assert.throws(
    () => open(text.replace(header, header.replace('20260206', '20990101'))),
    /unsupported native embedded footprint format version/,
  );
});

test('wildcard silkscreen pad membership is native and renders both silk passes', () => {
  const text = `(kicad_pcb (version 20260206) (generator "pcbnew")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (7 "B.SilkS" user)
  (25 "Edge.Cuts" user))
 (setup (pad_to_mask_clearance 0) (pcbplotparams (subtractmaskfromsilk yes)))
 (gr_rect (start 0 0) (end 10 10) (stroke (width 0.05) (type default))
  (fill no) (layer "Edge.Cuts"))
 (footprint "Test:Pad" (layer "F.Cu") (at 4 4)
  (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8)
   (layers "*.Cu" "*.SilkS" "*.Mask"))))\n`;
  const project = open(text);
  const core = new ProjectCore(project);
  const board = project.pcb!;
  const footprint = board.footprints[0];
  const layers = defaultPCBDisplay();
  const render = (onlyLayer: BoardLayer) =>
    renderToStaticMarkup(
      createElement(LayoutFootprintGraphic, {
        copperLayers: board.layers,
        footprint,
        reference: 'J1',
        value: undefined,
        layers,
        selection: createLayoutSelection(),
        placement: false,
        layer: 'F.Cu',
        onlyLayer,
        padLayerOrder: pcbLayerPaintOrder(['F.SilkS', 'B.SilkS', ...board.layers]),
        deferDrills: true,
        netNames: new Map(),
        highlightNets: new Set<string>(),
        inspectedPadId: '',
      }),
    );
  assert.match(render('F.SilkS'), /data-pad-silkscreen="F\.SilkS"[^>]*>[\s\S]*<circle r="0.8"/);
  assert.match(render('B.SilkS'), /data-pad-silkscreen="B\.SilkS"[^>]*>[\s\S]*<circle r="0.8"/);
  assert.doesNotMatch(render('F.SilkS'), /data-pad-label=/);
  assert.match(render('F.Cu'), /data-pad-label="number"/);
  assert.equal(core.getNativeFiles().files.find((file) => file.name === name)?.source, text);
  assert.ok(core.replaceBoard({ ...board, thickness: 1.8 }));
  const reopened = projectFromNativeFiles(core.getNativeFiles());
  assert.deepEqual(reopened.pcb!.footprints[0].pads[0].layers, ['*.Cu', '*.SilkS', '*.Mask']);
  const rules = runPCBDesignRules(board, { scopes: ['silkscreen'], minSilkClearance: 0.15 });
  assert.equal(rules.complete, false);
  assert.ok(rules.issues.some((issue) => issue.message.includes('native pad artwork')));
  assert.throws(
    () => exportProjectFile(project, 'gerber', name),
    /pad silkscreen with solder-mask subtraction/,
  );
});
