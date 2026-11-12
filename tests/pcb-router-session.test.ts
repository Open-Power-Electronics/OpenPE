import assert from 'node:assert/strict';
import test from 'node:test';
import { uid } from '../lib/circuit';
import { ownProjectData } from '../lib/immutable-project';
import type { Footprint, PCB } from '../lib/pcb';
import { createEmptyPCB, movePCBSelection } from '../lib/pcb-layout';
import { createPCBRouter, createPCBRouterSession, type RoutingOptions } from '../lib/pcb-routing';

function board(): PCB {
  const pcb = createEmptyPCB();
  const out = uid();
  const gnd = uid();
  pcb.nets = [
    { id: out, name: 'OUT' },
    { id: gnd, name: 'GND' },
  ];
  const edge = (start: { x: number; y: number }, end: { x: number; y: number }) => ({
    id: uid(),
    start,
    end,
    width: 0.05,
    layer: 'Edge.Cuts' as const,
  });
  pcb.graphics = [
    edge({ x: 0, y: 0 }, { x: 40, y: 0 }),
    edge({ x: 40, y: 0 }, { x: 40, y: 30 }),
    edge({ x: 40, y: 30 }, { x: 0, y: 30 }),
    edge({ x: 0, y: 30 }, { x: 0, y: 0 }),
  ];
  pcb.footprints = [
    packageAt('U1', 8, 8, out),
    ...Array.from({ length: 12 }, (_, index) =>
      packageAt(`R${index}`, 4 + (index % 4) * 8, 18 + Math.floor(index / 4) * 4, gnd),
    ),
  ];
  pcb.tracks = [
    {
      id: uid(),
      start: { x: 20, y: 6 },
      end: { x: 20, y: 14 },
      width: 0.8,
      layer: 'F.Cu',
      netId: gnd,
    },
    {
      id: uid(),
      start: { x: 6, y: 12 },
      end: { x: 14, y: 12 },
      width: 0.6,
      layer: 'B.Cu',
      netId: gnd,
    },
  ];
  pcb.vias = [{ id: uid(), x: 28, y: 8, diameter: 1.2, drill: 0.5, netId: gnd }];
  pcb.zones = [
    {
      id: uid(),
      netId: null,
      layer: 'F.Cu',
      outline: [
        { x: 24, y: 16 },
        { x: 32, y: 16 },
        { x: 32, y: 24 },
        { x: 24, y: 24 },
      ],
      holes: [],
      clearance: 0.2,
      minThickness: 0.2,
      thermalGap: 0.2,
      thermalBridge: 0.2,
      keepout: { tracks: true, vias: true, pads: true, copperpour: true, footprints: false },
    },
  ];
  return ownProjectData(pcb);
}

function packageAt(reference: string, x: number, y: number, netId: string): Footprint {
  return {
    id: uid(),
    x,
    y,
    rotation: 0,
    side: 'front',
    symbolId: null,
    libraryId: 'Test:R',
    reference,
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: -0.8,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'rect',
        size: { x: 1, y: 0.7 },
        netId,
      },
      {
        id: uid(),
        number: '2',
        x: 0.8,
        y: 0,
        rotation: 0,
        type: 'thru_hole',
        shape: 'circle',
        size: { x: 1.2, y: 1.2 },
        drill: 0.4,
        netId,
      },
    ],
  };
}

const probes = [
  [
    { x: 2, y: 8 },
    { x: 36, y: 8 },
  ],
  [
    { x: 2, y: 12 },
    { x: 18, y: 12 },
  ],
  [
    { x: 22, y: 20 },
    { x: 34, y: 20 },
  ],
] as const;

function agree(pcb: PCB, options: RoutingOptions) {
  const session = createPCBRouterSession();
  const cold = createPCBRouter(pcb, options, session);
  const warm = createPCBRouter(pcb, options, session);
  const fresh = createPCBRouter(pcb, options);
  for (const [start, end] of probes) {
    const routed = cold.route(start, end);
    assert.deepEqual(warm.route(start, end), routed);
    assert.deepEqual(fresh.route(start, end), routed);
    assert.equal(warm.validate([start, end]), fresh.validate([start, end]));
    const region = [start, end, { x: end.x, y: start.y }];
    assert.equal(warm.validateRegion(region), fresh.validateRegion(region));
  }
}

test('a router session matches a fresh router before and after a footprint moves', () => {
  const pcb = board();
  const options: RoutingOptions = {
    layer: 'F.Cu',
    netId: pcb.nets[0].id,
    width: 0.25,
    clearance: 0.2,
  };
  agree(pcb, options);
  agree(pcb, { ...options, layer: 'B.Cu', obstacleType: 'pad', width: 0 });
  const session = createPCBRouterSession();
  createPCBRouter(pcb, options, session).validate([
    { x: 2, y: 8 },
    { x: 36, y: 8 },
  ]);
  const moved = movePCBSelection(pcb, [{ kind: 'footprint', id: pcb.footprints[0].id }], {
    x: 3,
    y: 1.5,
  });
  const warm = createPCBRouter(moved, options, session);
  const fresh = createPCBRouter(moved, options);
  for (const [start, end] of probes) {
    assert.deepEqual(warm.route(start, end), fresh.route(start, end));
    assert.equal(warm.validate([start, end]), fresh.validate([start, end]));
    assert.equal(
      warm.validateRegion([
        { x: moved.footprints[0].x - 2, y: moved.footprints[0].y - 2 },
        { x: moved.footprints[0].x + 2, y: moved.footprints[0].y - 2 },
        { x: moved.footprints[0].x + 2, y: moved.footprints[0].y + 2 },
        { x: moved.footprints[0].x - 2, y: moved.footprints[0].y + 2 },
      ]),
      fresh.validateRegion([
        { x: moved.footprints[0].x - 2, y: moved.footprints[0].y - 2 },
        { x: moved.footprints[0].x + 2, y: moved.footprints[0].y - 2 },
        { x: moved.footprints[0].x + 2, y: moved.footprints[0].y + 2 },
        { x: moved.footprints[0].x - 2, y: moved.footprints[0].y + 2 },
      ]),
    );
  }
});
