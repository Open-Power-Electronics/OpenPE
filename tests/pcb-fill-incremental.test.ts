import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { emptyCircuit, uid, type Circuit, type Point } from '../lib/circuit';
import { ownProjectData } from '../lib/immutable-project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { createPCBInteractiveDrag } from '../lib/pcb-interactive-drag';
import { serializePCB, type BoardZone, type Footprint, type Pad, type PCB } from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';
import { fillCopperZones, refreshPCBFill } from '../lib/pcb-polygons';

const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const ring = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
function zonesOf(board: PCB): BoardZone[] {
  return [...board.zones, ...board.footprints.flatMap((footprint) => footprint.zones ?? [])];
}

function pcbBytes(board: PCB, schematic: Circuit): string {
  return serializePCB(board, schematic);
}

function assertSameBytes(left: PCB, right: PCB, schematic: Circuit, label: string) {
  const full = pcbBytes(left, schematic);
  const incremental = pcbBytes(right, schematic);
  if (full === incremental) return;
  let index = 0;
  const limit = Math.min(full.length, incremental.length);
  while (index < limit && full[index] === incremental[index]) index += 1;
  throw new Error(
    `${label} .kicad_pcb bytes differ at ${index} (${full.length} vs ${incremental.length}): ${JSON.stringify(full.slice(Math.max(0, index - 30), index + 70))} <> ${JSON.stringify(incremental.slice(Math.max(0, index - 30), index + 70))}`,
  );
}

function fillBytes(board: PCB): string {
  return JSON.stringify(zonesOf(board).map((zone) => [zone.id, zone.filledPolygons]));
}

function edited(board: PCB, change: (board: PCB) => void): PCB {
  const copy = structuredClone(board);
  change(copy);
  return ownProjectData(copy, board);
}

function compareRefresh(previous: PCB, next: PCB, schematic: Circuit, label: string) {
  const incremental = refreshPCBFill(previous, next, true);
  const full = refreshPCBFill(previous, next, false);
  assertSameBytes(full, incremental, schematic, label);
  const again = refreshPCBFill(previous, next, true);
  assertSameBytes(full, again, schematic, `${label} repeated`);
  for (const zone of zonesOf(incremental)) {
    if (!zone.filledPolygons) continue;
    const reused = zonesOf(again).find((item) => item.id === zone.id);
    assert.equal(reused?.filledPolygons, zone.filledPolygons, `${label} contour identity`);
  }
  return { incremental, full };
}

const schematic = emptyCircuit();

function line(start: Point, end: Point) {
  return { id: uid(), layer: 'Edge.Cuts' as const, width: 0.05, start, end };
}

function pad(partial: Omit<Pad, 'id' | 'number' | 'rotation'> & { rotation?: number }): Pad {
  return { id: uid(), number: '1', rotation: 0, ...partial };
}

function footprint(
  partial: Omit<Footprint, 'id' | 'symbolId' | 'libraryId' | 'graphics'> & {
    graphics?: Footprint['graphics'];
  },
): Footprint {
  return {
    id: uid(),
    symbolId: null,
    libraryId: 'Test:Pad',
    graphics: [],
    ...partial,
  };
}

function pour(
  partial: Omit<BoardZone, 'id' | 'clearance' | 'minThickness' | 'thermalGap' | 'thermalBridge'> &
    Partial<BoardZone>,
): BoardZone {
  return {
    id: uid(),
    clearance: 0.3,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    ...partial,
  };
}

function makeBoard(corners = 4): PCB {
  const gnd = uid();
  const signal = uid();
  const board = createEmptyPCB();
  board.nets = [
    { id: gnd, name: 'GND' },
    { id: signal, name: 'SIGNAL' },
  ];
  const outline = ring(0, 0, 40, 24);
  board.graphics = outline.map((start, index) => line(start, outline[(index + 1) % 4]));
  const polygon =
    corners === 4
      ? ring(-1, -1, 42, 26)
      : Array.from({ length: corners }, (_, index) => {
          const angle = (index / corners) * Math.PI * 2;
          return { x: 20 + 16 * Math.cos(angle), y: 12 + 10 * Math.sin(angle) };
        });
  board.zones = [
    pour({
      netId: signal,
      layer: 'F.Cu',
      outline: ring(28, 2, 8, 6),
      priority: 2,
    }),
    pour({
      netId: gnd,
      layer: 'F.Cu',
      outline: polygon,
      holes: [ring(16, 9, 4, 3)],
      priority: 1,
      padConnection: 'yes',
    }),
    pour({
      netId: null,
      layer: 'F.Cu',
      outline: ring(22, 14, 3, 3),
      clearance: 0.2,
      keepout: { tracks: false, vias: false, pads: false, copperpour: true, footprints: false },
    }),
  ];
  board.tracks = [
    {
      id: uid(),
      netId: signal,
      layer: 'F.Cu',
      width: 0.4,
      start: { x: 6, y: 6 },
      end: { x: 18, y: 16 },
    },
  ];
  board.vias = [
    { id: uid(), netId: signal, x: 8, y: 18, diameter: 1.2, drill: 0.6 },
    { id: uid(), netId: signal, x: 180, y: 180, diameter: 1, drill: 0.5 },
  ];
  board.footprints = [
    footprint({
      x: 10,
      y: 12,
      rotation: 0,
      side: 'front',
      pads: [
        pad({
          x: 0,
          y: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 1.4, y: 1.4 },
          netId: gnd,
          zoneConnect: 1,
          thermalBridgeAngle: 20,
        }),
      ],
    }),
    footprint({
      x: -3,
      y: 8,
      rotation: 0,
      side: 'front',
      pads: [
        pad({
          x: 0,
          y: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 2, y: 2 },
          netId: signal,
          layers: ['F.Cu'],
        }),
      ],
    }),
    footprint({
      x: 24,
      y: 8,
      rotation: 10,
      side: 'front',
      pads: [
        pad({
          x: 0,
          y: 0,
          type: 'smd',
          shape: 'roundrect',
          size: { x: 2, y: 1.2 },
          netId: signal,
          roundrectRatio: 0.25,
        }),
      ],
    }),
    footprint({
      x: 12,
      y: 4,
      rotation: 0,
      side: 'front',
      pads: [
        pad({
          x: 0,
          y: 0,
          type: 'thru_hole',
          shape: 'circle',
          size: { x: 1.6, y: 1.6 },
          drill: 0.8,
          drillOffset: { x: 0.15, y: 0 },
          netId: signal,
        }),
      ],
    }),
  ];
  return board;
}

test('incremental refill matches a full refill on holes, thermals, keepouts and large outlines', () => {
  for (const corners of [4, 24]) {
    const filled = ownProjectData(fillCopperZones(makeBoard(corners)));
    const moved = edited(filled, (board) => {
      board.footprints[0].x += 0.6;
      board.footprints[1].x = 2;
    });
    const first = compareRefresh(filled, moved, schematic, `${corners} corners`);
    assert.notEqual(fillBytes(first.full), fillBytes(filled));
    const boundary: [string, (board: PCB) => void][] =
      corners === 4
        ? [
            [
              'clearance boundary',
              (board) => {
                board.footprints[1].x = -1.2;
              },
            ],
            [
              'clearance overlap',
              (board) => {
                board.footprints[1].x = -0.9;
              },
            ],
            [
              'clearance gap',
              (board) => {
                board.footprints[1].x = -1.8;
              },
            ],
            [
              'exact edge',
              (board) => {
                board.footprints[1].x = -1.25;
              },
            ],
            [
              'pad shape',
              (board) => {
                board.footprints[1].pads[0].shape = 'circle';
              },
            ],
            [
              'pad layer',
              (board) => {
                board.footprints[1].pads[0].layers = ['B.Cu'];
              },
            ],
          ]
        : [];
    const cases: [string, (board: PCB) => void][] = [
      ...boundary,
      [
        'thermal angle',
        (board) => {
          board.footprints[0].pads[0].thermalBridgeAngle = 70;
        },
      ],
      [
        'via net',
        (board) => {
          board.vias[0].netId = board.nets[0].id;
        },
      ],
      [
        'track net',
        (board) => {
          board.tracks[0].netId = board.nets[0].id;
        },
      ],
      [
        'roundrect ratio',
        (board) => {
          board.footprints[2].pads[0].roundrectRatio = 0.5;
        },
      ],
      [
        'drill offset',
        (board) => {
          board.footprints[3].pads[0].drillOffset = { x: 1.6, y: 0.4 };
        },
      ],
      [
        'zone hole',
        (board) => {
          board.zones[1].holes = [ring(16, 9, 5, 4)];
        },
      ],
      [
        'inward outline',
        (board) => {
          const edge = board.graphics[0];
          edge.kind = 'arc';
          edge.mid = { x: 20, y: 3 };
        },
      ],
    ];
    for (const [label, change] of cases) {
      const next = edited(moved, change);
      // A track-only edit bypasses reuse. Keep a footprint difference so the
      // track net is part of the cached input record.
      const previous = label === 'track net' ? filled : moved;
      const result = compareRefresh(previous, next, schematic, `${corners} ${label}`);
      assert.notEqual(fillBytes(result.full), fillBytes(first.full), `${corners} ${label} copper`);
    }
  }
});

test('randomized footprint drags match a full refill byte for byte', async () => {
  const projects = [
    'examples/project/emc-flyback/emc-flyback.kicad_pro',
    'examples/lmr12010-sot236-buck/lmr12010-sot236-buck.kicad_pro',
  ];
  for (const [index, path] of projects.entries()) {
    const project = await projectFromNativeFiles(await readNativeProject(path));
    let board = ownProjectData(project.pcb!);
    if (!zonesOf(board).some((zone) => zone.filledPolygons?.length))
      board = ownProjectData(fillCopperZones(board));
    const sample = random(20261112 + index);
    const footprints = board.footprints.filter(
      (footprint) =>
        !footprint.locked &&
        !footprint.graphics.some(
          (graphic) => graphic.layer.endsWith('.Cu') || graphic.layer === 'Edge.Cuts',
        ) &&
        !footprint.zones?.some((zone) => zone.keepout),
    );
    const picked = footprints
      .map((footprint) => ({ footprint, order: sample() }))
      .sort((left, right) => left.order - right.order)
      .slice(0, 8);
    assert.ok(picked.length >= 4, path);
    let compared = 0;
    for (const { footprint } of picked) {
      const engine = createPCBInteractiveDrag(board, [{ kind: 'footprint', id: footprint.id }], {
        clearance: 0.25,
      });
      for (const distance of [0.35, 1.4, 2.8]) {
        const angle = sample() * Math.PI * 2;
        const preview = engine.preview({
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
        });
        if (preview.error || preview.board === board) continue;
        const next = ownProjectData(preview.board, board);
        compareRefresh(
          board,
          next,
          project.schematic,
          `${path} ${footprint.reference ?? footprint.id} ${distance}`,
        );
        compared += 1;
      }
    }
    assert.ok(compared >= 4, `${path} compared ${compared}`);
  }
});
