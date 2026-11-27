import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { GerberLayer } from '../lib/manufacturing-gerber';
import { exportProjectFile } from '../lib/manufacturing-export';
import { pcbPadDisplayLayers, pcbPadLabels } from '../lib/pcb-display';
import { padDrillSize, pcbPadMachiningOpening } from '../lib/pcb-drill';
import { nativeCustomPadGraphics } from '../lib/pcb-native-custom-pad';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { pcbPadPath, pcbPadTrapezoid } from '../lib/pcb-geometry';
import { flipPCBFootprint } from '../lib/pcb-layout';
import { padPolygon } from '../lib/pcb-polygons';
import { setPCBPadProperties } from '../lib/pcb-properties';
import { requireSupportedPCBCopper } from '../lib/pcb';
import { child, children, parseSExpr } from '../lib/sexpr';

const filename = 'Pads.kicad_pcb';
const source = (records: string) => `(kicad_pcb (version 20260206) (generator "pcbnew")
 (general (thickness 1.6)) (paper "A4")
 (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)
  (5 "F.SilkS" user) (35 "F.Fab" user) (25 "Edge.Cuts" user))
 (setup (pad_to_mask_clearance 0))
 (footprint "Local:Pads" (layer "F.Cu") (at 10 10)
  (uuid "415342a0-9115-48c4-a2f8-314354159601")
  (property "Reference" "U1" (at 0 -2) (layer "F.SilkS")
   (uuid "42da1d01-58c2-4e10-9083-2303bd1d81bc") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "Pads" (at 0 2) (layer "F.Fab")
   (uuid "0c630bf9-d386-4aea-84b0-86d68be44f47") (effects (font (size 1 1) (thickness 0.15))))
  ${records}))\n`;

function open(boardSource: string) {
  return projectFromNativeFiles({
    entry: filename,
    files: [{ name: filename, source: boardSource }],
  });
}

const trapezoid = `(pad "1" smd trapezoid (at 0 0) (size 2.000003 1.100003)
 (rect_delta 0.500003 0) (layers "F.Cu" "F.Paste" "F.Mask")
 (uuid "14648952-94ea-42ca-88ff-774822dc22cf"))`;

test('native round drill dimensions and offset-only SMD lands retain their geometry', () => {
  const original = source(`(pad "1" thru_hole oval (at 0 0) (size 1.8 2.5)
    (drill 0.8 1.8) (layers "*.Cu" "*.Mask")
    (uuid "14648952-94ea-42ca-88ff-774822dc22cf"))
   (pad "" smd rect (at 3 0) (size 3.8 2.2)
    (drill (offset -0.8 0)) (layers "F.Paste")
    (uuid "9af94c6b-8211-438c-9bb7-a8444b99bbd0"))`);
  const core = new ProjectCore(open(original));
  const pcb = core.getSnapshot().project!.pcb!;
  const [round, aperture] = pcb.footprints[0].pads;
  assert.equal(round.nativeRoundDrillY, 1.8);
  assert.deepEqual(padDrillSize(round), { x: 0.8, y: 0.8 });
  assert.equal(aperture.drill, undefined);
  assert.deepEqual(aperture.drillOffset, { x: 0.8, y: 0 });
  assert.equal(aperture.x, 2.2);
  assert.ok(core.replaceBoard({ ...pcb, thickness: 1.5 }));
  const saved = core.getNativeFiles();
  const written = saved.files.find((file) => file.name === filename)!.source;
  const [roundRecord, apertureRecord] = children(child(parseSExpr(written), 'footprint')!, 'pad');
  assert.deepEqual(child(roundRecord, 'drill'), ['drill', '0.8', '1.8']);
  assert.deepEqual(child(apertureRecord, 'at'), ['at', '3', '0', '0']);
  assert.deepEqual(child(apertureRecord, 'drill'), ['drill', ['offset', '-0.8', '0']]);
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.footprints[0].pads, [round, aperture]);

  const changed = setPCBPadProperties(pcb, round.id, { drill: 0.9 });
  assert.equal(changed.footprints[0].pads[0].nativeRoundDrillY, undefined);
  const moved = setPCBPadProperties(pcb, aperture.id, { x: 2.5 });
  assert.deepEqual(moved.footprints[0].pads[1].drillOffset, { x: 0.8, y: 0 });
});

test('native rounded rectangular pads preserve an omitted default corner ratio', () => {
  const original = source(`(pad "1" smd roundrect (at 0 0) (size 2 1)
    (layers "F.Cu" "F.Paste" "F.Mask") (uuid "14648952-94ea-42ca-88ff-774822dc22cf"))`);
  const core = new ProjectCore(open(original));
  const pcb = core.getSnapshot().project!.pcb!;
  const [pad] = pcb.footprints[0].pads;
  assert.equal(pad.roundrectRatio, 0.25);
  assert.equal(pcbPadPath(pad), pcbPadPath({ ...pad, roundrectRatio: 0.25 }));
  assert.ok(core.replaceBoard({ ...pcb, thickness: 1.5 }));
  const file = () => core.getNativeFiles().files.find(({ name }) => name === filename)!;
  assert.doesNotMatch(file().source, /roundrect_rratio/);
  assert.equal(open(file().source).pcb!.footprints[0].pads[0].roundrectRatio, 0.25);

  const board = core.getSnapshot().project!.pcb!;
  assert.ok(core.replaceBoard(setPCBPadProperties(board, pad.id, { roundrectRatio: 0.35 })));
  assert.match(file().source, /\(roundrect_rratio 0\.35\)/);
  assert.equal(open(file().source).pcb!.footprints[0].pads[0].roundrectRatio, 0.35);
});

test('native placed metadata, test points and castellations survive Layout and a board edit', () => {
  const original = source(`(pad "1" thru_hole rect (at 0 0) (size 2 2) (drill 0.9)
    (property pad_prop_castellated) (layers "*.Cu" "*.Mask")
    (uuid "14648952-94ea-42ca-88ff-774822dc22cf"))
   (pad "2" smd circle (at 3 0) (size 1.27 1.27) (layers "F.Cu" "F.Mask")
    (property pad_prop_testpoint) (uuid "9af94c6b-8211-438c-9bb7-a8444b99bbd0"))`).replace(
    '(footprint "Local:Pads"',
    '(footprint "Local:Pads" (placed yes)',
  );
  const core = new ProjectCore(open(original));
  const board = core.getSnapshot().project!.pcb!;
  const footprint = board.footprints[0];
  assert.deepEqual(
    footprint.pads.map((pad) => pad.fabricationProperty),
    ['pad_prop_castellated', 'pad_prop_testpoint'],
  );
  assert.deepEqual(pcbPadDisplayLayers(board, footprint, footprint.pads[0]), board.layers);
  assert.deepEqual(pcbPadDisplayLayers(board, footprint, footprint.pads[1]), ['F.Cu']);
  assert.equal(core.getNativeFiles().files.find((file) => file.name === filename)!.source, original);
  const rules = runPCBDesignRules(board);
  assert.equal(rules.complete, false);
  assert.ok(!rules.checkedRules.includes('pcb.copper-edge'));
  assert.ok(rules.notes.some((note) => /castellated boards/.test(note)));
  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  const saved = core.getNativeFiles();
  const written = parseSExpr(saved.files.find((file) => file.name === filename)!.source);
  assert.deepEqual(child(child(written, 'footprint')!, 'placed'), ['placed', 'yes']);
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.footprints[0].pads, footprint.pads);
  assert.throws(
    () => open(original.replace('(placed yes)', '(placed maybe)')),
    /footprint placement state/,
  );
});

test('native trapezoid pads share exact corners across Layout, pads, and Gerber', () => {
  const original = source(trapezoid);
  const core = new ProjectCore(open(original));
  const board = core.getSnapshot().project!.pcb!;
  const footprint = board.footprints[0];
  const pad = footprint.pads[0];
  assert.deepEqual(pad.trapezoidDelta, { x: 0.500003, y: 0 });
  assert.deepEqual(pcbPadTrapezoid(pad), [
    { x: -1.000001, y: -0.800002 },
    { x: 1.000001, y: -0.3 },
    { x: 1.000001, y: 0.3 },
    { x: -1.000001, y: 0.800002 },
  ]);
  assert.match(pcbPadPath(pad), /M -1\.000001 -0\.800002 L 1\.000001 -0\.3/);
  assert.deepEqual(padPolygon(footprint, pad).outer[0], { x: 8.999999, y: 9.199998 });
  const gerber = new GerberLayer('Copper,L1,Top');
  gerber.pad(footprint, pad);
  assert.match(gerber.finish(), /G36\*/);
  assert.throws(() => gerber.pad(footprint, pad, 0.1), /zero aperture margin/);

  const changed = setPCBPadProperties(board, pad.id, { trapezoidDelta: { x: 0, y: 0.4 } });
  assert.deepEqual(flipPCBFootprint(changed.footprints[0]).pads[0].trapezoidDelta, {
    x: 0,
    y: -0.4,
  });
  assert.ok(core.replaceBoard(changed));
  assert.deepEqual(
    projectFromNativeFiles(core.getNativeFiles()).pcb!.footprints[0].pads[0],
    changed.footprints[0].pads[0],
  );
  assert.throws(() => open(original.replace('0.500003 0', '4 0')), /convex four-corner shape/);
});

test('native connection-dependent pads preserve end rings and recorded zone flashes with safe operation gates', () => {
  const original = source(`(pad "1" thru_hole rect (at 0 0) (size 2 2) (drill 1)
   (layers "*.Cu" "*.Mask") (remove_unused_layers yes) (keep_end_layers yes)
   (zone_layer_connections "In2.Cu") (uuid "14648952-94ea-42ca-88ff-774822dc22cf"))`);
  const core = new ProjectCore(open(original));
  const snap = core.getSnapshot();
  const board = snap.project!.pcb!;
  const footprint = board.footprints[0];
  const pad = footprint.pads[0];
  assert.deepEqual(pcbPadDisplayLayers(board, footprint, pad), ['F.Cu', 'In2.Cu', 'B.Cu']);
  assert.throws(() => requireSupportedPCBCopper(board, 'Copper refill'), /connection-dependent/);
  assert.throws(
    () => core.replaceBoard({ ...board, footprints: [{ ...footprint, x: footprint.x + 1 }] }),
    /connection-dependent pad copper layers require native Source/,
  );
  assert.equal(core.getSnapshot(), snap);
  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  const saved = core.getNativeFiles();
  assert.match(
    saved.files.find((file) => file.name === filename)!.source,
    /\(zone_layer_connections "In2.Cu"\)/,
  );
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.footprints[0].pads[0], pad);
  assert.throws(
    () =>
      open(original.replace('zone_layer_connections "In2.Cu"', 'zone_layer_connections "In3.Cu"')),
    /active copper layers/,
  );
});

test('native pad number boxes preserve a separate label location and no copper primitive', () => {
  const original = source(`(pad "1" smd custom (at 0 0) (size 1 1) (layers "F.Cu")
   (options (clearance outline) (anchor rect))
   (primitives (gr_bbox (start 2 3) (end 4 5) (fill no)))
   (uuid "14648952-94ea-42ca-88ff-774822dc22cf"))`);
  const core = new ProjectCore(open(original));
  const board = core.getSnapshot().project!.pcb!;
  const pad = board.footprints[0].pads[0];
  assert.deepEqual(nativeCustomPadGraphics(pad), []);
  assert.deepEqual(pcbPadLabels(pad, 0, undefined, { padNumbers: true, padNets: false }).origin, {
    x: 3,
    y: 4,
  });
  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  const reopened = projectFromNativeFiles(core.getNativeFiles()).pcb!.footprints[0].pads[0];
  assert.deepEqual(reopened.nativeCustomPad, pad.nativeCustomPad);
});

test('post-machining and pad-to-die metadata survive Save and gate physical output', () => {
  const original = source(`(pad "1" thru_hole rect (at 0 0) (size 2 2) (drill 1)
   (layers "*.Cu" "*.Mask") (property pad_prop_pressfit)
   (front_post_machining countersink (size 1.4) (angle 82.5))
   (back_post_machining counterbore (size 1.6) (depth 0.4))
   (die_length 2.3) (die_delay 10)
   (uuid "14648952-94ea-42ca-88ff-774822dc22cf"))`);
  const core = new ProjectCore(open(original));
  const project = core.getSnapshot().project!;
  const board = project.pcb!;
  const pad = board.footprints[0].pads[0];
  assert.equal(pcbPadMachiningOpening(pad, 'front'), 1.4);
  assert.equal(pcbPadMachiningOpening(pad, 'back'), 1.6);
  assert.equal(pad.dieLength, 2.3);
  assert.equal(pad.dieDelay, 10);
  assert.throws(() => requireSupportedPCBCopper(board, 'Copper refill'), /machining or press-fit/);
  assert.throws(() => exportProjectFile(project, 'drill', 'Pads'), /machining or press-fit/);
  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  assert.deepEqual(projectFromNativeFiles(core.getNativeFiles()).pcb!.footprints[0].pads[0], pad);
});
