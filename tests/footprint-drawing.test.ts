import assert from 'node:assert/strict';
import test from 'node:test';
import schemas from '../core/layout-property-schemas.json';
import { compileCapabilitySchema } from '../api/capability-schema';
import { createPart, pinPositions, uid } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import { serializePCB, type Footprint } from '../lib/pcb';
import { createProject } from '../lib/project';
import { updatePCBFromSchematic } from '../lib/pcb-sync';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import {
  footprintDrawingSchema,
  prepareFootprintDrawing,
  readFootprintDrawing,
  type FootprintDrawing,
} from '../lib/footprint-drawing';

function drawing(): FootprintDrawing {
  return {
    pads: [
      {
        number: '1',
        x: -2,
        y: 0,
        rotation: 0,
        type: 'thru_hole',
        shape: 'circle',
        size: { x: 2, y: 2 },
        drill: 0.8,
      },
      {
        number: '2',
        x: 2,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'roundrect',
        size: { x: 2, y: 2 },
        roundrectRatio: 0.2,
      },
    ],
    graphics: [
      {
        kind: 'circle',
        start: { x: 0, y: 0 },
        end: { x: 3, y: 0 },
        layer: 'F.SilkS',
        width: 0.15,
        fill: false,
      },
    ],
  };
}

test('custom footprint drawing creates native packages with fresh identities and independent inputs', () => {
  const board = createEmptyPCB();
  const input = drawing();
  const made = prepareFootprintDrawing(board, {
    name: 'Connector',
    position: { x: 50.123456, y: 50.654321 },
    drawing: input,
  });
  const footprint = made.board.footprints[0];
  assert.equal(board.footprints.length, 0);
  assert.equal(footprint.libraryId, 'OpenPE:Connector');
  assert.equal(footprint.reference, 'FP1');
  assert.equal(footprint.id, made.footprintId);
  assert.equal(
    new Set([
      footprint.id,
      ...footprint.pads.map((p) => p.id),
      ...footprint.graphics.map((g) => g.id),
    ]).size,
    4,
  );
  assert.ok(footprint.pads.every((p) => p.netId === null));
  input.pads[0].size.x = 900;
  assert.equal(footprint.pads[0].size.x, 2);
  const project = createProject();
  const native = serializePCB(made.board, project.schematic);
  const reopened = parseKiCadPCB(native, project.schematic, project.id).board;
  assert.equal(reopened.footprints[0].libraryId, 'OpenPE:Connector');
  assert.equal(reopened.footprints[0].x, 50.123456);
  assert.equal(reopened.footprints[0].y, 50.654321);
  assert.deepEqual(
    reopened.footprints[0].pads.map(({ layers: _layers, ...pad }) => pad),
    footprint.pads,
  );
  assert.equal(
    reopened.footprints[0].graphics.find((g) => g.kind === 'circle')?.id,
    footprint.graphics[0].id,
  );
  const another = prepareFootprintDrawing(made.board, {
    name: 'Connector',
    position: { x: 65, y: 50 },
    drawing: drawing(),
  });
  assert.equal(another.board.footprints[1].reference, 'FP2');
  assert.notEqual(another.footprintId, footprint.id);
});

test('editing footprint artwork preserves pose, models, nets, fabrication metadata and copper', () => {
  const made = prepareFootprintDrawing(createEmptyPCB(), { name: 'Connector', drawing: drawing() });
  const footprint = made.board.footprints[0];
  const netId = uid();
  footprint.x = 15;
  footprint.rotation = 90;
  footprint.pads[0].netId = netId;
  footprint.pads[0].solderMaskMargin = 0.03;
  footprint.models = [
    {
      path: '${KIPRJMOD}/models/device.step',
      offset: { x: 0, y: 0, z: 1 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  ];
  footprint.solderPasteMargin = -0.01;
  const board = {
    ...made.board,
    nets: [{ id: netId, name: 'OUT' }],
    tracks: [
      {
        id: uid(),
        start: { x: 70, y: 20 },
        end: { x: 71, y: 20 },
        width: 0.2,
        netId,
        layer: 'F.Cu' as const,
      },
    ],
  };
  const edited = readFootprintDrawing(footprint);
  delete edited.pads[0].id;
  delete edited.pads[0].solderMaskMargin;
  edited.graphics[0].width = 0.2;
  edited.pads.push({
    number: '3',
    x: 6,
    y: 0,
    rotation: 0,
    type: 'smd',
    shape: 'rect',
    size: { x: 1, y: 1 },
  });
  const result = prepareFootprintDrawing(board, {
    footprintId: footprint.id,
    name: 'Renamed',
    position: { x: 100, y: 100 },
    drawing: edited,
  });
  const next = result.board.footprints[0];
  assert.equal(next.id, footprint.id);
  assert.equal(next.libraryId, footprint.libraryId);
  assert.equal(next.x, 15);
  assert.equal(next.rotation, 90);
  assert.equal(next.models, footprint.models);
  assert.equal(next.solderPasteMargin, -0.01);
  assert.equal(next.pads[0].id, footprint.pads[0].id);
  assert.equal(next.pads[0].netId, netId);
  assert.equal(next.pads[0].solderMaskMargin, 0.03);
  assert.equal(next.graphics[0].id, footprint.graphics[0].id);
  assert.equal(result.board.tracks, board.tracks);
  assert.equal(
    prepareFootprintDrawing(result.board, {
      footprintId: next.id,
      name: '',
      drawing: readFootprintDrawing(next),
    }).board,
    result.board,
  );
});

test('drawing schema exposes canonical geometry but denies net and lock authority', () => {
  const validate = compileCapabilitySchema(footprintDrawingSchema(schemas));
  assert.equal(validate(drawing()).valid, true);
  for (const injected of [
    { netId: uid() },
    { locked: true },
    { unconnected: true },
    { unknown: true },
  ]) {
    const input = drawing();
    Object.assign(input.pads[0], injected);
    assert.equal(validate(input).valid, false);
  }
  const malformed = drawing();
  malformed.pads[0].size.x = -1;
  assert.equal(validate(malformed).valid, false);
});

test('unconnected pad conversion clears inherited drills but rejects explicit SMD drill fields', () => {
  const made = prepareFootprintDrawing(createEmptyPCB(), { name: 'Connector', drawing: drawing() });
  const original = made.board.footprints[0];
  original.pads[0].drillOffset = { x: 0.1, y: 0 };
  const converted = readFootprintDrawing(original);
  converted.pads[0].type = 'smd';
  delete converted.pads[0].drill;
  delete converted.pads[0].drillOffset;
  const result = prepareFootprintDrawing(made.board, {
    footprintId: original.id,
    name: '',
    drawing: converted,
  });
  const pad = result.board.footprints[0].pads[0];
  assert.equal(pad.id, original.pads[0].id);
  assert.equal(pad.type, 'smd');
  assert.equal(pad.drill, undefined);
  assert.equal(pad.drillOffset, undefined);
  const explicit = structuredClone(converted);
  explicit.pads[0].drill = 0.8;
  assert.throws(
    () =>
      prepareFootprintDrawing(made.board, {
        footprintId: original.id,
        name: '',
        drawing: explicit,
      }),
    /SMD pads cannot have drills/,
  );
  assert.equal(original.pads[0].drill, 0.8);
});

test('invalid, locked, stale and connected drawing changes reject without changing the board', () => {
  const made = prepareFootprintDrawing(createEmptyPCB(), { name: 'Connector', drawing: drawing() });
  const footprint = made.board.footprints[0];
  const original = JSON.stringify(made.board);
  const apply = (value: FootprintDrawing) =>
    prepareFootprintDrawing(made.board, { footprintId: footprint.id, name: '', drawing: value });
  const badSize = readFootprintDrawing(footprint);
  badSize.pads[0].drill = 3;
  assert.throws(() => apply(badSize), /smaller/);
  const stale = readFootprintDrawing(footprint);
  stale.pads[0].id = uid();
  assert.throws(() => apply(stale), /ID/);
  assert.equal(JSON.stringify(made.board), original);
  const locked: Footprint = { ...footprint, locked: true };
  const lockedBoard = { ...made.board, footprints: [locked] };
  const change = readFootprintDrawing(locked);
  change.graphics[0].width = 0.3;
  assert.throws(
    () =>
      prepareFootprintDrawing(lockedBoard, { footprintId: locked.id, name: '', drawing: change }),
    /Unlock/,
  );
  const netId = uid();
  const connected = {
    ...footprint,
    pads: footprint.pads.map((pad, i) => (i ? pad : { ...pad, netId })),
  };
  const routed = {
    ...made.board,
    nets: [{ id: netId, name: 'OUT' }],
    footprints: [connected],
    tracks: [
      {
        id: uid(),
        start: { x: -2, y: 0 },
        end: { x: -8, y: 0 },
        layer: 'F.Cu' as const,
        width: 0.2,
        netId,
      },
    ],
  };
  const moved = readFootprintDrawing(connected);
  moved.pads[0].x = -3;
  assert.throws(
    () => prepareFootprintDrawing(routed, { footprintId: connected.id, name: '', drawing: moved }),
    /routed pad/,
  );
  assert.throws(
    () =>
      prepareFootprintDrawing(routed, {
        footprintId: connected.id,
        name: '',
        drawing: { pads: [moved.pads[1]], graphics: moved.graphics },
      }),
    /connected pad cannot be removed/,
  );
});

test('drawing checks all fixed copper even when it has no assigned net', () => {
  const board = createEmptyPCB();
  const netId = uid();
  board.nets = [{ id: netId, name: 'FIXED' }];
  board.tracks = [
    {
      id: uid(),
      start: { x: 48, y: 50 },
      end: { x: 44, y: 50 },
      layer: 'F.Cu',
      width: 0.2,
      netId,
      locked: true,
    },
  ];
  const before = JSON.stringify(board);
  assert.throws(
    () =>
      prepareFootprintDrawing(board, {
        name: 'Blocked',
        position: { x: 50, y: 50 },
        drawing: drawing(),
      }),
    /Copper is blocked/,
  );
  assert.equal(JSON.stringify(board), before);
});

test('new mechanical holes cannot overlap another hole without copper bodies', () => {
  const mechanical: FootprintDrawing = {
    pads: [
      {
        number: '',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'np_thru_hole',
        shape: 'circle',
        size: { x: 2, y: 2 },
        drill: 2,
      },
    ],
    graphics: [],
  };
  const made = prepareFootprintDrawing(createEmptyPCB(), { name: 'Mount', drawing: mechanical });
  const before = JSON.stringify(made.board);
  assert.throws(
    () => prepareFootprintDrawing(made.board, { name: 'OtherMount', drawing: mechanical }),
    /Drilled holes cannot overlap/,
  );
  assert.equal(JSON.stringify(made.board), before);
});

test('linked custom packages retain their geometry and identities during schematic net synchronization', () => {
  const project = createProject();
  const schematic = project.schematic;
  const part = createPart(schematic, 'R', 10.16, 10.16);
  schematic.parts.push(part);
  const pin = pinPositions(part, schematic.libraries[part.libId])[0];
  schematic.wires.push({ id: uid(), a: pin, b: { x: pin.x + 10.16, y: pin.y } });
  const made = prepareFootprintDrawing(createEmptyPCB(), {
    name: 'Resistor',
    partId: part.id,
    position: { x: 50, y: 50 },
    drawing: drawing(),
  });
  const footprint = made.board.footprints[0];
  assert.equal(footprint.symbolId, part.id);
  assert.equal(footprint.reference, undefined);
  part.fields = { ...part.fields, Footprint: footprint.libraryId };
  const synchronized = updatePCBFromSchematic(schematic, made.board, new Map());
  assert.equal(synchronized.board.footprints[0].id, footprint.id);
  assert.deepEqual(
    synchronized.board.footprints[0].pads.map((pad) => pad.id),
    footprint.pads.map((pad) => pad.id),
  );
  assert.ok(synchronized.board.footprints[0].pads[0].netId);
  assert.equal(synchronized.board.footprints[0].graphics, footprint.graphics);
  const native = serializePCB(synchronized.board, schematic);
  const reopened = parseKiCadPCB(native, schematic, project.id).board;
  assert.equal(reopened.footprints[0].symbolId, part.id);
  assert.deepEqual(
    reopened.footprints[0].pads.map(
      (pad) => reopened.nets.find((net) => net.id === pad.netId)?.name ?? null,
    ),
    synchronized.board.footprints[0].pads.map(
      (pad) => synchronized.board.nets.find((net) => net.id === pad.netId)?.name ?? null,
    ),
  );
});
