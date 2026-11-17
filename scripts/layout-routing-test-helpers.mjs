import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, createPart, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { serializePCB } = await tsImport('../lib/pcb.ts', import.meta.url);
const { parseProject, serializeProject, createProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { parseSExpr, children, child, val, num } = await tsImport(
  '../lib/sexpr.ts',
  import.meta.url,
);

// Shared pure fixtures and preservation assertions for isolated Layout routing checks.
export function routingFixture({ fourLayers = false, endLayer = 'B.Cu' } = {}) {
  const board = createEmptyPCB();
  const schematic = emptyCircuit();
  if (fourLayers) board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  board.nets = [
    { id: uid(), name: 'OUT' },
    { id: uid(), name: 'GND' },
  ];
  board.graphics = [
    {
      id: uid(),
      kind: 'polygon',
      layer: 'Edge.Cuts',
      width: 0.1,
      start: { x: 0, y: 0 },
      points: [
        { x: 70, y: 0 },
        { x: 70, y: 45 },
      ],
      end: { x: 0, y: 45 },
    },
  ];
  board.footprints = [
    { x: 18.25, layer: 'F.Cu' },
    { x: endLayer === 'F.Cu' ? 58.25 : 48.25, layer: endLayer },
  ].map(({ x, layer }, i) => {
    const part = createPart(schematic, 'Port', i * 12.7, 0);
    schematic.parts.push(part);
    return {
      id: uid(),
      symbolId: part.id,
      libraryId: 'Test:LayerPad',
      x,
      y: 22.75,
      rotation: 0,
      side: layer === 'B.Cu' ? 'back' : 'front',
      graphics: [],
      pads: [
        {
          id: uid(),
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 2, y: 2 },
          netId: board.nets[0].id,
          layers: [layer],
        },
      ],
    };
  });
  board.tracks = [
    {
      id: uid(),
      start: { x: 15, y: 36 },
      end: { x: 25, y: 36 },
      width: 0.6,
      layer: 'F.Cu',
      netId: board.nets[1].id,
    },
  ];
  board.vias = [{ id: uid(), x: 52, y: 33, diameter: 1, drill: 0.4, netId: board.nets[1].id }];
  return { board, schematic };
}

export function verifyRoutingPreservation(before, after, schematic) {
  assert.deepEqual(
    after.footprints,
    before.footprints,
    'Routing retains packages, SMD layers, pins and UUIDs.',
  );
  assert.deepEqual(after.graphics, before.graphics);
  assert.deepEqual(after.nets, before.nets);
  assert.deepEqual(
    after.tracks.slice(0, before.tracks.length),
    before.tracks,
    'Existing copper remains byte-equivalent.',
  );
  assert.deepEqual(after.vias.slice(0, before.vias.length), before.vias);
  const project = createProject(schematic);
  project.pcb = after;
  assert.deepEqual(
    parseProject(serializeProject(project)).pcb,
    after,
    'The entire multi-layer route persists in the private project snapshot.',
  );
  const native = parseSExpr(serializePCB(after, schematic));
  const segments = children(native, 'segment');
  const vias = children(native, 'via');
  assert.equal(segments.length, after.tracks.length);
  assert.equal(vias.length, after.vias.length);
  for (const track of after.tracks) {
    const node = segments.find((segment) => val(child(segment, 'uuid')) === track.id);
    assert.ok(node);
    assert.deepEqual(
      { x: num(child(node, 'start')), y: num(child(node, 'start'), 2) },
      track.start,
    );
    assert.deepEqual({ x: num(child(node, 'end')), y: num(child(node, 'end'), 2) }, track.end);
    assert.equal(num(child(node, 'width')), track.width);
    assert.equal(val(child(node, 'layer')), track.layer);
    assert.equal(val(child(node, 'net')), after.nets.find((net) => net.id === track.netId).name);
  }
  for (const via of after.vias) {
    const node = vias.find((item) => val(child(item, 'uuid')) === via.id);
    assert.ok(node);
    assert.deepEqual(
      { x: num(child(node, 'at')), y: num(child(node, 'at'), 2) },
      { x: via.x, y: via.y },
    );
    assert.equal(num(child(node, 'size')), via.diameter);
    assert.equal(num(child(node, 'drill')), via.drill);
    assert.deepEqual(
      child(node, 'layers')
        .slice(1)
        .map((value) => JSON.parse(value)),
      ['F.Cu', 'B.Cu'],
    );
    assert.equal(val(child(node, 'net')), after.nets.find((net) => net.id === via.netId).name);
  }
}
