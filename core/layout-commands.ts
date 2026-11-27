import { uid, type Point } from '../lib/circuit';
import { type BoardZone, type CopperLayer, type PCB } from '../lib/pcb';
import { pcbCopperLayers, pcbCopperStacks } from '../lib/pcb-layer-stack';
import {
  deletePCBSelection,
  findPCBGraphic,
  flipPCBSelection,
  movePCBSelection,
  previewPCBMove,
  replacePCBGraphic,
  rotatePCBSelection,
  setPCBTrackProperties,
  type PCBSelection,
} from '../lib/pcb-layout';
import { previewConstrainedPCBTrackDrag } from '../lib/pcb-track-drag';
import { createPCBInteractiveDrag } from '../lib/pcb-interactive-drag';
import { createPCBRouter } from '../lib/pcb-routing';
import { createPCBViaValidator } from '../lib/pcb-via-routing';
import { fillCopperZone, fillCopperZones } from '../lib/pcb-polygons';
import type { PCBFillRuleContext } from '../lib/pcb-clearance-sources';
import type { CoreDefinition } from './project-core';
import propertySchemas from './layout-property-schemas.json';
import {
  preparePCBFootprintProperties,
  preparePCBZoneProperties,
  setPCBPadProperties,
  setPCBTrackEndpoints,
  setPCBViaProperties,
} from '../lib/pcb-properties';
import {
  findPCBRectangle,
  resizePCBRectangle,
  setPCBRectangleWidth,
} from '../lib/pcb-outline-resize';
import { assertPCBLockedEdits, setPCBLocked } from '../lib/pcb-lock';
import { preparePCBRegionFillet } from '../lib/pcb-region-fillet';
import { layoutGridSpacingOptions } from '../lib/layout-grid';
import { suggestPCBPlacement } from '../lib/pcb-placement-suggestion';

// Property inputs derive from the same shapes as the full document validator.
// null explicitly clears an optional override; omission retains it.
const propertyShape = (schema: { properties: object; required: string[] }, excluded: string[]) =>
  Object.fromEntries(
    Object.entries(schema.properties)
      .filter(([key]) => !excluded.includes(key))
      .map(([key, value]) => [
        key,
        schema.required.includes(key) ? value : { anyOf: [value, { type: 'null' }] },
      ]),
  );
const propertyChanges = (input: Record<string, any>, nullableKeys: readonly string[] = []) =>
  Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      value === null && !nullableKeys.includes(key) ? undefined : value,
    ]),
  );

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
const layer = { enum: [...pcbCopperLayers] };
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
const placementInput = {
  footprintIds: { type: 'array', items: identity, minItems: 2, maxItems: 8, uniqueItems: true },
  spacing: { enum: [...layoutGridSpacingOptions] },
};
const placementPose = object(
  { id: identity, x: coordinate, y: coordinate, rotation: { type: 'number' } },
  ['id', 'x', 'y', 'rotation'],
);
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
    'layout.object',
    'Read one native board object, including editable properties, models and metadata, by stable ID.',
    { kind: { enum: ['footprint', 'pad', 'track', 'via', 'graphic', 'zone'] }, id: identity },
    ['kind', 'id'],
  ),
  definition(
    'layout.placement.preview',
    'Preview the same bounded placement suggestion as the Layout marquee. Pass the returned poses with the original inputs to layout.placement.apply.',
    placementInput,
    ['footprintIds', 'spacing'],
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
  operationCommand(
    'layout.placement.apply',
    'Apply an exact layout.placement.preview suggestion in one undo edit. The current board must still produce every supplied pose.',
    {
      ...placementInput,
      poses: { type: 'array', items: placementPose, minItems: 1, maxItems: 8, uniqueItems: true },
    },
    ['footprintIds', 'spacing', 'poses'],
  ),
  objectCommand(
    'layout.region.fillet',
    'Round every convex corner of one board zone or polygon graphic using native polygon vertices within 0.01 mm of circular fillets. Preserves cutouts and commits one undo edit.',
    { kind: { enum: ['zone', 'graphic'] }, id: identity, radius: positive },
    ['kind', 'id', 'radius'],
  ),
  objectCommand(
    'layout.lock',
    'Lock or unlock existing board objects or individual footprint pads in one undo transaction. Lock changes preserve saved fills.',
    {
      targets: {
        ...selection,
        minItems: 1,
        items: object(
          { kind: { enum: ['footprint', 'pad', 'track', 'via', 'graphic', 'zone'] }, id: identity },
          ['kind', 'id'],
        ),
      },
      locked: { type: 'boolean' },
    },
    ['targets', 'locked'],
  ),
  objectCommand(
    'layout.rectangle.resize',
    'Resize an Edge.Cuts rectangle or one zone and its holes through the shared canvas/Properties preparation.',
    {
      selection,
      bounds: object({ minX: coordinate, minY: coordinate, maxX: coordinate, maxY: coordinate }, [
        'minX',
        'minY',
        'maxX',
        'maxY',
      ]),
    },
    ['selection', 'bounds'],
  ),
  objectCommand(
    'layout.rectangle.properties',
    'Set line width on every native edge of a rectangular Edge.Cuts outline in one undo transaction. Selection may identify one edge or the complete rectangle.',
    { selection, width: { ...propertySchemas.graphic.properties.width, minimum: 0.0001 } },
    ['selection', 'width'],
  ),
  operationCommand(
    'layout.pose',
    'Commit a complete canvas pickup pose in one undo transaction. Apply ordered quarter-turn rotations and package flips around anchor, then translate anchor to target. Flip changes only selected footprints and reflects their origins across the horizontal anchor axis.',
    {
      selection,
      anchor: point,
      target: point,
      operations: {
        type: 'array',
        maxItems: 128,
        items: { enum: ['rotate', 'rotateReverse', 'flip'] },
      },
    },
    ['selection', 'anchor', 'target', 'operations'],
  ),
  objectCommand(
    'layout.move',
    'Move selected physical packages, copper, zones or artwork together.',
    { selection, delta: point },
    ['selection', 'delta'],
  ),
  operationCommand(
    'layout.drag',
    'Drag a footprint-only selection with its attached track ends using Walk Around, or drag tracks with connected chain reshaping (default Shove) or picked corner editing. Default exact placement rejects blocked poses; constrain explicitly accepts a checked boundary and reports its displacement.',
    {
      selection,
      delta: point,
      clearance,
      posture: { type: 'boolean' },
      obstacleMode: { enum: ['shove', 'walk-around'] },
      mode: { enum: ['connected', 'corner'] },
      pickup: point,
      endpointTolerance: { type: 'number', minimum: 0, maximum: 1000 },
      constrain: { type: 'boolean' },
      previousDelta: point,
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
    'Create or update a typed board zone with shared Properties preparation. Omitted fields are retained; null clears optional overrides (padConnection null restores thermal relief). netId null means unassigned. Refresh already-filled enabled zones in the same transaction.',
    {
      zoneId: identity,
      ...propertyShape(propertySchemas.zone, [
        'id',
        'locked',
        'filledPolygons',
        'nativeUnassignedFill',
        'nativeCircularOutline',
        'nativeOutlineArcs',
        'nativePlacement',
        'teardrop',
        'hatchPosition',
        'hatchFill',
      ]),
      outline: { ...propertySchemas.zone.properties.outline, minItems: 3 },
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
        enum: pcbCopperStacks.slice(0, 2),
      },
    },
  ),
  objectCommand(
    'layout.track.properties',
    'Edit a track net, layer, width, exact endpoints or lock. Unlock a locked track before changing its copper properties.',
    {
      trackId: identity,
      netId: identity,
      layer,
      width: positive,
      locked: { type: 'boolean' },
      start: point,
      end: point,
    },
    ['trackId'],
  ),
  objectCommand(
    'layout.pad.properties',
    'Edit pad geometry and fabrication overrides with the shared Properties preparation. Custom pads retain their polygon and shape; size describes their anchor. Identity, pin nets, type and layers stay unchanged. null clears an optional override.',
    {
      padId: identity,
      changes: object(
        propertyShape(propertySchemas.pad, [
          'id',
          'number',
          'netId',
          'type',
          'layers',
          'unconnected',
          'outline',
          'nativeCustomPad',
          'nativeConnect',
          'fabricationProperty',
          'locked',
          'teardrops',
        ]),
      ),
    },
    ['padId', 'changes'],
  ),
  objectCommand(
    'layout.via.properties',
    'Edit an existing via position, net, diameter or drill using Properties validation.',
    {
      viaId: identity,
      changes: object({
        ...propertyShape(propertySchemas.via, [
          'id',
          'locked',
          'teardrops',
          'span',
          'backdrills',
          'treatment',
          'free',
          'padstack',
          'removeUnusedLayers',
          'keepEndLayers',
          'startEndOnly',
          'zoneLayerConnections',
        ]),
        netId: identity,
      }),
    },
    ['viaId', 'changes'],
  ),
  objectCommand(
    'layout.footprint.properties',
    'Edit footprint placement, side, mechanical captions or complete model transforms. Side changes use the shared flip preparation. null clears optional models/overrides. Linked captions belong to part.properties.',
    {
      footprintId: identity,
      changes: object(
        propertyShape(propertySchemas.footprint, [
          'id',
          'symbolId',
          'libraryId',
          'nativeMissingReference',
          'nativeMissingValue',
          'pads',
          'graphics',
          'zones',
          'locked',
        ]),
      ),
    },
    ['footprintId', 'changes'],
  ),
  objectCommand(
    'layout.graphic',
    'Create a board graphic or replace an existing board graphic or footprint text. Updates retain the selected UUID and footprint ownership; query layout.object first to preserve unrelated metadata.',
    {
      graphicId: identity,
      graphic: {
        ...propertySchemas.graphic,
        properties: Object.fromEntries(
          Object.entries(propertySchemas.graphic.properties).filter(([key]) => key !== 'id'),
        ),
        required: propertySchemas.graphic.required.filter((key) => key !== 'id'),
      },
    },
    ['graphic'],
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
    zone: board.zones,
  };
  for (const selected of selection)
    if (
      selected.kind === 'graphic'
        ? !findPCBGraphic(board, selected.id)
        : !items[selected.kind].some((item) => item.id === selected.id)
    )
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

function preparePlacement(board: PCB, footprintIds: string[], spacing: number) {
  const selection = footprintIds.map((id) => ({ kind: 'footprint' as const, id }));
  checkSelection(board, selection);
  const suggestion = suggestPCBPlacement(board, selection, undefined, spacing);
  if (!suggestion) return null;
  const poses = suggestion.board.footprints
    .filter(({ id }) => suggestion.offsets.has(id))
    .map(({ id, x, y, rotation }) => ({ id, x, y, rotation }));
  return { board: suggestion.board, poses };
}

export function queryLayout(board: PCB | null | undefined, id: string, args: Record<string, any>) {
  checkBoard(board, args.boardId);
  if (id === 'layout.placement.preview')
    return { poses: preparePlacement(board, args.footprintIds, args.spacing)?.poses ?? [] };
  if (id === 'layout.object') {
    const items = {
      footprint: board.footprints,
      pad: board.footprints.flatMap((item) => item.pads),
      track: [...board.tracks, ...(board.arcTracks ?? [])],
      via: board.vias,
      graphic: board.graphics,
      zone: board.zones,
    };
    const item =
      args.kind === 'graphic'
        ? findPCBGraphic(board, args.id)?.graphic
        : items[args.kind as keyof typeof items].find((item) => item.id === args.id);
    if (!item) throw new Error('This board object no longer exists.');
    return structuredClone(item);
  }
  if (id === 'layout.get')
    return {
      boardId: board.id,
      layers: [...board.layers],
      thickness: board.thickness,
      counts: {
        packages: board.footprints.length,
        tracks: board.tracks.length + (board.arcTracks?.length ?? 0),
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
  fillRules?: PCBFillRuleContext,
): { board: PCB; result?: Record<string, unknown> } {
  checkBoard(board, args.boardId);
  if (args.selection) checkSelection(board, args.selection);
  let next = board;
  let result: Record<string, unknown> | undefined;
  switch (id) {
    case 'layout.placement.apply': {
      const suggestion = preparePlacement(board, args.footprintIds, args.spacing);
      if (
        !suggestion ||
        suggestion.poses.length !== args.poses.length ||
        suggestion.poses.some(({ id, x, y, rotation }, index) => {
          const pose = args.poses[index];
          return pose.id !== id || pose.x !== x || pose.y !== y || pose.rotation !== rotation;
        })
      )
        throw new Error('The placement suggestion changed. Preview it again before applying.');
      next = suggestion.board;
      result = { poses: suggestion.poses };
      break;
    }
    case 'layout.region.fillet':
      next = preparePCBRegionFillet(board, { kind: args.kind, id: args.id }, args.radius);
      break;
    case 'layout.lock':
      next = setPCBLocked(board, args.targets, args.locked);
      break;
    case 'layout.move':
      next = movePCBSelection(board, args.selection, args.delta);
      break;
    case 'layout.pose':
      next = previewPCBMove(board, args.selection, args.anchor, args.target, args.operations);
      break;
    case 'layout.rotate':
      next = rotatePCBSelection(board, args.selection, args.degrees, args.pivot);
      break;
    case 'layout.flip':
      next = flipPCBSelection(board, args.selection);
      break;
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
        const ownedText = item.kind === 'graphic' ? findPCBGraphic(board, item.id) : undefined;
        if (ownedText?.owner) {
          const { owner, graphic } = ownedText;
          if (
            graphic.text?.property ||
            selected.some((item) => item.kind === 'footprint' && item.id === owner.id)
          )
            continue;
          const copy = freshIds(graphic);
          next.footprints = next.footprints.map((f) =>
            f.id === owner.id ? { ...f, graphics: [...f.graphics, copy] } : f,
          );
          copies.push({ ...item, id: copy.id });
          continue;
        }
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
      if (args.previousDelta && !args.constrain)
        throw new Error('A previous drag displacement requires constrain to be enabled.');
      const engine = createPCBInteractiveDrag(board, selected, {
        clearance: args.clearance,
        obstacleMode: args.obstacleMode,
        mode: args.mode,
        pickup: args.pickup,
        endpointTolerance: args.endpointTolerance,
      });
      const preview = args.constrain
        ? previewConstrainedPCBTrackDrag(
            engine,
            board,
            args.delta,
            args.posture,
            args.previousDelta,
          )
        : engine.preview(args.delta, args.posture);
      if (preview.error) throw new Error(preview.error);
      next = preview.board;
      result = {
        changedIds: preview.changedIds,
        requestedDelta: args.delta,
        appliedDelta: preview.constraint?.appliedDelta ?? args.delta,
        constrained: Boolean(preview.constraint),
        ...(preview.constraint ? { constraintReason: preview.constraint.reason } : {}),
      };
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
      const zone = preparePCBZoneProperties(
        existing ??
          ({
            id: uid(),
            clearance: changes.keepout ? 0 : 0.25,
            minThickness: 0.2,
            thermalGap: 0.3,
            thermalBridge: 0.3,
            fillEnabled: true,
          } as BoardZone),
        propertyChanges(changes, ['netId']),
      );
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
        ? fillCopperZone(board, args.zoneId, args.clearance, fillRules)
        : fillCopperZones(board, args.clearance, fillRules);
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
      const { boardId: _boardId, trackId, start, end, ...changes } = args;
      next = setPCBTrackProperties(board, trackId, changes);
      if (start || end) next = setPCBTrackEndpoints(next, trackId, { start, end });
      break;
    }
    case 'layout.rectangle.resize':
    case 'layout.rectangle.properties': {
      checkSelection(board, args.selection);
      const rectangle = findPCBRectangle(board, args.selection);
      if (!rectangle) throw new Error('Select a rectangular outline or one board zone.');
      next =
        id === 'layout.rectangle.resize'
          ? resizePCBRectangle(board, rectangle, args.bounds)
          : setPCBRectangleWidth(board, rectangle, args.width);
      break;
    }
    case 'layout.pad.properties':
      next = setPCBPadProperties(board, args.padId, propertyChanges(args.changes));
      break;
    case 'layout.via.properties': {
      next = setPCBViaProperties(board, args.viaId, args.changes);
      break;
    }
    case 'layout.footprint.properties': {
      const existing = board.footprints.find((footprint) => footprint.id === args.footprintId);
      if (!existing) throw new Error('This footprint no longer exists.');
      if (
        existing.symbolId &&
        (Object.hasOwn(args.changes, 'reference') || Object.hasOwn(args.changes, 'value'))
      )
        throw new Error('Edit linked component captions through part.properties.');
      const footprint = preparePCBFootprintProperties(existing, propertyChanges(args.changes));
      next = {
        ...board,
        footprints: board.footprints.map((item) => (item === existing ? footprint : item)),
      };
      break;
    }
    case 'layout.graphic': {
      const graphic = { ...args.graphic, id: args.graphicId ?? uid() };
      next = args.graphicId
        ? replacePCBGraphic(board, graphic)
        : { ...board, graphics: [...board.graphics, graphic] };
      result = { graphicId: graphic.id };
      break;
    }
    default:
      throw new Error(`Unknown Layout command: ${id}.`);
  }
  assertPCBLockedEdits(board, next);
  return { board: next, ...(result ? { result } : {}) };
}
