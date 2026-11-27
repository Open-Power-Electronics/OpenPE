import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { matchingPCBTextRenderCache } from '../lib/pcb-text';
import { pcbStrokeText } from '../lib/pcb-stroke-text';
import { child, parseSExpr } from '../lib/sexpr';

const filename = 'Text.kicad_pcb';
const board = `(kicad_pcb (version 20260206) (generator "pcbnew")
 (general (thickness 1.6)) (paper "A4") (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (setup (pad_to_mask_clearance 0))
 (gr_text "AB" (at 5 6 0) (layer "F.SilkS")
  (effects (font (face "Liberation Sans") (size 1.3 1.3) (thickness 0.15)))
  (render_cache "AB" 0 (polygon (pts (xy 4.815 6.222) (xy 5.17625 6.123456) (xy 4.977 5.523)))))
 (footprint "Local:Body" (layer "F.Cu") (at 12 10 90)
  (property "Reference" "R1" (at 0 0 90) (layer "F.Fab")
   (effects (font (face "DejaVu Sans Mono") (size 1 1) (thickness 0.15)))
   (render_cache "R1" 90 (polygon (pts (xy 11.6 10) (xy 12.2 10) (xy 12.1 9.7)))))))\n`;
const open = (source = board) =>
  projectFromNativeFiles({ entry: filename, files: [{ name: filename, source }] });

test('native outline text preserves its font, cache key, coordinates and caption through a PCB edit', () => {
  const core = new ProjectCore(open());
  const source = () => core.getNativeFiles().files.find((file) => file.name === filename)!.source;
  const pcb = core.getSnapshot().project!.pcb!;
  const text = pcb.graphics[0].text!;
  assert.equal(source(), board);
  assert.equal(text.fontFace, 'Liberation Sans');
  assert.deepEqual(matchingPCBTextRenderCache(text, 0), [
    '4.815,6.222 5.17625,6.123456 4.977,5.523',
  ]);
  assert.equal(matchingPCBTextRenderCache({ ...text, value: 'CD' }, 0), undefined);
  assert.equal(matchingPCBTextRenderCache(text, 180), undefined);
  assert.ok('unsupported' in pcbStrokeText(text, pcb.graphics[0].start));

  assert.ok(core.replaceBoard({ ...pcb, thickness: 1.5 }));
  const reopened = open(source()).pcb!;
  assert.equal(reopened.thickness, 1.5);
  assert.deepEqual(reopened.graphics[0].text, text);
  assert.deepEqual(reopened.footprints[0].graphics[0].text, pcb.footprints[0].graphics[0].text);
  assert.deepEqual(
    child(child(parseSExpr(source()), 'gr_text')!, 'render_cache'),
    child(child(parseSExpr(board), 'gr_text')!, 'render_cache'),
  );
});

test('cached text and footprints cannot move or change their captions through ordinary editing', () => {
  const core = new ProjectCore(open());
  const snapshot = core.getSnapshot();
  const pcb = snapshot.project!.pcb!;
  const graphics = pcb.graphics.map((g) => ({ ...g, start: { x: 6, y: 6 }, end: { x: 6, y: 6 } }));
  assert.throws(
    () => core.replaceBoard({ ...pcb, graphics }),
    /cached outlines requires native Source/,
  );
  assert.throws(
    () =>
      core.replaceBoard({
        ...pcb,
        footprints: pcb.footprints.map((footprint) => ({ ...footprint, x: 0 })),
      }),
    /cached outlines requires native Source/,
  );
  assert.throws(
    () =>
      core.replaceBoard({
        ...pcb,
        footprints: pcb.footprints.map((footprint) => ({ ...footprint, reference: 'R2' })),
      }),
    /cached outlines requires native Source/,
  );
  assert.equal(core.getSnapshot(), snapshot);
});

test('a render cache rejects missing named font and unsupported polygon records', () => {
  assert.throws(() => open(board.replace('(face "Liberation Sans")', '')), /requires a font face/);
  assert.throws(
    () => open(board.replace('(xy 4.815 6.222)', '(arc (start 4 6))')),
    /unsupported PCB text render cache point/i,
  );
});

test('hidden standard captions use the native default and preserve omitted effects', () => {
  const source = `(kicad_pcb (version 20260206) (generator "pcbnew")
    (general (thickness 1.6)) (paper "A4") (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    (setup (pad_to_mask_clearance 0))
    (footprint "Local:LED" (layer "F.Cu") (at 12 10)
      (property "Description" "Indoor LED")
      (property "Reference" "LED1" (at 0 0) (layer "F.SilkS") (hide yes))
      (property "Value" "Light" (at 0 0) (layer "F.Fab") (hide yes))))`;
  const core = new ProjectCore(open(source));
  const accepted = core.getSnapshot().project!.pcb!;
  const footprint = accepted.footprints[0];
  assert.equal(footprint.reference, 'LED1');
  assert.equal(footprint.value, 'Light');
  for (const { text } of footprint.graphics) {
    assert.equal(text?.hidden, true);
    assert.deepEqual(text?.size, { x: 1.27, y: 1.27 });
    assert.equal(text?.thickness, 0);
  }
  assert.ok(core.replaceBoard({ ...accepted, thickness: 1.5 }));
  const file = core.getNativeFiles().files.find(({ name }) => name === filename)!;
  assert.deepEqual(open(file.source).pcb!.footprints[0].graphics, footprint.graphics);
  const nativeFootprint = child(parseSExpr(file.source), 'footprint')!;
  assert.equal(
    nativeFootprint.filter(Array.isArray).filter((node) => node[0] === 'property').length,
    3,
  );
  assert.ok(!file.source.includes('(effects'));
  assert.throws(() => open(source.replace('(hide yes)', '(hide no)')), /Text has no font geometry/);
  assert.throws(() => open(source.replace('"Reference"', '"Label"')), /Text has no font geometry/);
});

test('explicit zero line spacing overlays native stroke text and survives Save', () => {
  const source = board.replace(
    '(gr_text "AB" (at 5 6 0) (layer "F.SilkS")\n  (effects (font (face "Liberation Sans") (size 1.3 1.3) (thickness 0.15)))\n  (render_cache "AB" 0 (polygon (pts (xy 4.815 6.222) (xy 5.17625 6.123456) (xy 4.977 5.523)))))',
    '(gr_text "A\\nA" (at 5 6 0) (layer "F.SilkS") (effects (font (size 1 1) (line_spacing 0))))',
  );
  const core = new ProjectCore(open(source));
  const pcb = core.getSnapshot().project!.pcb!;
  const graphic = pcb.graphics[0];
  const text = graphic.text!;
  assert.equal(text.lineSpacing, 0);
  const multi = pcbStrokeText(text, graphic.start);
  const single = pcbStrokeText({ ...text, value: 'A' }, graphic.start);
  assert.ok('paths' in multi && 'paths' in single);
  assert.deepEqual(multi.paths, [...single.paths, ...single.paths]);
  assert.ok(core.replaceBoard({ ...pcb, thickness: 1.5 }));
  const file = core.getNativeFiles().files.find(({ name }) => name === filename)!;
  assert.match(file.source, /\(line_spacing 0\)/);
  assert.deepEqual(open(file.source).pcb!.graphics[0].text, text);
  assert.throws(
    () => open(source.replace('(line_spacing 0)', '(line_spacing 0) (line_spacing 1)')),
    /Invalid native PCB text line spacing/,
  );
});
