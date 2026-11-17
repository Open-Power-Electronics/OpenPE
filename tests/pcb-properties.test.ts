import test from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../lib/circuit';
import { createEmptyPCB, flipPCBFootprint, padPosition } from '../lib/pcb-layout';
import { type Pad, type PCB } from '../lib/pcb';
import {
  setPCBPadProperties,
  setPCBTrackEndpoints,
  type PCBPadProperties,
} from '../lib/pcb-properties';
import { createProject } from '../lib/project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { child, children, num, parseSExpr, val } from '../lib/sexpr';
import { ProjectCore } from '../core/project-core';
import { fillCopperZones } from '../lib/pcb-polygons';

function fixture() {
  const netId = uid();
  const pad: Pad = {
    id: uid(),
    number: '1',
    x: 0.635,
    y: -1.27,
    rotation: 30,
    type: 'thru_hole',
    shape: 'roundrect',
    size: { x: 2, y: 1.8 },
    drill: 0.8,
    netId,
    layers: ['*.Cu', '*.Mask'],
    roundrectRatio: 0.2,
    solderMaskMargin: 0.05,
    thermalBridgeAngle: 45,
    zoneConnect: 2,
  };
  const board: PCB = {
    ...createEmptyPCB(),
    nets: [{ id: netId, name: 'SIGNAL' }],
    footprints: [
      {
        id: uid(),
        symbolId: null,
        reference: 'J1',
        value: 'Connector',
        libraryId: 'Test:Connector',
        x: 20,
        y: 15,
        rotation: 90,
        side: 'front',
        pads: [pad, { ...pad, id: uid(), number: '2', x: 3.175 }],
        graphics: [],
      },
    ],
    tracks: [
      {
        id: uid(),
        start: { x: 5.123456, y: 6.234567 },
        end: { x: 10.345678, y: 11.456789 },
        netId,
        layer: 'F.Cu',
        width: 0.25,
      },
    ],
    zones: [
      {
        id: uid(),
        netId,
        layer: 'F.Cu',
        outline: [
          { x: 0, y: 0 },
          { x: 30, y: 0 },
          { x: 30, y: 30 },
          { x: 0, y: 30 },
        ],
        clearance: 0.25,
        minThickness: 0.1,
        thermalGap: 0.25,
        thermalBridge: 0.25,
        filledPolygons: [
          {
            points: [
              { x: 1, y: 1 },
              { x: 29, y: 1 },
              { x: 29, y: 29 },
            ],
          },
        ],
      },
    ],
  };
  return { board, pad };
}

test('pad property edits preserve pin identity, native rules, unrelated geometry and exact local coordinates', () => {
  const { board, pad } = fixture();
  const before = structuredClone(board);
  const size = { x: 2.4, y: 2.2 };
  const next = setPCBPadProperties(board, pad.id, { x: 0.123456, size, drill: 0.9 });
  const edited = next.footprints[0].pads[0];
  assert.deepEqual(board, before);
  assert.deepEqual(edited, { ...pad, x: 0.123456, size, drill: 0.9 });
  assert.equal(next.footprints[0].pads[1], board.footprints[0].pads[1]);
  assert.equal(next.tracks, board.tracks);
  assert.equal(next.zones[0].filledPolygons, undefined);
  size.x = 99;
  assert.equal(edited.size.x, 2.4, 'Caller-owned patch containers cannot alter accepted geometry.');
  assert.equal(setPCBPadProperties(board, pad.id, { x: pad.x }), board);
  assert.deepEqual(padPosition(next.footprints[0], edited), { x: 18.73, y: 14.876544 });
});

test('shape edits keep circles valid and reconcile rounded-corner data while rejecting impossible drills', () => {
  const { board, pad } = fixture();
  const circle = setPCBPadProperties(board, pad.id, { shape: 'circle' });
  const round = circle.footprints[0].pads[0];
  assert.deepEqual(round.size, { x: 2, y: 2 });
  assert.equal(round.roundrectRatio, undefined);
  const taller = setPCBPadProperties(circle, pad.id, { size: { x: 2, y: 2.5 } });
  assert.deepEqual(taller.footprints[0].pads[0].size, { x: 2.5, y: 2.5 });
  const rounded = setPCBPadProperties(circle, pad.id, { shape: 'roundrect' });
  assert.equal(rounded.footprints[0].pads[0].roundrectRatio, 0.25);
  for (const changes of [{ drill: 2 }, { size: { x: 0.5, y: 1 } }, { x: NaN }])
    assert.throws(() => setPCBPadProperties(board, pad.id, changes), /Layout:/);
  assert.throws(
    () => setPCBPadProperties(board, pad.id, { netId: uid() } as PCBPadProperties),
    /identity/,
  );
  assert.throws(
    () => setPCBPadProperties(board, pad.id, { number: '3' } as PCBPadProperties),
    /identity/,
  );
  assert.throws(() => setPCBPadProperties(board, uid(), {}), /no longer/);
});

test('pad edits refresh native fills in one board revision and undo restores exact source', () => {
  const { board, pad } = fixture();
  board.footprints[0] = flipPCBFootprint(board.footprints[0]);
  // A thermal relief follows the pad geometry. A solid same-net plated drill
  // is stored separately and does not cut the zone contour.
  board.footprints[0].pads[0].zoneConnect = 1;
  const outline = board.zones[0].outline;
  board.graphics = outline.map((start, index) => ({
    id: uid(),
    layer: 'Edge.Cuts',
    width: 0.05,
    start,
    end: outline[(index + 1) % outline.length],
  }));
  const project = createProject();
  project.pcb = fillCopperZones(board);
  const core = new ProjectCore(project);
  const initial = core.getNativeFiles();
  const owned = core.getSnapshot().project!.pcb!;
  const edited = setPCBPadProperties(owned, pad.id, {
    x: -0.123456,
    y: 0.654321,
    rotation: 17.5,
    drill: 0.9,
    solderMaskMargin: 0.08,
    solderPasteMarginRatio: -0.1,
  });
  assert.equal(core.replaceBoard(edited), true);
  assert.equal(core.getSnapshot().undoDepth, 1);
  const files = core.getNativeFiles();
  const nativeFile = files.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
  const native = children(children(parseSExpr(nativeFile.source), 'footprint')[0], 'pad')[0];
  assert.equal(val(child(native, 'uuid')), pad.id);
  assert.equal(val(native), pad.number);
  assert.deepEqual([num(child(native, 'at')), num(child(native, 'at'), 2)], [-0.123456, 0.654321]);
  assert.equal(num(child(native, 'drill')), 0.9);
  assert.equal(num(child(native, 'solder_mask_margin')), 0.08);
  const reopened = projectFromNativeFiles(files);
  const restoredPad = reopened.pcb!.footprints[0].pads[0];
  const accepted = core.getSnapshot().project!.pcb!;
  const acceptedPad = accepted.footprints[0].pads[0];
  // Native nets have names; import derives their private IDs independently.
  assert.deepEqual({ ...restoredPad, netId: acceptedPad.netId }, acceptedPad);
  assert.equal(reopened.pcb!.nets.find((net) => net.id === restoredPad.netId)?.name, 'SIGNAL');
  assert.ok(accepted.zones[0].filledPolygons!.length > 0);
  assert.notDeepEqual(accepted.zones[0].filledPolygons, owned.zones[0].filledPolygons);
  assert.deepEqual(
    accepted.zones[0].filledPolygons,
    fillCopperZones(edited).zones[0].filledPolygons,
  );
  assert.deepEqual(reopened.pcb!.zones[0].filledPolygons, accepted.zones[0].filledPolygons);
  assert.ok(
    children(children(parseSExpr(nativeFile.source), 'zone')[0], 'filled_polygon').length > 0,
  );
  core.undo();
  assert.deepEqual(core.getNativeFiles(), initial);
  core.redo();
  assert.deepEqual(core.getNativeFiles(), files);
});

test('track endpoint edits retain exact anchors and metadata, invalidate fills and respect locks', () => {
  const { board } = fixture();
  const track = board.tracks[0];
  const start = { x: 8.123456789, y: -2.345678912 };
  const next = setPCBTrackEndpoints(board, track.id, { start });
  assert.deepEqual(next.tracks[0], { ...track, start });
  assert.equal(next.tracks[0].end, track.end);
  assert.equal(next.footprints[0], board.footprints[0]);
  assert.equal(next.zones[0].filledPolygons, undefined);
  assert.equal(setPCBTrackEndpoints(board, track.id, { start: { ...track.start } }), board);
  assert.throws(
    () =>
      setPCBTrackEndpoints({ ...board, tracks: [{ ...track, locked: true }] }, track.id, { start }),
    /Unlock/,
  );
  assert.throws(
    () => setPCBTrackEndpoints(board, track.id, { end: { x: Infinity, y: 0 } }),
    /finite/,
  );
  start.x = 99;
  assert.equal(next.tracks[0].start.x, 8.123456789);
});
