import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { exportProjectFile } from '../lib/manufacturing-export';
import { child, parseSExpr } from '../lib/sexpr';
import { GerberLayer } from '../lib/manufacturing-gerber';
import { pcbCenterMarkStrokes, pcbGraphicPath } from '../lib/pcb-geometry';

const filename = 'Notes.kicad_pcb';
const nativeSource = `(kicad_pcb (version 20260206) (generator "pcbnew")
 (general (thickness 1.6)) (paper "A4")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (35 "F.Fab" user) (25 "Edge.Cuts" user))
 (setup (pad_to_mask_clearance 0))
 (gr_rect (start 0 0) (end 25 25) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts"))
 (gr_text_box "MCU\\nNote" (start 2 4) (end 15 10)
  (margins 0.5 0.6 0.7 0.8) (layer "F.SilkS")
  (uuid "6f60442e-881a-4a43-91e8-c773a48af506")
  (effects (font (size 1.26 1.26) (thickness 0.254) (bold yes)) (justify left top))
  (border no) (stroke (width -0.000001) (type solid)) (knockout yes))
 (footprint "Local:Note" (layer "F.Cu") (at 20 16 90)
  (property "Reference" "N1" (at 0 -2 90) (layer "F.SilkS")
   (uuid "42da1d01-58c2-4e10-9083-2303bd1d81bc") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "Note" (at 0 2 90) (layer "F.Fab")
   (uuid "0c630bf9-d386-4aea-84b0-86d68be44f47") (effects (font (size 1 1) (thickness 0.15))))
  (fp_text_box "Label" (pts (xy 0 0) (xy 4 1) (xy 4 3) (xy 0 2))
   (margins 0.2 0.2 0.2 0.2) (angle 15.5) (layer "F.Fab")
   (effects (font (face "Liberation Sans") (size 1 1) (thickness 0.15)))
   (border yes) (stroke (width 0.1) (type dash)) (knockout no)
   (render_cache "Label" 105.5 (polygon (pts (xy 22 20) (xy 22 21) (xy 21 21)))))))\n`;
const open = (source = nativeSource) =>
  projectFromNativeFiles({ entry: filename, files: [{ name: filename, source }] });

test('native text boxes retain board rectangles and footprint polygon/cache geometry through Save', () => {
  const core = new ProjectCore(open());
  const source = () => core.getNativeFiles().files.find((item) => item.name === filename)!.source;
  const board = core.getSnapshot().project!.pcb!;
  assert.equal(source(), nativeSource);
  const box = board.graphics[1];
  assert.equal(box.text?.knockout, true);
  assert.equal(box.textBox?.strokeWidth, -0.000001);
  assert.deepEqual(box.textBox?.margins, [0.5, 0.6, 0.7, 0.8]);
  const footprintBox = board.footprints[0].graphics.find((graphic) => graphic.textBox)!;
  assert.equal(footprintBox.text?.rotation, 15.5);
  assert.equal(footprintBox.text?.renderCache?.value, 'Label');
  assert.equal(footprintBox.textBox?.outline?.length, 4);
  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  const saved = parseSExpr(source());
  assert.ok(child(saved, 'gr_text_box'));
  assert.ok(child(child(saved, 'footprint')!, 'fp_text_box'));
  const reopened = open(source()).pcb!;
  assert.deepEqual(reopened.graphics[1], box);
  assert.deepEqual(
    reopened.footprints[0].graphics.find((graphic) => graphic.textBox),
    footprintBox,
  );
});

test('native text boxes reject ordinary conflicting edits and plotted text box export', () => {
  const core = new ProjectCore(open());
  const original = core.getSnapshot();
  const board = original.project!.pcb!;
  const footprints = board.footprints.map((footprint) => ({ ...footprint, y: footprint.y + 1 }));
  assert.throws(
    () => core.replaceBoard({ ...board, footprints }),
    /text box requires native Source/,
  );
  assert.equal(core.getSnapshot(), original);
  assert.throws(
    () => exportProjectFile(original.project!, 'gerber', 'Notes'),
    /text boxes on plotted layers/,
  );
  assert.throws(
    () => open(nativeSource.replace('(margins 0.5 0.6 0.7 0.8)', '(margins 0.5)')),
    /four native margins/,
  );
});

test('orthogonal dimension axis and rounded rectangle contour round-trip as native artwork', () => {
  const records = `
 (gr_rect (start 3 12) (end 7 17) (radius 0.5)
  (stroke (width 0.2) (type solid)) (fill yes) (layer "F.Cu"))
 (dimension (type orthogonal) (layer "F.Fab") (pts (xy 10 18) (xy 12 9))
  (height -2) (orientation 1) (format (prefix "") (suffix " mm") (units 3) (units_format 1)
    (precision 4) (suppress_zeroes yes))
  (style (thickness 0.2) (arrow_length 1.27) (text_position_mode 0) (arrow_direction outward)
    (extension_height 0.5) (extension_offset 0.25) (keep_text_aligned yes))
  (gr_text "9 mm" (at 7 14 5.38931176) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15)))))`;
  const core = new ProjectCore(open(nativeSource.trimEnd().slice(0, -1) + records + ')\n'));
  const board = core.getSnapshot().project!.pcb!;
  const rounded = board.graphics[2],
    orthogonal = board.graphics[3];
  assert.equal(rounded.roundedRectRadius, 0.5);
  assert.equal((pcbGraphicPath(rounded).match(/ A /g) ?? []).length, 4);
  assert.equal(orthogonal.dimension?.orientation, 1);
  assert.equal(orthogonal.dimension?.format?.suppressZeroes, true);
  assert.equal(orthogonal.dimension?.caption?.rotation, 5.38931176);
  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  const reopened = projectFromNativeFiles(core.getNativeFiles()).pcb!;
  assert.deepEqual(reopened.graphics.slice(2), [rounded, orthogonal]);
  const gerber = new GerberLayer('Copper,L1,Top');
  gerber.graphic(rounded);
  const gerberSource = gerber.finish();
  assert.equal((gerberSource.match(/G02X/g) ?? []).length, 8);
  assert.match(gerberSource, /G36\*/);
});

test('native center marks retain captionless geometry and the two perpendicular strokes', () => {
  const record = `(dimension (type center) (layer "F.Fab")
    (pts (xy 6 7) (xy 7 5))
    (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0)
      (extension_offset 0.5) (keep_text_aligned yes)))`;
  const core = new ProjectCore(open(nativeSource.trimEnd().slice(0, -1) + record + ')\n'));
  const board = core.getSnapshot().project!.pcb!;
  const mark = board.graphics[2];
  assert.equal(mark.dimension?.type, 'center');
  assert.deepEqual(pcbCenterMarkStrokes(mark), [
    [
      { x: 5, y: 9 },
      { x: 7, y: 5 },
    ],
    [
      { x: 4, y: 6 },
      { x: 8, y: 8 },
    ],
  ]);
  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  const files = core.getNativeFiles();
  const native = parseSExpr(files.files.find((item) => item.name === filename)!.source);
  assert.equal(child(child(native, 'dimension')!, 'format'), undefined);
  assert.equal(child(child(native, 'dimension')!, 'gr_text'), undefined);
  assert.deepEqual(projectFromNativeFiles(files).pcb!.graphics[2], mark);
});
