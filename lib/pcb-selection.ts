import type { Point } from './circuit';
import {
  resolvePCBGraphic,
  type BoardLayer,
  type BoardLine,
  type BoardText,
  type BoardZone,
  type Footprint,
  type PCB,
} from './pcb';
import {
  pcbDisplayForLayer,
  pcbFootprintBodyBounds,
  pcbReadableTextAngle,
  type PCBDisplay,
} from './pcb-display';
import { pcbArc } from './pcb-geometry';
import { findPCBGraphic, footprintPoint, padPosition, type PCBSelection } from './pcb-layout';
import { padCopperLayers } from './pcb-connectivity';
import { filledCopperPolygons, padPolygon, type Polygon } from './pcb-polygons';
import { isOwnedPCB } from './immutable-project';
import { pcbStrokeText } from './pcb-stroke-text';

export type PCBSelectionFilters = Record<PCBSelection['kind'], boolean> & {
  pad?: boolean;
  text?: boolean;
  dimension?: boolean;
  ruleArea?: boolean;
  locked?: boolean;
  /** Reserved display categories without independently selectable objects. */
  other?: boolean;
  point?: boolean;
};

/** Per-editor presentation defaults; each caller receives an independent mutable wrapper. */
export function defaultPCBSelectionFilters(): Required<PCBSelectionFilters> {
  return {
    footprint: true,
    track: true,
    via: true,
    graphic: true,
    zone: true,
    pad: true,
    text: true,
    dimension: true,
    ruleArea: true,
    locked: false,
    other: false,
    point: false,
  };
}

/** Omitted additive filters retain the original combined graphic/zone behavior. */
export function pcbGraphicSelectionEligible(graphic: BoardLine, filters: PCBSelectionFilters) {
  if (graphic.locked && filters.locked === false) return false;
  if (graphic.kind === 'text') return filters.text ?? filters.graphic;
  if (graphic.kind === 'dimension') return filters.dimension ?? filters.graphic;
  return filters.graphic;
}

export function pcbZoneSelectionEligible(zone: BoardZone, filters: PCBSelectionFilters) {
  if (zone.locked && filters.locked === false) return false;
  return zone.keepout ? (filters.ruleArea ?? filters.zone) : filters.zone;
}

/** Category eligibility is independent of layer visibility, electrical targets and edit locks. */
export function pcbSelectionEligible(
  board: PCB,
  selection: PCBSelection,
  filters: PCBSelectionFilters,
): boolean {
  switch (selection.kind) {
    case 'footprint':
      return (
        filters.footprint &&
        board.footprints.some(
          (item) => item.id === selection.id && (!item.locked || filters.locked !== false),
        )
      );
    case 'track': {
      const track = board.tracks.find((item) => item.id === selection.id);
      return !!track && filters.track && (!track.locked || filters.locked !== false);
    }
    case 'via':
      return (
        filters.via &&
        board.vias.some(
          (item) => item.id === selection.id && (!item.locked || filters.locked !== false),
        )
      );
    case 'graphic': {
      const hit = findPCBGraphic(board, selection.id);
      return (
        !!hit &&
        (!hit.owner ||
          (!hit.graphic.text?.hidden && (!hit.owner.locked || filters.locked !== false))) &&
        pcbGraphicSelectionEligible(hit.graphic, filters)
      );
    }
    case 'zone': {
      const zone = board.zones.find((item) => item.id === selection.id);
      return !!zone && pcbZoneSelectionEligible(zone, filters);
    }
  }
}
export type PCBSelectionMode = 'replace' | 'add' | 'toggle' | 'subtract';
export type PCBPointSelectionOptions = {
  preparedFills?: ReadonlyMap<string, Polygon[]>;
  includeFills?: boolean;
  /** Prefer eligible hits on this visible layer before other visible geometry. */
  priorityLayer?: BoardLayer;
  /** Closed board regions can be picked through their interior behind precise objects. */
  includeRegionInteriors?: boolean;
  /** Eligible DOM body, caption and outline hits, excluding saved-fill targets. */
  preciseCandidates?: readonly PCBSelection[];
  /** Current resolved captions, keyed by the original text UUID. */
  footprintTextValues?: ReadonlyMap<string, string>;
  /** Read-only pad inspection can suppress broad fill fallback without selecting its owner. */
  hasPrecisePad?: boolean;
};
type Rectangle = { minX: number; minY: number; maxX: number; maxY: number };
type Shape = { paths: Point[][]; polygons: Polygon[]; radius: number };
const epsilon = 1e-9;
const noCopperFills: ReadonlyMap<string, Polygon[]> = new Map();
const ownedPointObjects = new WeakMap<PCB, ReturnType<typeof createPointObjects>>();
const ownedPointTracks = new WeakMap<PCB, Map<string, PCB['tracks'][number]>>();
function pointTracks(board: PCB): Map<string, PCB['tracks'][number]> {
  if (!isOwnedPCB(board)) return new Map(board.tracks.map((track) => [track.id, track]));
  let tracks = ownedPointTracks.get(board);
  if (!tracks) {
    tracks = new Map(board.tracks.map((track) => [track.id, track]));
    ownedPointTracks.set(board, tracks);
  }
  return tracks;
}
function createPointObjects(board: PCB) {
  return {
    footprints: new Map(board.footprints.map((item) => [item.id, item])),
    tracks: pointTracks(board),
    vias: new Map(board.vias.map((item) => [item.id, item])),
    graphics: new Map(board.graphics.map((item) => [item.id, item])),
    zones: new Map(board.zones.map((item) => [item.id, item])),
    pads: new Map(
      board.footprints.flatMap((owner) =>
        owner.pads.map((pad) => [pad.id, { owner, pad }] as const),
      ),
    ),
  };
}
function pointObjects(board: PCB) {
  if (!isOwnedPCB(board)) return createPointObjects(board);
  let result = ownedPointObjects.get(board);
  if (!result) {
    result = createPointObjects(board);
    ownedPointObjects.set(board, result);
  }
  return result;
}

function pointPadLayers(board: PCB, owner: Footprint, pad: Footprint['pads'][number]) {
  return pad.type === 'np_thru_hole' ? ['Edge.Cuts'] : padCopperLayers(board, owner, pad);
}

/** Pad inspection uses the same visible copper geometry and margin as point selection. */
export function selectPCBPadPoint(
  board: PCB,
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  at: Point,
  tolerance: number,
): string[] {
  if (!layers.footprints || !filters.pad) return [];
  const ids: string[] = [];
  for (const owner of board.footprints) {
    if (owner.locked && filters.locked === false) continue;
    for (const pad of owner.pads) {
      if (pad.locked && filters.locked === false) continue;
      const center = padPosition(owner, pad);
      if (
        Math.hypot(at.x - center.x, at.y - center.y) >
        Math.hypot(pad.size.x, pad.size.y) / 2 + tolerance + epsilon
      )
        continue;
      if (!pointPadLayers(board, owner, pad).some((layer) => layers[layer as BoardLayer])) continue;
      const { outer } = padPolygon(owner, pad);
      if (
        inContour(at, outer) ||
        outer.some(
          (p, i) => pointDistance(at, p, outer[(i + 1) % outer.length]) <= tolerance + epsilon,
        )
      )
        ids.push(pad.id);
    }
  }
  return ids;
}
const corners = (r: Rectangle): Point[] => [
  { x: r.minX, y: r.minY },
  { x: r.maxX, y: r.minY },
  { x: r.maxX, y: r.maxY },
  { x: r.minX, y: r.maxY },
];
const inside = (p: Point, r: Rectangle, margin = 0) =>
  p.x - margin >= r.minX - epsilon &&
  p.x + margin <= r.maxX + epsilon &&
  p.y - margin >= r.minY - epsilon &&
  p.y + margin <= r.maxY + epsilon;
const closed = (points: Point[]) => (points.length ? [...points, points[0]] : []);
function pointDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}
function crosses(a: Point, b: Point, c: Point, d: Point) {
  const orient = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const ac = orient(a, b, c),
    ad = orient(a, b, d),
    ca = orient(c, d, a),
    cb = orient(c, d, b);
  if (((ac > 0 && ad < 0) || (ac < 0 && ad > 0)) && ((ca > 0 && cb < 0) || (ca < 0 && cb > 0)))
    return true;
  return (
    pointDistance(a, c, d) <= epsilon ||
    pointDistance(b, c, d) <= epsilon ||
    pointDistance(c, a, b) <= epsilon ||
    pointDistance(d, a, b) <= epsilon
  );
}
function segmentTouches(a: Point, b: Point, rectangle: Rectangle, radius: number) {
  if (inside(a, rectangle) || inside(b, rectangle)) return true;
  const points = corners(rectangle);
  return points.some((c, i) => {
    const d = points[(i + 1) % points.length];
    return (
      crosses(a, b, c, d) ||
      Math.min(
        pointDistance(a, c, d),
        pointDistance(b, c, d),
        pointDistance(c, a, b),
        pointDistance(d, a, b),
      ) <=
        radius + epsilon
    );
  });
}
function inContour(p: Point, points: Point[]) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (pointDistance(p, a, b) <= epsilon) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      result = !result;
  }
  return result;
}
function shapeMatches(shape: Shape, rectangle: Rectangle, contained: boolean) {
  const contours = shape.polygons.flatMap((p) => [p.outer, ...p.holes]);
  const paths = [...shape.paths, ...contours.map(closed)];
  if (contained) {
    const points = paths.flat();
    return points.length > 0 && points.every((p) => inside(p, rectangle, shape.radius));
  }
  if (
    paths.some((points) =>
      points.some((p, i) => i > 0 && segmentTouches(points[i - 1], p, rectangle, shape.radius)),
    )
  )
    return true;
  return shape.polygons.some((polygon) =>
    corners(rectangle).some(
      (p) => inContour(p, polygon.outer) && !polygon.holes.some((hole) => inContour(p, hole)),
    ),
  );
}
function diskMatches(at: Point, radius: number, rectangle: Rectangle, contained: boolean) {
  if (contained) return inside(at, rectangle, radius);
  const x = Math.max(rectangle.minX, Math.min(rectangle.maxX, at.x)),
    y = Math.max(rectangle.minY, Math.min(rectangle.maxY, at.y));
  return Math.hypot(at.x - x, at.y - y) <= radius + epsilon;
}
function circleMatches(g: BoardLine, rectangle: Rectangle, contained: boolean) {
  const radius = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
  if (!diskMatches(g.start, radius + g.width / 2, rectangle, contained)) return false;
  if (contained || g.fill) return true;
  // A crossing window completely inside an unfilled circle touches no artwork.
  return corners(rectangle).some(
    (p) => Math.hypot(p.x - g.start.x, p.y - g.start.y) >= radius - g.width / 2 - epsilon,
  );
}
function textContour(text: BoardText, at: Point): Point[] {
  const lines = text.value.split('\n'),
    width = Math.max(...lines.map((line) => Array.from(line).length), 0) * text.size.x * 0.7,
    height = text.size.y * (1 + (lines.length - 1) * 1.25);
  if (!width || text.hidden) return [];
  const minX = text.justify?.includes('left')
      ? 0
      : text.justify?.includes('right')
        ? -width
        : -width / 2,
    minY = text.justify?.includes('top')
      ? 0
      : text.justify?.includes('bottom')
        ? -height
        : -text.size.y / 2;
  const radians = (-text.rotation * Math.PI) / 180;
  return corners({ minX, minY, maxX: minX + width, maxY: minY + height }).map((p) => {
    const x = text.justify?.includes('mirror') ? -p.x : p.x;
    return {
      x: at.x + x * Math.cos(radians) - p.y * Math.sin(radians),
      y: at.y + x * Math.sin(radians) + p.y * Math.cos(radians),
    };
  });
}
function resolvedFootprintText(
  owner: Footprint,
  graphic: BoardLine,
  values?: ReadonlyMap<string, string>,
) {
  const text = graphic.text!;
  const value =
    values?.get(graphic.id) ??
    resolvePCBGraphic(graphic, owner.reference ?? '', owner.value ?? '').text!.value;
  return {
    ...text,
    value,
    rotation: pcbReadableTextAngle(text.rotation + owner.rotation) - owner.rotation,
  };
}

function footprintTextContour(
  owner: Footprint,
  graphic: BoardLine,
  values?: ReadonlyMap<string, string>,
) {
  return textContour(resolvedFootprintText(owner, graphic, values), graphic.start).map((p) =>
    footprintPoint(owner, p),
  );
}

function selectFootprintText(
  board: PCB,
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  rectangle: Rectangle,
  contained: boolean,
  values?: ReadonlyMap<string, string>,
  coveredOwners?: ReadonlySet<string>,
): PCBSelection[] {
  if (!layers.footprints || !(filters.text ?? filters.graphic)) return [];
  const selected: PCBSelection[] = [];
  for (const owner of board.footprints) {
    if (coveredOwners?.has(owner.id) || (owner.locked && filters.locked === false)) continue;
    for (const graphic of owner.graphics) {
      if (
        graphic.kind !== 'text' ||
        graphic.text?.hidden ||
        !layers[graphic.layer] ||
        !pcbGraphicSelectionEligible(graphic, filters)
      )
        continue;
      const outer = footprintTextContour(owner, graphic, values);
      if (
        outer.length &&
        shapeMatches(
          { paths: [], polygons: [{ outer, holes: [] }], radius: 0 },
          rectangle,
          contained,
        )
      )
        selected.push({ kind: 'graphic', id: graphic.id });
    }
  }
  return selected;
}

function graphicShape(g: BoardLine): Shape {
  if (g.kind === 'text') {
    const outer = g.text ? textContour(g.text, g.start) : [];
    return { paths: [], polygons: outer.length ? [{ outer, holes: [] }] : [], radius: 0 };
  }
  if (g.kind === 'dimension' && g.dimension) {
    const dx = g.end.x - g.start.x,
      dy = g.end.y - g.start.y,
      length = Math.hypot(dx, dy) || 1,
      height = g.dimension.height ?? 0,
      offset = { x: (-dy / length) * height, y: (dx / length) * height },
      outer = textContour(g.dimension.caption, g.dimension.caption);
    return {
      paths: [
        [
          g.start,
          { x: g.start.x + offset.x, y: g.start.y + offset.y },
          { x: g.end.x + offset.x, y: g.end.y + offset.y },
          g.end,
        ],
      ],
      polygons: outer.length ? [{ outer, holes: [] }] : [],
      radius: g.width / 2,
    };
  }
  if (g.kind === 'arc') {
    const arc = pcbArc(g);
    if (arc) {
      // Include cardinal extrema as well as a bounded 0.005 mm chord approximation.
      const count = Math.min(
        4096,
        Math.max(8, Math.ceil(Math.abs(arc.delta) * Math.sqrt(arc.radius / 0.01))),
      );
      const angles = Array.from(
        { length: count + 1 },
        (_, i) => arc.start + (arc.delta * i) / count,
      );
      for (let i = -4; i <= 4; i++) {
        const value = (i * Math.PI) / 2;
        const distance =
          arc.delta > 0
            ? (value - arc.start + Math.PI * 4) % (Math.PI * 2)
            : (arc.start - value + Math.PI * 4) % (Math.PI * 2);
        if (distance <= Math.abs(arc.delta))
          angles.push(arc.start + Math.sign(arc.delta) * distance);
      }
      angles.sort((a, b) => Math.sign(arc.delta) * (a - b));
      const points = angles.map((a) => ({
        x: arc.center.x + arc.radius * Math.cos(a),
        y: arc.center.y + arc.radius * Math.sin(a),
      }));
      return {
        paths: g.fill ? [] : [points],
        polygons: g.fill ? [{ outer: points, holes: [] }] : [],
        radius: g.width / 2,
      };
    }
  }
  const points = [g.start, ...(g.points ?? []), g.end];
  return g.kind === 'polygon'
    ? {
        paths: g.fill ? [] : [closed(points)],
        polygons: g.fill ? [{ outer: points, holes: [] }] : [],
        radius: g.width / 2,
      }
    : { paths: [[g.start, g.end]], polygons: [], radius: g.width / 2 };
}

function zoneShape(
  zone: BoardZone,
  layers: PCBDisplay,
  fills: ReadonlyMap<string, Polygon[]>,
): Shape {
  return {
    paths: layers.zoneOutlines ? [zone.outline, ...(zone.holes ?? [])].map(closed) : [],
    polygons: layers.copper ? (fills.get(zone.id) ?? []) : [],
    radius: layers.zoneOutlines ? 0.04 : 0,
  };
}

function selectionFills(
  board: PCB,
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  preparedFills?: ReadonlyMap<string, Polygon[]>,
): ReadonlyMap<string, Polygon[]> {
  if (preparedFills !== undefined) return preparedFills;
  if (
    layers.copper &&
    (board.zones.some(
      (zone) => pcbZoneSelectionEligible(zone, filters) && zone.filledPolygons !== undefined,
    ) ||
      (filters.footprint &&
        layers.footprints &&
        board.footprints.some((footprint) =>
          footprint.zones?.some(
            (zone) => pcbZoneSelectionEligible(zone, filters) && zone.filledPolygons !== undefined,
          ),
        )))
  ) {
    try {
      return filledCopperPolygons(board);
    } catch {
      /* Unavailable fills have no visible target. */
    }
  }
  return noCopperFills;
}

export type PCBPointCandidate = {
  selection?: PCBSelection;
  padId?: string;
  /** The renderer confirmed a hit on this exact footprint text record. */
  directFootprintText?: boolean;
};
type PointScore = {
  distance: number;
  local: number;
  area: number;
  priority: boolean;
  layerRank?: number;
  inspection?: boolean;
  /** Comparable coverage for individually selectable copper and silk. */
  overlapArea?: number;
  overlapDistance?: number;
  active?: boolean;
  silk?: boolean;
};
const silkLayer = (layer: string | undefined) => layer === 'F.SilkS' || layer === 'B.SilkS';
const contourArea = (points: Point[]) =>
  Math.abs(
    points.reduce((sum, p, i) => {
      const q = points[(i + 1) % points.length];
      return sum + p.x * q.y - p.y * q.x;
    }, 0),
  ) / 2;
const closerScore = (a: PointScore, b: PointScore) => {
  return (
    Number(!!b.inspection) - Number(!!a.inspection) ||
    (b.layerRank ?? -1) - (a.layerRank ?? -1) ||
    a.area - b.area
  );
};

/** Rank precise copper/silkscreen overlaps before resolving remaining layer and geometry ties. */
export function choosePCBPointCandidate<T extends PCBPointCandidate>(
  board: PCB,
  layers: PCBDisplay,
  candidates: readonly T[],
  at: Point,
  options: {
    tolerance: number;
    /** Optional subpixel distance tie supplied in board units by the viewport. */
    tieTolerance?: number;
    priorityLayer?: string;
    /** Ordinary selection uses the active copper layer even in the physical-stack view. */
    activeCopperLayer?: BoardLayer;
    /** Track manipulation retains its nearest-segment pickup and layer preference. */
    trackPickup?: boolean;
    /** Stationary clicks can clarify similar-size overlapping copper and silk. */
    onAmbiguous?: (candidates: T[]) => void;
    /** Optional visible paint order, from back/bottom to front/top, for geometric ties. */
    layerOrder?: readonly string[];
    filters?: PCBSelectionFilters;
    preparedFills?: ReadonlyMap<string, Polygon[]>;
    includeRegionInteriors?: boolean;
    footprintTextValues?: ReadonlyMap<string, string>;
  },
): T | undefined {
  const tieTolerance = options.tieTolerance ?? epsilon;
  if (
    ![at.x, at.y, options.tolerance, tieTolerance].every(Number.isFinite) ||
    options.tolerance < 0 ||
    tieTolerance < 0
  )
    return;
  if (!candidates.length) return;
  const filters = options.filters ?? defaultPCBSelectionFilters();
  // D/G candidates need only track identities. Avoid preparing every pad,
  // footprint, artwork and zone lookup on the first track-only pickup.
  const trackObjects = candidates.every(
    (candidate) => !candidate.padId && candidate.selection?.kind === 'track',
  )
    ? pointTracks(board)
    : undefined;
  let objects: ReturnType<typeof pointObjects> | undefined;
  const allObjects = () => (objects ??= pointObjects(board));
  const selectedLayer = options.priorityLayer as BoardLayer | undefined;
  const activeLayer = selectedLayer ?? options.activeCopperLayer ?? 'F.Cu';
  const activeSilk = silkLayer(selectedLayer) && layers[activeLayer];
  // Ordinary layout point queries use a three-screen-pixel collection margin.
  const pixel = options.tolerance / 3;
  const overlap = (list: readonly string[], area: number) => ({
    overlapArea: area,
    active: layers[activeLayer] && list.includes(activeLayer),
  });
  const priority = (list: string[]) =>
    !!options.priorityLayer &&
    !!layers[options.priorityLayer as keyof PCBDisplay] &&
    list.includes(options.priorityLayer);
  const layerRanks = options.layerOrder
    ? new Map(options.layerOrder.map((name, index) => [name, index]))
    : undefined;
  const layerRank = (list: readonly string[]) =>
    layerRanks
      ? list.reduce(
          (rank, name) =>
            layers[name as keyof PCBDisplay] ? Math.max(rank, layerRanks.get(name) ?? -1) : rank,
          -1,
        )
      : undefined;
  const shapeScore = (
    shape: Shape,
    transform = (point: Point) => point,
    areaMargin = 0,
  ): PointScore => {
    let distance = Infinity,
      local = Infinity,
      area = 0;
    const consider = (surface: number, centre: number) => {
      if (
        surface < distance - epsilon ||
        (Math.abs(surface - distance) <= epsilon && centre < local)
      ) {
        distance = surface;
        local = centre;
      }
    };
    for (const original of shape.paths) {
      const path = original.map(transform);
      for (let i = 1; i < path.length; i++) {
        const d = pointDistance(at, path[i - 1], path[i]);
        consider(Math.max(0, d - shape.radius), d);
        area +=
          Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y) *
          (shape.radius + areaMargin) *
          2;
      }
      if (path.length > 1) area += Math.PI * (shape.radius + areaMargin) ** 2;
    }
    for (const original of shape.polygons) {
      const outer = original.outer.map(transform),
        holes = original.holes.map((hole) => hole.map(transform));
      let edge = Infinity;
      for (const ring of [outer, ...holes])
        for (let i = 0; i < ring.length; i++)
          edge = Math.min(edge, pointDistance(at, ring[i], ring[(i + 1) % ring.length]));
      const inside = inContour(at, outer) && !holes.some((hole) => inContour(at, hole)),
        center = outer.reduce(
          (sum, p) => ({ x: sum.x + p.x / outer.length, y: sum.y + p.y / outer.length }),
          { x: 0, y: 0 },
        );
      consider(
        inside ? 0 : Math.max(0, edge - shape.radius),
        Math.hypot(at.x - center.x, at.y - center.y),
      );
      area += contourArea(outer) - holes.reduce((sum, hole) => sum + contourArea(hole), 0);
    }
    return { distance, local, area: Math.max(epsilon, area), priority: false };
  };
  const graphicScore = (graphic: BoardLine, transform?: (point: Point) => Point): PointScore => {
    if (graphic.kind !== 'circle') return shapeScore(graphicShape(graphic), transform);
    const center = transform ? transform(graphic.start) : graphic.start,
      radius = Math.hypot(graphic.end.x - graphic.start.x, graphic.end.y - graphic.start.y),
      d = Math.hypot(at.x - center.x, at.y - center.y),
      local = graphic.fill ? d : Math.abs(d - radius);
    return {
      distance: Math.max(
        0,
        graphic.fill ? d - radius - graphic.width / 2 : local - graphic.width / 2,
      ),
      local,
      area: graphic.fill
        ? Math.PI * (radius + graphic.width / 2) ** 2
        : 2 * Math.PI * radius * graphic.width,
      priority: false,
    };
  };
  const silkScore = (graphic: BoardLine, score: PointScore, owner?: Footprint): PointScore => {
    if (!silkLayer(graphic.layer) || graphic.kind === 'dimension') return score;
    let area = graphic.fill ? score.area : graphic.width ** 2;
    let distance = score.distance;
    if (graphic.kind === 'text' && graphic.text) {
      const text = owner
        ? resolvedFootprintText(owner, graphic, options.footprintTextValues)
        : graphic.text;
      const ink = pcbStrokeText(text, graphic.start);
      area = score.area;
      if ('paths' in ink && ink.paths.length) {
        const strokes = shapeScore(
          { paths: ink.paths, polygons: [], radius: ink.width / 2 },
          owner ? (p) => footprintPoint(owner, p) : undefined,
          options.tolerance,
        );
        area = strokes.area;
        distance = Math.max(0, strokes.distance - 2.5 * pixel);
      }
    }
    return { ...score, ...overlap([graphic.layer], area), overlapDistance: distance, silk: true };
  };
  const keyOf = (candidate: T) =>
    candidate.padId
      ? `pad:${candidate.padId}`
      : `${candidate.selection?.kind}:${candidate.selection?.id}`;
  const scores: { candidate: T; score: PointScore }[] = [];
  const accept = (candidate: T, score: PointScore) => {
    if (score.distance > options.tolerance + epsilon) return;
    scores.push({ candidate, score });
  };
  const overlapPool = () => {
    if (options.trackPickup) return;
    if (activeSilk) {
      const silk = scores.filter(({ score }) => score.silk);
      if (silk.length) return silk;
    }
    if (
      selectedLayer &&
      !selectedLayer.endsWith('.Cu') &&
      !silkLayer(selectedLayer) &&
      scores.some(({ score }) => score.priority)
    )
      return;
    const comparable = scores.filter(({ score }) => score.overlapArea !== undefined);
    if (comparable.length > 1) return scores;
  };
  const overlapDistance = (score: PointScore) => score.overlapDistance ?? score.distance;
  const coverage = (score: PointScore) => score.overlapArea ?? score.area;
  const narrowOverlap = (pool: typeof scores) => {
    const best = pool.reduce((min, { score }) => Math.min(min, overlapDistance(score)), Infinity);
    const byArea = pool
      .filter(({ score }) => overlapDistance(score) <= best + pixel + epsilon)
      .sort((a, b) => coverage(a.score) - coverage(b.score));
    // Keep the first group of similarly sized objects, with a 1.5× gap between groups.
    const gap = byArea.findIndex(
      (item, i) => i > 0 && coverage(item.score) > coverage(byArea[i - 1].score) * 1.5,
    );
    const sizeGroup = gap < 0 ? byArea : byArea.slice(0, gap);
    const active = sizeGroup.filter(({ score }) => score.active ?? score.priority);
    return active.length ? active : sizeGroup;
  };
  const choose = () => {
    if (!scores.length) return;
    const comparable = overlapPool();
    const preferred = scores.filter((item) => item.score.priority);
    const pool = comparable ? narrowOverlap(comparable) : preferred.length ? preferred : scores;
    const distance = comparable ? overlapDistance : (score: PointScore) => score.distance;
    const surface = pool.reduce((min, item) => Math.min(min, distance(item.score)), Infinity),
      nearest = pool.filter((item) => distance(item.score) <= surface + tieTolerance),
      local = nearest.reduce((distance, item) => Math.min(distance, item.score.local), Infinity);
    let winner: (typeof scores)[number] | undefined;
    for (const item of nearest) {
      if (item.score.local > local + tieTolerance) continue;
      const difference = winner ? closerScore(item.score, winner.score) : -1;
      if (
        !winner ||
        difference < 0 ||
        (difference === 0 && keyOf(item.candidate) < keyOf(winner.candidate))
      )
        winner = item;
    }
    const kinds =
      comparable && options.onAmbiguous
        ? new Set(
            pool.flatMap(({ score, candidate }) =>
              score.silk
                ? ['silk']
                : candidate.padId
                  ? ['pad']
                  : candidate.selection?.kind === 'track'
                    ? ['track']
                    : [],
            ),
          )
        : undefined;
    return {
      winner: winner?.candidate,
      rankedOverlap: Boolean(comparable),
      ambiguous:
        kinds && kinds.size > 1
          ? pool
              .filter(({ score }) => score.overlapArea !== undefined)
              .map(({ candidate }) => candidate)
          : undefined,
    };
  };
  const finish = (result: ReturnType<typeof choose>) => {
    if (result?.ambiguous) options.onAmbiguous?.(result.ambiguous);
    return result?.winner;
  };
  const fallback: { candidate: T; body?: PointScore; zones: BoardZone[] }[] = [];
  for (const candidate of candidates) {
    if (candidate.padId) {
      const found = allObjects().pads.get(candidate.padId);
      if (
        !found ||
        !filters.pad ||
        !layers.footprints ||
        ((found.pad.locked || found.owner.locked) && filters.locked === false)
      )
        continue;
      const { owner, pad } = found;
      const padLayers = pointPadLayers(board, owner, pad);
      if (!padLayers.some((layer) => layers[layer as BoardLayer])) continue;
      const score = shapeScore({ paths: [], polygons: [padPolygon(owner, pad)], radius: 0 }),
        center = padPosition(owner, pad);
      score.local = Math.hypot(at.x - center.x, at.y - center.y);
      score.priority = priority(padLayers);
      score.layerRank = layerRank(padLayers);
      score.inspection = true;
      accept(candidate, { ...score, ...overlap(padLayers, score.area) });
      continue;
    }
    const object = candidate.selection;
    if (!object) continue;
    if (object.kind === 'track') {
      const track = (trackObjects ?? allObjects().tracks).get(object.id);
      if (
        !track ||
        !filters.track ||
        !layers[track.layer] ||
        (track.locked && filters.locked === false)
      )
        continue;
      const score = shapeScore({
        paths: [[track.start, track.end]],
        polygons: [],
        radius: track.width / 2,
      });
      score.priority = priority([track.layer]);
      score.layerRank = layerRank([track.layer]);
      accept(candidate, { ...score, ...overlap([track.layer], track.width ** 2) });
    } else if (object.kind === 'via') {
      const via = allObjects().vias.get(object.id);
      if (
        !via ||
        !filters.via ||
        (via.locked && filters.locked === false) ||
        !board.layers.some((layer) => layers[layer])
      )
        continue;
      const d = Math.hypot(at.x - via.x, at.y - via.y);
      accept(candidate, {
        distance: Math.max(0, d - via.diameter / 2),
        local: d,
        area: Math.PI * (via.diameter / 2) ** 2,
        priority: priority(board.layers),
        layerRank: layerRank(board.layers),
        ...overlap(board.layers, (via.drill / 2) ** 2),
      });
    } else if (object.kind === 'graphic') {
      const boardGraphic = allObjects().graphics.get(object.id);
      const owned = boardGraphic ? undefined : findPCBGraphic(board, object.id);
      const graphic = boardGraphic ?? owned?.graphic;
      if (
        !graphic ||
        !layers[graphic.layer] ||
        (graphic.layer !== 'Edge.Cuts' && !layers.footprints) ||
        !pcbGraphicSelectionEligible(graphic, filters)
      )
        continue;
      if (owned?.owner) {
        if (
          !layers.footprints ||
          graphic.text?.hidden ||
          (owned.owner.locked && filters.locked === false)
        )
          continue;
        const outer = footprintTextContour(owned.owner, graphic, options.footprintTextValues);
        const score = shapeScore({
          paths: [],
          polygons: outer.length ? [{ outer, holes: [] }] : [],
          radius: 0,
        });
        const ranked = silkScore(graphic, score, owned.owner);
        if (candidate.directFootprintText) {
          ranked.distance = 0;
          ranked.local = 0;
        }
        accept(candidate, {
          ...ranked,
          priority: priority([graphic.layer]),
          layerRank: layerRank([graphic.layer]),
        });
        continue;
      }
      accept(candidate, {
        ...silkScore(graphic, graphicScore(graphic)),
        priority: priority([graphic.layer]),
        layerRank: layerRank([graphic.layer]),
      });
      if (options.includeRegionInteriors && graphic.kind === 'polygon') {
        const polygon = {
          outer: [graphic.start, ...(graphic.points ?? []), graphic.end],
          holes: [],
        };
        if (inContour(at, polygon.outer))
          fallback.push({
            candidate,
            zones: [],
            body: {
              ...shapeScore({ paths: [], polygons: [polygon], radius: 0 }),
              priority: priority([graphic.layer]),
              layerRank: layerRank([graphic.layer]),
            },
          });
      }
    } else if (object.kind === 'zone') {
      const zone = allObjects().zones.get(object.id);
      if (!zone || !layers[zone.layer] || !pcbZoneSelectionEligible(zone, filters)) continue;
      if (layers.zoneOutlines)
        accept(candidate, {
          ...shapeScore({
            paths: [zone.outline, ...(zone.holes ?? [])].map(closed),
            polygons: [],
            radius: 0.04,
          }),
          priority: priority([zone.layer]),
          layerRank: layerRank([zone.layer]),
        });
      const body =
        options.includeRegionInteriors &&
        layers.zoneOutlines &&
        inContour(at, zone.outline) &&
        !(zone.holes ?? []).some((hole) => inContour(at, hole))
          ? {
              ...shapeScore({
                paths: [],
                polygons: [{ outer: zone.outline, holes: zone.holes ?? [] }],
                radius: 0,
              }),
              priority: priority([zone.layer]),
              layerRank: layerRank([zone.layer]),
            }
          : undefined;
      fallback.push({ candidate, zones: [zone], body });
    } else {
      const owner = allObjects().footprints.get(object.id);
      if (
        !owner ||
        !filters.footprint ||
        (owner.locked && filters.locked === false) ||
        !layers.footprints
      )
        continue;
      const bounds = pcbFootprintBodyBounds(board, owner, layers),
        area = bounds
          ? Math.max(epsilon, (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY))
          : Infinity,
        transform = (p: Point) => footprintPoint(owner, p);
      for (const pad of owner.pads) {
        if (
          pad.type === 'np_thru_hole'
            ? !layers['Edge.Cuts']
            : !padCopperLayers(board, owner, pad).some((layer) => layers[layer as keyof PCBDisplay])
        )
          continue;
        const score = shapeScore({ paths: [], polygons: [padPolygon(owner, pad)], radius: 0 }),
          center = padPosition(owner, pad);
        accept(candidate, {
          ...score,
          local: Math.hypot(at.x - center.x, at.y - center.y),
          area,
          priority: priority(
            pad.type === 'np_thru_hole' ? ['Edge.Cuts'] : padCopperLayers(board, owner, pad),
          ),
          layerRank: layerRank(
            pad.type === 'np_thru_hole' ? ['Edge.Cuts'] : padCopperLayers(board, owner, pad),
          ),
        });
      }
      for (const graphic of owner.graphics)
        if (
          layers[graphic.layer] &&
          pcbGraphicSelectionEligible(graphic, filters) &&
          graphic.kind !== 'text' &&
          graphic.kind !== 'dimension'
        )
          accept(candidate, {
            ...graphicScore(graphic, transform),
            area,
            priority: priority([graphic.layer]),
            layerRank: layerRank([graphic.layer]),
          });
      const ownZones = (owner.zones ?? []).filter(
        (zone) => layers[zone.layer] && pcbZoneSelectionEligible(zone, filters),
      );
      if (layers.zoneOutlines)
        for (const zone of ownZones)
          accept(candidate, {
            ...shapeScore(
              {
                paths: [zone.outline, ...(zone.holes ?? [])].map(closed),
                polygons: [],
                radius: 0.04,
              },
              transform,
            ),
            priority: priority([zone.layer]),
            layerRank: layerRank([zone.layer]),
          });
      const preferredBounds =
        options.priorityLayer && layers[options.priorityLayer as keyof PCBDisplay]
          ? pcbFootprintBodyBounds(
              board,
              owner,
              pcbDisplayForLayer(layers, options.priorityLayer as BoardLayer),
            )
          : undefined;
      const body =
        bounds && inContour(at, corners(bounds).map(transform))
          ? {
              distance: 0,
              local: 0,
              area,
              priority: Boolean(
                preferredBounds && inContour(at, corners(preferredBounds).map(transform)),
              ),
              layerRank: layerRank([owner.side === 'front' ? 'F.Cu' : 'B.Cu']),
            }
          : undefined;
      fallback.push({ candidate, body, zones: ownZones });
    }
  }
  const preciseResult = choose();
  const precise = preciseResult?.winner;
  if (
    precise &&
    (preciseResult.rankedOverlap ||
      !options.priorityLayer ||
      scores.some((item) => item.score.priority))
  )
    return finish(preciseResult);
  const needsFills =
    layers.copper &&
    fallback.some((item) =>
      item.zones.some(
        (zone) => (!precise || priority([zone.layer])) && zone.filledPolygons !== undefined,
      ),
    );
  const fills = needsFills
    ? selectionFills(board, layers, filters, options.preparedFills)
    : noCopperFills;
  for (const item of fallback) {
    if (item.body && (!precise || item.body.priority)) accept(item.candidate, item.body);
    if (layers.copper)
      for (const zone of item.zones) {
        if (precise && !priority([zone.layer])) continue;
        const polygons = fills.get(zone.id);
        if (polygons?.length)
          accept(item.candidate, {
            ...shapeScore({ paths: [], polygons, radius: 0 }),
            priority: priority([zone.layer]),
            layerRank: layerRank([zone.layer]),
          });
      }
  }
  return finish(choose());
}

/** Left-to-right windows contain objects; right-to-left windows touch visible geometry.
 * Footprint captions and dimensions never enlarge the editable body target.
 */
export function selectPCBRectangle(
  board: PCB,
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  start: Point,
  end: Point,
  preparedFills?: ReadonlyMap<string, Polygon[]>,
  activeLayer?: BoardLayer,
  footprintTextValues?: ReadonlyMap<string, string>,
  includeOwnedText = false,
): PCBSelection[] {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return [];
  if (activeLayer) layers = pcbDisplayForLayer(layers, activeLayer);
  const rectangle = {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
  const contained = end.x >= start.x;
  const selected = selectPCBGeometry(
    board,
    layers,
    filters,
    rectangle,
    contained,
    selectionFills(board, layers, filters, preparedFills),
  );
  const coveredOwners = includeOwnedText
    ? undefined
    : new Set(selected.filter((s) => s.kind === 'footprint').map((s) => s.id));
  return [
    ...selected,
    ...selectFootprintText(
      board,
      layers,
      filters,
      rectangle,
      contained,
      footprintTextValues,
      coveredOwners,
    ),
  ];
}

function selectPCBGeometry(
  board: PCB,
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  rectangle: Rectangle,
  contained: boolean,
  fills: ReadonlyMap<string, Polygon[]>,
): PCBSelection[] {
  const selected: PCBSelection[] = [];
  if (filters.footprint)
    for (const footprint of board.footprints) {
      if (footprint.locked && filters.locked === false) continue;
      const bounds = pcbFootprintBodyBounds(board, footprint, layers);
      const shapes: Shape[] = bounds
        ? [
            {
              paths: [],
              polygons: [
                {
                  outer: corners(bounds).map((p) => footprintPoint(footprint, p)),
                  holes: [],
                },
              ],
              radius: 0,
            },
          ]
        : [];
      if (layers.footprints && (layers.zoneOutlines || layers.copper))
        for (const zone of footprint.zones ?? []) {
          if (!layers[zone.layer] || !pcbZoneSelectionEligible(zone, filters)) continue;
          const shape = zoneShape(zone, layers, fills);
          shape.paths = shape.paths.map((path) =>
            path.map((point) => footprintPoint(footprint, point)),
          );
          if (shape.paths.length || shape.polygons.length) shapes.push(shape);
        }
      if (
        shapes.length &&
        (contained
          ? shapes.every((shape) => shapeMatches(shape, rectangle, true))
          : shapes.some((shape) => shapeMatches(shape, rectangle, false)))
      )
        selected.push({ kind: 'footprint', id: footprint.id });
    }
  if (filters.track)
    for (const track of board.tracks)
      if (
        layers[track.layer] &&
        (!track.locked || filters.locked !== false) &&
        shapeMatches(
          { paths: [[track.start, track.end]], polygons: [], radius: track.width / 2 },
          rectangle,
          contained,
        )
      )
        selected.push({ kind: 'track', id: track.id });
  if (filters.via && board.layers.some((layer) => layers[layer]))
    for (const via of board.vias)
      if (
        (!via.locked || filters.locked !== false) &&
        diskMatches(via, via.diameter / 2, rectangle, contained)
      )
        selected.push({ kind: 'via', id: via.id });
  for (const graphic of board.graphics) {
    if (
      !pcbGraphicSelectionEligible(graphic, filters) ||
      !layers[graphic.layer] ||
      (graphic.layer !== 'Edge.Cuts' && !layers.footprints)
    )
      continue;
    if (
      graphic.kind === 'circle'
        ? circleMatches(graphic, rectangle, contained)
        : shapeMatches(graphicShape(graphic), rectangle, contained)
    )
      selected.push({ kind: 'graphic', id: graphic.id });
  }
  if (layers.zoneOutlines || layers.copper) {
    for (const zone of board.zones) {
      if (!layers[zone.layer] || !pcbZoneSelectionEligible(zone, filters)) continue;
      const shape = zoneShape(zone, layers, fills);
      if (shapeMatches(shape, rectangle, contained)) selected.push({ kind: 'zone', id: zone.id });
    }
  }
  return selected;
}

type PointRecord = {
  bounds: Rectangle;
  order: number;
  selection: PCBSelection;
  zone?: BoardZone;
  matches: (rectangle: Rectangle) => boolean;
};
type PointTree = {
  bounds: Rectangle;
  records?: PointRecord[];
  children?: [PointTree, PointTree];
};
const ownedPointTrees = new WeakMap<PCB, Map<string, PointTree | null>>();
const overlaps = (a: Rectangle, b: Rectangle) =>
  a.minX <= b.maxX + epsilon &&
  a.maxX >= b.minX - epsilon &&
  a.minY <= b.maxY + epsilon &&
  a.maxY >= b.minY - epsilon;
function pointTree(records: PointRecord[]): PointTree | null {
  if (!records.length) return null;
  const bounds = records.reduce(
    (bounds, record) => ({
      minX: Math.min(bounds.minX, record.bounds.minX),
      minY: Math.min(bounds.minY, record.bounds.minY),
      maxX: Math.max(bounds.maxX, record.bounds.maxX),
      maxY: Math.max(bounds.maxY, record.bounds.maxY),
    }),
    { ...records[0].bounds },
  );
  if (records.length <= 8) return { bounds, records };
  const x = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
  records.sort((a, b) =>
    x
      ? a.bounds.minX + a.bounds.maxX - b.bounds.minX - b.bounds.maxX
      : a.bounds.minY + a.bounds.maxY - b.bounds.minY - b.bounds.maxY,
  );
  const middle = Math.floor(records.length / 2);
  return {
    bounds,
    children: [pointTree(records.slice(0, middle))!, pointTree(records.slice(middle))!],
  };
}

/** A private broad phase for owned immutable geometry. Bounds only reject distant
 * objects; the existing exact tests still decide every hit. Saved fills and mutable
 * previews retain the exhaustive path and never enter this cache. */
function precisePointGeometry(
  board: PCB,
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  rectangle: Rectangle,
): PCBSelection[] {
  if (!isOwnedPCB(board))
    return selectPCBGeometry(board, layers, filters, rectangle, false, noCopperFills);
  const key = Object.keys(layers)
    .sort()
    .filter((name) => layers[name as keyof PCBDisplay])
    .join('|');
  let variants = ownedPointTrees.get(board);
  if (!variants) ownedPointTrees.set(board, (variants = new Map()));
  if (!variants.has(key)) {
    const records: PointRecord[] = [];
    let order = 0;
    const addShape = (selection: PCBSelection, shape: Shape, zone?: BoardZone) => {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const path of [
        ...shape.paths,
        ...shape.polygons.flatMap((polygon) => [polygon.outer, ...polygon.holes]),
      ])
        for (const point of path) {
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }
      if (minX === Infinity) return;
      records.push({
        selection,
        order,
        zone,
        bounds: {
          minX: minX - shape.radius,
          minY: minY - shape.radius,
          maxX: maxX + shape.radius,
          maxY: maxY + shape.radius,
        },
        matches: (rectangle) => shapeMatches(shape, rectangle, false),
      });
    };
    for (const footprint of board.footprints) {
      const selection: PCBSelection = { kind: 'footprint', id: footprint.id };
      const bounds = pcbFootprintBodyBounds(board, footprint, layers);
      if (bounds)
        addShape(selection, {
          paths: [],
          polygons: [
            { outer: corners(bounds).map((p) => footprintPoint(footprint, p)), holes: [] },
          ],
          radius: 0,
        });
      if (layers.footprints && layers.zoneOutlines)
        for (const zone of footprint.zones ?? []) {
          if (!layers[zone.layer]) continue;
          const shape = zoneShape(zone, layers, noCopperFills);
          shape.paths = shape.paths.map((path) =>
            path.map((point) => footprintPoint(footprint, point)),
          );
          addShape(selection, shape, zone);
        }
      order++;
    }
    for (const track of board.tracks) {
      if (layers[track.layer])
        addShape(
          { kind: 'track', id: track.id },
          { paths: [[track.start, track.end]], polygons: [], radius: track.width / 2 },
        );
      order++;
    }
    for (const via of board.vias) {
      const radius = via.diameter / 2;
      if (board.layers.some((layer) => layers[layer]))
        records.push({
          selection: { kind: 'via', id: via.id },
          order,
          bounds: {
            minX: via.x - radius,
            minY: via.y - radius,
            maxX: via.x + radius,
            maxY: via.y + radius,
          },
          matches: (rectangle) => diskMatches(via, radius, rectangle, false),
        });
      order++;
    }
    for (const graphic of board.graphics) {
      if (layers[graphic.layer] && (graphic.layer === 'Edge.Cuts' || layers.footprints)) {
        const selection: PCBSelection = { kind: 'graphic', id: graphic.id };
        if (graphic.kind === 'circle') {
          const radius =
            Math.hypot(graphic.end.x - graphic.start.x, graphic.end.y - graphic.start.y) +
            graphic.width / 2;
          records.push({
            selection,
            order,
            bounds: {
              minX: graphic.start.x - radius,
              minY: graphic.start.y - radius,
              maxX: graphic.start.x + radius,
              maxY: graphic.start.y + radius,
            },
            matches: (rectangle) => circleMatches(graphic, rectangle, false),
          });
        } else addShape(selection, graphicShape(graphic));
      }
      order++;
    }
    if (layers.zoneOutlines)
      for (const zone of board.zones) {
        if (layers[zone.layer])
          addShape({ kind: 'zone', id: zone.id }, zoneShape(zone, layers, noCopperFills));
        order++;
      }
    const tree = pointTree(records);
    // Retain two recent visibility variants per owned board, never an unbounded
    // history of arbitrary appearance combinations.
    if (variants.size >= 2) variants.delete(variants.keys().next().value!);
    variants.set(key, tree);
  }
  const hits = new Map<number, PCBSelection>();
  const visit = (tree: PointTree) => {
    if (!overlaps(tree.bounds, rectangle)) return;
    for (const record of tree.records ?? [])
      if (
        !hits.has(record.order) &&
        overlaps(record.bounds, rectangle) &&
        pcbSelectionEligible(board, record.selection, filters) &&
        (!record.zone || pcbZoneSelectionEligible(record.zone, filters)) &&
        record.matches(rectangle)
      )
        hits.set(record.order, record.selection);
    for (const child of tree.children ?? []) visit(child);
  };
  const tree = variants.get(key);
  if (tree) visit(tree);
  return [...hits].sort(([a], [b]) => a - b).map(([, selection]) => ({ ...selection }));
}

/** Track-only tools retain the ordinary precise track predicates and ordering,
 * without preparing unrelated footprint/artwork/zone geometry or reading fills.
 */
export function selectPCBTrackPoint(
  board: PCB,
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  at: Point,
  tolerance: number,
): PCBSelection[] {
  if (!filters.track || ![at.x, at.y, tolerance].every(Number.isFinite) || tolerance < 0) return [];
  if (board.tracks.length > 15000)
    throw new Error('Track picking exceeds the geometry limit. Reduce board complexity.');
  const rectangle = {
    minX: at.x - tolerance,
    minY: at.y - tolerance,
    maxX: at.x + tolerance,
    maxY: at.y + tolerance,
  };
  const selected: PCBSelection[] = [];
  for (const track of board.tracks) {
    if (!layers[track.layer] || (track.locked && filters.locked === false)) continue;
    const radius = track.width / 2;
    if (
      Math.max(track.start.x, track.end.x) + radius < rectangle.minX - epsilon ||
      Math.min(track.start.x, track.end.x) - radius > rectangle.maxX + epsilon ||
      Math.max(track.start.y, track.end.y) + radius < rectangle.minY - epsilon ||
      Math.min(track.start.y, track.end.y) - radius > rectangle.maxY + epsilon
    )
      continue;
    if (shapeMatches({ paths: [[track.start, track.end]], polygons: [], radius }, rectangle, false))
      selected.push({ kind: 'track', id: track.id });
  }
  return selected;
}

/** Keep selected-layer region candidates even behind precise hits on other layers.
 * Saved-fill candidates are identities only until the picker needs their contours.
 * Ordinary queries retain precise-first, lazy fill lookup.
 */
export function selectPCBPoint(
  board: PCB,
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  at: Point,
  tolerance: number,
  options: PCBPointSelectionOptions = {},
): PCBSelection[] {
  if (![at.x, at.y, tolerance].every(Number.isFinite) || tolerance < 0) return [];
  const preferred: PCBSelection[] = [];
  const priorityLayer = options.priorityLayer;
  if (priorityLayer && layers[priorityLayer]) {
    const zoneCandidate = (zone: BoardZone, point: Point) =>
      zone.layer === priorityLayer &&
      pcbZoneSelectionEligible(zone, filters) &&
      ((options.includeRegionInteriors &&
        layers.zoneOutlines &&
        inContour(point, zone.outline) &&
        !(zone.holes ?? []).some((hole) => inContour(point, hole))) ||
        (layers.copper && zone.filledPolygons !== undefined));
    if (options.includeRegionInteriors)
      for (const graphic of board.graphics)
        if (
          graphic.layer === priorityLayer &&
          graphic.kind === 'polygon' &&
          (graphic.layer === 'Edge.Cuts' || layers.footprints) &&
          pcbGraphicSelectionEligible(graphic, filters) &&
          inContour(at, [graphic.start, ...(graphic.points ?? []), graphic.end])
        )
          preferred.push({ kind: 'graphic', id: graphic.id });
    for (const zone of board.zones)
      if (zoneCandidate(zone, at)) preferred.push({ kind: 'zone', id: zone.id });
    if (filters.footprint && layers.footprints && layers.copper)
      for (const footprint of board.footprints)
        if (
          (!footprint.locked || filters.locked !== false) &&
          footprint.zones?.some(
            (zone) =>
              zone.layer === priorityLayer &&
              pcbZoneSelectionEligible(zone, filters) &&
              zone.filledPolygons !== undefined,
          )
        )
          preferred.push({ kind: 'footprint', id: footprint.id });
  }
  const finish = (candidates: PCBSelection[]) =>
    preferred.length ? mergePCBSelection(candidates, preferred, 'add') : candidates;
  const rectangle = {
      minX: at.x - tolerance,
      minY: at.y - tolerance,
      maxX: at.x + tolerance,
      maxY: at.y + tolerance,
    },
    precise = mergePCBSelection(
      (options.preciseCandidates ?? []).filter(
        (item) =>
          pcbSelectionEligible(board, item, filters) &&
          (item.kind !== 'footprint' || layers.footprints),
      ),
      options.includeFills
        ? selectPCBGeometry(
            board,
            layers,
            filters,
            rectangle,
            false,
            selectionFills(board, layers, filters, options.preparedFills),
          )
        : precisePointGeometry(board, layers, filters, rectangle),
      'add',
    );
  const text = selectFootprintText(
    board,
    layers,
    filters,
    rectangle,
    false,
    options.footprintTextValues,
  );
  const objects = text.length ? mergePCBSelection(precise, text, 'add') : precise;
  if (!objects.length && !options.hasPrecisePad && options.includeRegionInteriors) {
    const regions: PCBSelection[] = [];
    for (const graphic of board.graphics)
      if (
        graphic.kind === 'polygon' &&
        layers[graphic.layer] &&
        (graphic.layer === 'Edge.Cuts' || layers.footprints) &&
        pcbGraphicSelectionEligible(graphic, filters) &&
        inContour(at, [graphic.start, ...(graphic.points ?? []), graphic.end])
      )
        regions.push({ kind: 'graphic', id: graphic.id });
    if (layers.zoneOutlines)
      for (const zone of board.zones)
        if (
          layers[zone.layer] &&
          pcbZoneSelectionEligible(zone, filters) &&
          inContour(at, zone.outline) &&
          !(zone.holes ?? []).some((hole) => inContour(at, hole))
        )
          regions.push({ kind: 'zone', id: zone.id });
    if (regions.length) return finish(regions);
  }
  if (options.includeFills || objects.length || options.hasPrecisePad || !layers.copper)
    return finish(objects);
  const fills = selectionFills(board, layers, filters, options.preparedFills),
    selected: PCBSelection[] = [];
  const hits = (zone: BoardZone) =>
    pcbZoneSelectionEligible(zone, filters) &&
    layers[zone.layer] &&
    shapeMatches({ paths: [], polygons: fills.get(zone.id) ?? [], radius: 0 }, rectangle, false);
  if (filters.footprint && layers.footprints)
    for (const footprint of board.footprints)
      if ((!footprint.locked || filters.locked !== false) && footprint.zones?.some(hits))
        selected.push({ kind: 'footprint', id: footprint.id });
  for (const zone of board.zones) if (hits(zone)) selected.push({ kind: 'zone', id: zone.id });
  return finish(selected);
}

/** Preserve stable selection order and remove duplicate gesture candidates. */
export function mergePCBSelection(
  current: readonly PCBSelection[],
  candidates: readonly PCBSelection[],
  mode: PCBSelectionMode = 'replace',
): PCBSelection[] {
  const key = (item: PCBSelection) => `${item.kind}:${item.id}`;
  const unique = (items: readonly PCBSelection[]) => [
    ...new Map(items.map((item) => [key(item), item])).values(),
  ];
  const incoming = unique(candidates),
    keys = new Set(incoming.map(key)),
    existing = unique(current);
  if (mode === 'replace') return incoming;
  if (mode === 'subtract') return existing.filter((item) => !keys.has(key(item)));
  const existingKeys = new Set(existing.map(key));
  return [
    ...(mode === 'toggle' ? existing.filter((item) => !keys.has(key(item))) : existing),
    ...incoming.filter((item) => !existingKeys.has(key(item))),
  ];
}
