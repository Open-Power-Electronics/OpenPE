import { uid, type Point } from '../lib/circuit';
import { type BoardZone, type CopperLayer, type PCB } from '../lib/pcb';
import {
  deletePCBSelection,
  flipPCBFootprint,
  movePCBSelection,
  rotatePCBSelection,
  setPCBTrackProperties,
  type PCBSelection,
} from '../lib/pcb-layout';
import { createPCBTrackDrag } from '../lib/pcb-track-drag';
import { createPCBRouter } from '../lib/pcb-routing';
import { createPCBViaValidator } from '../lib/pcb-via-routing';
import { fillCopperZone, fillCopperZones } from '../lib/pcb-polygons';
import type { CoreDefinition } from './project-core';

const identity = { type: 'string', minLength: 1, maxLength: 200 };
const coordinate = { type: 'number', minimum: -100000, maximum: 100000 };
const positive = { type: 'number', exclusiveMinimum: 0, maximum: 1000 };
const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const point = object({ x: coordinate, y: coordinate }, ['x', 'y']);
const layer = { enum: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] };
const board = { boardId: identity };
const selection = {
  type: 'array',
  maxItems: 30000,
  uniqueItems: true,
  items: object(
    { kind: { enum: ['footprint', 'track', 'via', 'graphic', 'zone'] }, id: identity },
    ['kind', 'id'],
  ),
};
const clearance = { type: 'number', minimum: 0.05, maximum: 20 };
const via = object(
  {
    diameter: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
    drill: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
  },
  ['diameter', 'drill'],
);
const definition = (
  id: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): CoreDefinition => ({
  id,
  description,
  inputSchema: object({ ...board, ...properties }, ['boardId', ...required]),
});
const objectCommand = (...args: Parameters<typeof definition>): CoreDefinition => ({
  ...definition(...args),
  level: 'object',
});
const operationCommand = (...args: Parameters<typeof definition>): CoreDefinition => ({
  ...definition(...args),
  level: 'operation',
});
export const layoutQueryDefinitions: CoreDefinition[] = [
  definition(
    'layout.get',
    'Read the full canonical project containing the board, physical packages, nets and artwork, plus board counts.',
  ),
  definition(
    'layout.route.preview',
    'Plan one bounded Walk Around route using all board obstacles without changing the document.',
    {
      netId: identity,
      layer,
      width: positive,
      clearance,
      start: point,
      end: point,
      mode: { enum: ['straight', '45'] },
      posture: { type: 'boolean' },
    },
    ['netId', 'layer', 'width', 'clearance', 'start', 'end'],
  ),
];
export const layoutCommandDefinitions: CoreDefinition[] = [
  objectCommand(
    'layout.move',
    'Move selected physical packages, copper, zones or artwork together.',
    { selection, delta: point },
    ['selection', 'delta'],
  ),
  operationCommand(
    'layout.drag',
    'Drag selected tracks while preserving attached copper. Default Shove displaces nearby tracks; Walk Around keeps obstacles fixed.',
    {
      selection,
      delta: point,
      clearance,
      posture: { type: 'boolean' },
      obstacleMode: { enum: ['shove', 'walk-around'] },
    },
    ['selection', 'delta', 'clearance'],
  ),
  objectCommand(
    'layout.rotate',
    'Rotate selected board objects around a supplied group pivot or their own centers.',
    { selection, degrees: { type: 'number' }, pivot: point },
    ['selection'],
  ),
  objectCommand(
    'layout.flip',
    'Flip selected physical packages to the other board side, preserving package-local geometry and models.',
    { selection },
    ['selection'],
  ),
  objectCommand(
    'layout.delete',
    'Delete selected board objects; removing a linked package clears its schematic assignment in the same edit.',
    { selection },
    ['selection'],
  ),
  objectCommand(
    'layout.duplicate',
    'Duplicate copper, artwork, zones or unlinked mechanical packages with fresh IDs. Assigned packages must be placed from their schematic component.',
    { selection, delta: point },
    ['selection', 'delta'],
  ),
  operationCommand(
    'layout.route',
    'Validate and commit complete same-net route legs and through-via transitions as one transaction. Use layout.route.preview to plan a leg.',
    {
      netId: identity,
      width: positive,
      clearance,
      legs: {
        type: 'array',
        minItems: 1,
        maxItems: 65,
        items: object(
          { layer, points: { type: 'array', minItems: 1, maxItems: 15000, items: point }, via },
          ['layer', 'points'],
        ),
      },
    },
    ['netId', 'width', 'clearance', 'legs'],
  ),
  objectCommand(
    'layout.via',
    'Place a through via after shared all-layer copper, hole and keepout checks.',
    { netId: identity, position: point, diameter: positive, drill: positive, clearance },
    ['netId', 'position', 'diameter', 'drill', 'clearance'],
  ),
  objectCommand(
    'layout.zone',
    'Create or update a typed board zone, preserving other metadata and invalidating affected saved fills.',
    {
      zoneId: identity,
      netId: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      layer,
      outline: { type: 'array', items: point, minItems: 3, maxItems: 60000 },
      holes: {
        type: 'array',
        maxItems: 30000,
        items: { type: 'array', minItems: 3, maxItems: 60000, items: point },
      },
      clearance: { type: 'number', minimum: 0, maximum: 1000 },
      minThickness: positive,
      thermalGap: positive,
      thermalBridge: positive,
      priority: { type: 'integer', minimum: 0, maximum: 100 },
      padConnection: { enum: ['yes', 'no', 'thru_hole_only'] },
      islandRemovalMode: { type: 'integer', minimum: 0, maximum: 2 },
      fillEnabled: { type: 'boolean' },
      keepout: object(
        {
          tracks: { type: 'boolean' },
          vias: { type: 'boolean' },
          pads: { type: 'boolean' },
          copperpour: { type: 'boolean' },
          footprints: { type: 'boolean' },
        },
        ['tracks', 'vias', 'pads', 'copperpour', 'footprints'],
      ),
    },
  ),
  operationCommand(
    'layout.fill',
    'Fill board copper zones, or enable and fill one selected zone, preserving larger zone clearances.',
    { zoneId: identity, clearance: { type: 'number', minimum: 0.0001, maximum: 1000 } },
  ),
  objectCommand(
    'layout.net',
    'Create a named board net without changing schematic connectivity.',
    { name: { type: 'string', minLength: 1, maxLength: 200 } },
    ['name'],
  ),
  objectCommand(
    'layout.properties',
    'Set board thickness or two/four-layer stack, subject to complete project validation.',
    {
      thickness: positive,
      layers: {
        enum: [
          ['F.Cu', 'B.Cu'],
          ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'],
        ],
      },
    },
  ),
  objectCommand(
    'layout.track.properties',
    'Edit a track net, layer, width or lock. Unlock a locked track before changing its copper properties.',
    { trackId: identity, netId: identity, layer, width: positive, locked: { type: 'boolean' } },
    ['trackId'],
  ),
];

function checkBoard(board: PCB | null | undefined, id: string): asserts board is PCB {
  if (!board || board.id !== id)
    throw new Error(
      'This board is no longer in the project. Query the current project and try again.',
    );
}
function checkSelection(board: PCB, selection: PCBSelection[]) {
  const items = {
    footprint: board.footprints,
    track: board.tracks,
    via: board.vias,
    graphic: board.graphics,
    zone: board.zones,
  };
  for (const selected of selection)
    if (!items[selected.kind].some((item) => item.id === selected.id))
      throw new Error(
        'A selected board object no longer exists. Query the current board and try again.',
      );
}
function freshIds<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (key === 'id') (item as Record<string, unknown>)[key] = uid();
      else visit(child);
    }
  };
  visit(copy);
  return copy;
}
const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 0.000001;

export function queryLayout(board: PCB | null | undefined, id: string, args: Record<string, any>) {
  checkBoard(board, args.boardId);
  if (id === 'layout.get')
    return {
      boardId: board.id,
      layers: [...board.layers],
      thickness: board.thickness,
      counts: {
        packages: board.footprints.length,
        tracks: board.tracks.length,
        vias: board.vias.length,
        zones: board.zones.length,
        graphics: board.graphics.length,
        nets: board.nets.length,
      },
    };
  const router = createPCBRouter(board, {
    netId: args.netId,
    layer: args.layer,
    width: args.width,
    clearance: args.clearance,
  });
  return router.route(args.start, args.end, args.mode, args.posture);
}

export function executeLayout(
  board: PCB | null | undefined,
  id: string,
  args: Record<string, any>,
): { board: PCB; result?: Record<string, unknown> } {
  checkBoard(board, args.boardId);
  if (args.selection) checkSelection(board, args.selection);
  let next = board;
  let result: Record<string, unknown> | undefined;
  switch (id) {
    case 'layout.move':
      next = movePCBSelection(board, args.selection, args.delta);
      break;
    case 'layout.rotate':
      next = rotatePCBSelection(board, args.selection, args.degrees, args.pivot);
      break;
    case 'layout.flip': {
      const ids = new Set(
        (args.selection as PCBSelection[])
          .filter((item) => item.kind === 'footprint')
          .map((item) => item.id),
      );
      next = {
        ...board,
        footprints: board.footprints.map((footprint) =>
          ids.has(footprint.id) ? flipPCBFootprint(footprint) : footprint,
        ),
      };
      break;
    }
    case 'layout.delete':
      next = deletePCBSelection(board, args.selection);
      break;
    case 'layout.duplicate': {
      const selected = args.selection as PCBSelection[];
      if (
        board.footprints.some(
          (footprint) =>
            footprint.symbolId &&
            selected.some((item) => item.kind === 'footprint' && item.id === footprint.id),
        )
      )
        throw new Error(
          'Assigned physical packages cannot be duplicated. Add a schematic component and assign its footprint first.',
        );
      const collection = {
        footprint: 'footprints',
        track: 'tracks',
        via: 'vias',
        graphic: 'graphics',
        zone: 'zones',
      } as const;
      const copies: PCBSelection[] = [];
      next = { ...board };
      for (const item of selected) {
        const key = collection[item.kind];
        const original = board[key].find((entry) => entry.id === item.id)!;
        const copy = freshIds(original);
        copies.push({ ...item, id: copy.id });
        Object.assign(next, { [key]: [...next[key], copy] });
      }
      next = movePCBSelection(next, copies, args.delta);
      result = { selection: copies };
      break;
    }
    case 'layout.drag': {
      const selected = args.selection as PCBSelection[];
      if (selected.some((item) => item.kind !== 'track'))
        throw new Error('Connected Layout drag requires track selections.');
      const preview = createPCBTrackDrag(board, selected, {
        clearance: args.clearance,
        obstacleMode: args.obstacleMode ?? 'shove',
      }).preview(args.delta, args.posture);
      if (preview.error) throw new Error(preview.error);
      next = preview.board;
      result = { changedIds: preview.changedIds };
      break;
    }
    case 'layout.route': {
      const legs = args.legs as {
        layer: CopperLayer;
        points: Point[];
        via?: { diameter: number; drill: number };
      }[];
      if (legs.reduce((count, leg) => count + leg.points.length, 0) > 15000)
        throw new Error('Routing exceeds the geometry limit. Finish a shorter route.');
      const vias: PCB['vias'] = [];
      for (let index = 0; index < legs.length; index++) {
        const leg = legs[index],
          following = legs[index + 1];
        if (following) {
          if (
            !leg.via ||
            leg.layer === following.layer ||
            !same(leg.points.at(-1)!, following.points[0])
          )
            throw new Error(
              'Each route layer transition needs a through via at the shared leg endpoint.',
            );
          vias.push({ id: uid(), ...leg.points.at(-1)!, ...leg.via, netId: args.netId });
        } else if (leg.via)
          throw new Error('The final route leg cannot contain an unfinished layer transition.');
      }
      let work = 0;
      const spend = () => {
        if (++work > 2_000_000)
          throw new Error('Routing exceeds the geometry limit. Finish a shorter route.');
      };
      for (const leg of legs) {
        const issue = createPCBRouter(board, {
          layer: leg.layer,
          width: args.width,
          netId: args.netId,
          clearance: args.clearance,
        }).validate(leg.points, spend);
        if (issue) throw new Error(issue);
      }
      for (const via of vias) {
        const issue = createPCBViaValidator(
          { ...board, vias: [...board.vias, ...vias.filter((other) => other !== via)] },
          {
            netId: args.netId,
            diameter: via.diameter,
            drill: via.drill,
            clearance: args.clearance,
          },
        ).validate(via, spend);
        if (issue) throw new Error(issue);
      }
      const tracks = legs.flatMap((leg) =>
        leg.points.slice(1).flatMap((end, index) =>
          same(leg.points[index], end)
            ? []
            : [
                {
                  id: uid(),
                  start: leg.points[index],
                  end,
                  layer: leg.layer,
                  width: args.width,
                  netId: args.netId,
                },
              ],
        ),
      );
      next = { ...board, tracks: [...board.tracks, ...tracks], vias: [...board.vias, ...vias] };
      result = { trackIds: tracks.map((track) => track.id), viaIds: vias.map((via) => via.id) };
      break;
    }
    case 'layout.via': {
      const issue = createPCBViaValidator(board, {
        netId: args.netId,
        diameter: args.diameter,
        drill: args.drill,
        clearance: args.clearance,
      }).validate(args.position);
      if (issue) throw new Error(issue);
      const via = {
        id: uid(),
        ...args.position,
        diameter: args.diameter,
        drill: args.drill,
        netId: args.netId,
      };
      next = { ...board, vias: [...board.vias, via] };
      result = { viaId: via.id };
      break;
    }
    case 'layout.zone': {
      const { boardId: _boardId, zoneId, ...changes } = args;
      const existing = zoneId ? board.zones.find((zone) => zone.id === zoneId) : undefined;
      if (zoneId && !existing)
        throw new Error('This board zone no longer exists. Query the current board and try again.');
      if (!existing && (!changes.outline || !changes.layer || !Object.hasOwn(changes, 'netId')))
        throw new Error('A new zone needs an outline, layer and netId (or null for a keepout).');
      const zone = {
        id: uid(),
        clearance: 0.25,
        minThickness: 0.2,
        thermalGap: 0.3,
        thermalBridge: 0.3,
        fillEnabled: true,
        ...existing,
        ...changes,
      } as BoardZone;
      next = {
        ...board,
        zones: existing
          ? board.zones.map((item) => (item.id === existing.id ? zone : item))
          : [...board.zones, zone],
      };
      result = { zoneId: zone.id };
      break;
    }
    case 'layout.fill':
      next = args.zoneId
        ? fillCopperZone(board, args.zoneId, args.clearance)
        : fillCopperZones(board, args.clearance);
      break;
    case 'layout.net': {
      const name = args.name.trim();
      if (!name || board.nets.some((net) => net.name === name))
        throw new Error('Choose a unique, non-empty board net name.');
      const net = { id: uid(), name };
      next = { ...board, nets: [...board.nets, net] };
      result = { netId: net.id };
      break;
    }
    case 'layout.properties':
      next = {
        ...board,
        ...(args.thickness !== undefined ? { thickness: args.thickness } : {}),
        ...(args.layers ? { layers: args.layers } : {}),
      };
      break;
    case 'layout.track.properties': {
      if (!board.tracks.some((track) => track.id === args.trackId))
        throw new Error(
          'This board track no longer exists. Query the current board and try again.',
        );
      const { boardId: _boardId, trackId, ...changes } = args;
      next = setPCBTrackProperties(board, trackId, changes);
      break;
    }
    default:
      throw new Error(`Unknown Layout command: ${id}.`);
  }
  return { board: next, ...(result ? { result } : {}) };
}
