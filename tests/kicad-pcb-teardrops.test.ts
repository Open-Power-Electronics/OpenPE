import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { fillCopperZones } from '../lib/pcb-polygons';
import { child, parseSExpr, val, writeSExpr } from '../lib/sexpr';

const boardName = 'Teardrops.kicad_pcb';
const nativeBoard = `(kicad_pcb
 (version 20260206) (generator "pcbnew")
 (general (thickness 1.6)) (paper "A4")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (setup (pad_to_mask_clearance 0))
 (net 1 "GND")
 (footprint "Local:Example" (layer "F.Cu") (at 2 2)
   (property "Reference" "J1") (property "Value" "Example")
   (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu" "*.Mask")
    (net "GND")
    (teardrops (best_length_ratio 0.5) (max_length 1) (best_width_ratio 1) (max_width 2)
      (curved_edges no) (filter_ratio 0.9) (enabled yes) (allow_two_segments yes)
      (prefer_zone_connections yes))))
 (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "GND"))
 (via (at 4 2) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND")
   (teardrops (curved_edges yes) (enabled no)))
 (zone (net "GND") (layer "F.Cu") (name "$teardrop_padvia$")
   (hatch full 0.1) (priority 30006) (attr (teardrop (type padvia)))
   (connect_pads yes (clearance 0)) (min_thickness 0.0254)
   (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 1) (island_area_min 10))
   (polygon (pts (xy 2 1.6) (xy 3 1.875) (xy 3 2.125) (xy 2 2.4)))
   (filled_polygon (layer "F.Cu")
     (pts (xy 2.01 1.61) (xy 2.99 1.885) (xy 2.99 2.115) (xy 2.01 2.39)))))\n`;

const open = (source = nativeBoard) =>
  projectFromNativeFiles({ entry: boardName, files: [{ name: boardName, source }] });
const boardSource = (bundle: NonNullable<ReturnType<typeof open>['nativeFiles']>) =>
  bundle.files.find((record) => record.name === boardName)!.source;

test('native teardrop settings and generated contours survive KiCad 10 Save and subsequent edits', () => {
  const core = new ProjectCore(open());
  const original = core.getSnapshot().project!;
  const board = original.pcb!;
  assert.deepEqual(board.footprints[0].pads[0].teardrops, {
    bestLengthRatio: 0.5,
    maxLength: 1,
    bestWidthRatio: 1,
    maxWidth: 2,
    filterRatio: 0.9,
    curvedEdges: false,
    enabled: true,
    allowTwoSegments: true,
    preferZoneConnections: true,
  });
  assert.deepEqual(board.vias[0].teardrops, { curvedEdges: true, enabled: false });
  assert.equal(board.zones[0].teardrop, 'padvia');
  assert.equal(board.zones[0].priority, 30006);
  assert.equal(boardSource(core.getNativeFiles()), nativeBoard);

  const saved = projectNativeFiles(original);
  assert.equal(val(child(parseSExpr(boardSource(saved)), 'version')), '20260206');
  assert.deepEqual(projectFromNativeFiles(saved).pcb, board);
  assert.ok(core.materialize(original, { ...original, nativeFiles: saved }));
  assert.deepEqual(core.getSnapshot().project!.pcb, board);

  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  const edited = projectFromNativeFiles(core.getNativeFiles()).pcb!;
  assert.equal(edited.thickness, 1.5);
  assert.deepEqual(edited.footprints[0].pads[0].teardrops, board.footprints[0].pads[0].teardrops);
  assert.deepEqual(edited.vias[0].teardrops, board.vias[0].teardrops);
  assert.deepEqual(edited.zones, board.zones);
});

test('native teardrops prevent copper edits and refill without changing accepted Source', () => {
  const core = new ProjectCore(open());
  const before = core.getSnapshot();
  const board = before.project!.pcb!;
  const tracks = board.tracks.map((track) => ({ ...track, width: 0.3 }));
  assert.throws(
    () => core.replaceBoard({ ...board, tracks }),
    /native teardrops require native Source/,
  );
  assert.throws(
    () =>
      core.execute('layout.delete', {
        boardId: board.id,
        selection: [{ kind: 'track', id: tracks[0].id }],
      }),
    /native teardrops require native Source/,
  );
  const footprints = board.footprints.map((footprint) => ({ ...footprint, x: footprint.x + 2 }));
  assert.throws(
    () => core.replaceBoard({ ...board, footprints }, undefined, 'footprint-position'),
    /native teardrops require native Source/,
  );
  assert.throws(() => fillCopperZones(board), /native teardrops requires KiCad/);
  assert.equal(core.getSnapshot(), before);
  assert.equal(boardSource(core.getNativeFiles()), nativeBoard);
});

test('native KiCad 10 can omit thermal records only on generated teardrop zones', () => {
  const current = boardSource(projectNativeFiles(open()));
  const source = current.replace(/ \(thermal_(?:gap|bridge_width) 0\.5\)/g, '');
  const core = new ProjectCore(open(source));
  const board = core.getSnapshot().project!.pcb!;
  assert.deepEqual(board.zones, open(current).pcb!.zones);
  assert.equal(boardSource(core.getNativeFiles()), source);

  assert.ok(core.replaceBoard({ ...board, thickness: 1.5 }));
  const edited = child(parseSExpr(boardSource(core.getNativeFiles())), 'zone')!;
  assert.equal(child(child(edited, 'fill')!, 'thermal_gap'), undefined);
  assert.equal(child(child(edited, 'fill')!, 'thermal_bridge_width'), undefined);

  const plain = parseSExpr(source);
  const plainZone = child(plain, 'zone')!;
  const attribute = child(plainZone, 'attr')!;
  plainZone.splice(plainZone.indexOf(attribute), 1);
  assert.throws(() => open(writeSExpr(plain)), /Missing numeric field/);
});

test('invalid teardrop attributes and duplicate native overrides reject before admission', () => {
  assert.throws(
    () => open(nativeBoard.replace('(type padvia)', '(type unsupported)')),
    /zone attribute/,
  );
  assert.throws(
    () => open(nativeBoard.replace('(enabled no)', '(enabled no) (enabled yes)')),
    /duplicate field/,
  );
  assert.throws(
    () => open(nativeBoard.replace(/\s+\(filled_polygon[\s\S]+$/, '))\n')),
    /require a net and saved copper contours/,
  );
});
