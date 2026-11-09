import type { Point } from './circuit';
import type { CopperLayer, PCB } from './pcb';
import { padCopperLayers } from './pcb-connectivity';
import { footprintPoint, padDrillPosition, padPosition, routePoints } from './pcb-layout';
import { pcbArc, transformPCBGraphic } from './pcb-geometry';
import { pcbDimensionStrokes } from './pcb-routing-artwork';
import { borrowPCBPadOutline } from './pcb-pad-contour';
import {
  boardPolygons,
  graphicVertices,
  offsetPolygons,
  worldZones,
  type Polygon,
} from './pcb-polygons';
import { insidePolygon, polygonEdges, segmentDistance, squaredDistance } from './pcb-collision';

export type RoutingOptions = {
  layer: CopperLayer;
  netId: string | null;
  width: number;
  clearance: number;
  /** Tracks, vias and pad placement use their respective keepout rules. */
  obstacleType?: 'track' | 'via' | 'pad';
  /** Preserve an exact width captured from an existing validated track. */
  allowInheritedWidth?: boolean;
  /** Disable automatic detours for manually placed, collision-checked routing. */
  walkAround?: boolean;
};
export type RouteResult = { points: Point[]; blocked: boolean; message: string };
type Obstacle = {
  polygon?: Polygon;
  edges: [Point, Point][];
  cornerBounds: CornerBounds;
  corners?: Point[];
  radius: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
type Bounds = Pick<Obstacle, 'minX' | 'minY' | 'maxX' | 'maxY'>;
type CornerBounds = Bounds & {
  minSum: number;
  maxSum: number;
  minDifference: number;
  maxDifference: number;
};
type ObstacleTree = Bounds & { items?: Obstacle[]; children?: ObstacleTree[] };
const safety = 0.002;
const blockedMessage =
  'Route blocked. Move around the obstacle or reduce the track width or clearance.';
const limitMessage =
  'Routing exceeds the geometry limit. Use shorter waypoints or simplify the board.';
const length = (points: Point[]) =>
  points.slice(1).reduce((n, p, i) => n + Math.sqrt(squaredDistance(points[i], p)), 0);
const octileDistance = (a: Point, b: Point) => {
  const dx = Math.abs(a.x - b.x),
    dy = Math.abs(a.y - b.y);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
};
const overlaps = (a: Bounds, b: Bounds) =>
  a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;

/** Circumscribed H/V/45 hull, including the clearance around the source shape.
 * Diagonal support planes retain usable channels beside rotated pads and tracks. */
function obstacleCornerBounds(points: Point[], radius: number, bounds: Bounds): CornerBounds {
  const diagonal = radius * Math.SQRT2;
  let minSum = Infinity,
    maxSum = -Infinity,
    minDifference = Infinity,
    maxDifference = -Infinity;
  for (const point of points) {
    minSum = Math.min(minSum, point.x + point.y - diagonal);
    maxSum = Math.max(maxSum, point.x + point.y + diagonal);
    minDifference = Math.min(minDifference, point.x - point.y - diagonal);
    maxDifference = Math.max(maxDifference, point.x - point.y + diagonal);
  }
  return { ...bounds, minSum, maxSum, minDifference, maxDifference };
}

function obstacleCorners(bounds: CornerBounds): Point[] {
  let ring = [
    { x: bounds.minX - safety, y: bounds.minY - safety },
    { x: bounds.maxX + safety, y: bounds.minY - safety },
    { x: bounds.maxX + safety, y: bounds.maxY + safety },
    { x: bounds.minX - safety, y: bounds.maxY + safety },
  ];
  for (const [x, y, limit] of [
    [1, 1, bounds.maxSum],
    [-1, -1, -bounds.minSum],
    [1, -1, bounds.maxDifference],
    [-1, 1, -bounds.minDifference],
  ]) {
    const result: Point[] = [];
    const distance = (p: Point) => x * p.x + y * p.y - limit;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length],
        da = distance(a),
        db = distance(b);
      if (da <= 0) result.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    ring = result;
  }
  return ring;
}

function obstacleTree(items: Obstacle[]): ObstacleTree | undefined {
  if (!items.length) return;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const item of items) {
    bounds.minX = Math.min(bounds.minX, item.minX);
    bounds.minY = Math.min(bounds.minY, item.minY);
    bounds.maxX = Math.max(bounds.maxX, item.maxX);
    bounds.maxY = Math.max(bounds.maxY, item.maxY);
  }
  if (items.length <= 8) return { ...bounds, items };
  const axis = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY ? 'x' : 'y';
  const sorted = [...items].sort((a, b) =>
    axis === 'x' ? a.minX + a.maxX - b.minX - b.maxX : a.minY + a.maxY - b.minY - b.maxY,
  );
  const middle = Math.floor(items.length / 2);
  return {
    ...bounds,
    children: [obstacleTree(sorted.slice(0, middle))!, obstacleTree(sorted.slice(middle))!],
  };
}

/** Extra escape points for concave filled obstacles and their free holes.
 * These are only bounded search hints; the original polygon remains authoritative.
 * Complex or acute passages can still require shorter explicit waypoints.
 */
function polygonDetourNodes(
  obstacles: Obstacle[],
  bounds: Bounds,
  clear: (points: Point[]) => boolean,
  spend: () => void,
): Point[] {
  const nodes: Point[] = [],
    seen = new Set<string>();
  let seeds = 0;
  for (const obstacle of obstacles) {
    const polygon = obstacle.polygon;
    if (!polygon) continue;
    const rings = [...polygon.holes, polygon.outer].map((source) => {
      const ring: Point[] = [];
      for (const point of source) {
        spend();
        if (!ring.length || squaredDistance(ring[ring.length - 1], point) > 1e-18) ring.push(point);
      }
      if (ring.length > 1 && squaredDistance(ring[0], ring[ring.length - 1]) <= 1e-18) ring.pop();
      return ring;
    });
    if (!polygon.holes.length) {
      let turn = 0,
        concave = false;
      const ring = rings[0];
      for (let i = 0; i < ring.length; i++) {
        spend();
        const a = ring[(i + ring.length - 1) % ring.length],
          b = ring[i],
          c = ring[(i + 1) % ring.length],
          cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (
          Math.abs(cross) <=
          1e-8 * Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y)
        )
          continue;
        if (turn && Math.sign(cross) !== turn) {
          concave = true;
          break;
        }
        turn = Math.sign(cross);
      }
      if (!concave) continue;
    }
    const radius = obstacle.radius + safety;
    for (const ring of rings) {
      if (ring.length < 3) continue;
      for (let i = 0; i < ring.length; i++) {
        spend();
        const a = ring[(i + ring.length - 1) % ring.length],
          b = ring[i],
          c = ring[(i + 1) % ring.length],
          before = Math.hypot(b.x - a.x, b.y - a.y),
          after = Math.hypot(c.x - b.x, c.y - b.y);
        if (before <= 1e-9 || after <= 1e-9) continue;
        const ux = (b.x - a.x) / before,
          uy = (b.y - a.y) / before,
          vx = (c.x - b.x) / after,
          vy = (c.y - b.y) / after,
          cross = ux * vy - uy * vx;
        if (
          Math.abs(cross) <= 1e-8 ||
          b.x < bounds.minX - radius * 4 ||
          b.x > bounds.maxX + radius * 4 ||
          b.y < bounds.minY - radius * 4 ||
          b.y > bounds.maxY + radius * 4
        )
          continue;
        if (seeds++ >= 128) return nodes;
        for (const first of [-1, 1])
          for (const second of [-1, 1]) {
            spend();
            const ax = b.x - uy * radius * first,
              ay = b.y + ux * radius * first,
              bx = b.x - vy * radius * second,
              by = b.y + vx * radius * second,
              distance = ((bx - ax) * vy - (by - ay) * vx) / cross,
              point = {
                x: Number((ax + distance * ux).toFixed(6)),
                y: Number((ay + distance * uy).toFixed(6)),
              };
            if (
              !Number.isFinite(point.x) ||
              !Number.isFinite(point.y) ||
              Math.abs(point.x) > 100000 ||
              Math.abs(point.y) > 100000 ||
              squaredDistance(point, b) > (radius * 4) ** 2 ||
              point.x < bounds.minX ||
              point.x > bounds.maxX ||
              point.y < bounds.minY ||
              point.y > bounds.maxY
            )
              continue;
            const key = `${point.x},${point.y}`;
            if (seen.has(key) || !clear([point])) continue;
            nodes.push(point);
            seen.add(key);
            if (nodes.length >= 64) return nodes;
          }
      }
    }
  }
  return nodes;
}

const compact = (points: Point[]) => {
  const result: Point[] = [];
  for (const p of points) {
    if (result.length && squaredDistance(result[result.length - 1], p) < 1e-12) continue;
    while (result.length > 1) {
      const a = result[result.length - 2],
        b = result[result.length - 1];
      if (
        Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) > 1e-7 ||
        (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) < 0
      )
        break;
      result.pop();
    }
    result.push(p);
  }
  return result;
};

/** Immutable, layer-aware routing geometry with optional Walk Around detours.
 * Existing copper never moves. Both previews and commits use these same checks. */
export function createPCBRouter(board: PCB, options: RoutingOptions) {
  const {
    layer,
    netId,
    width,
    clearance,
    obstacleType = 'track',
    allowInheritedWidth = false,
    walkAround = true,
  } = options;
  if (
    !board.layers.some((value) => value === layer) ||
    (!(obstacleType === 'pad' && netId === null) && !board.nets.some((n) => n.id === netId)) ||
    !Number.isFinite(width) ||
    (obstacleType === 'pad'
      ? width < 0
      : obstacleType === 'via' || allowInheritedWidth
        ? width <= 0
        : width < 0.05) ||
    width > (obstacleType === 'pad' || allowInheritedWidth ? 1000 : 20) ||
    !Number.isFinite(clearance) ||
    clearance < 0.05 ||
    clearance > 20
  )
    throw new Error('Choose a valid copper layer, net, track width and clearance before routing.');
  const margin = width / 2 + clearance + safety;
  const obstacles: Obstacle[] = [];
  let vertices = 0;
  const add = (points: Point[], radius: number, polygon?: Polygon) => {
    vertices += points.length + (polygon?.holes.reduce((n, h) => n + h.length, 0) ?? 0);
    if (obstacles.length >= 15000 || vertices > 120000) throw new Error(limitMessage);
    if (!points.length) return;
    const r = radius + margin;
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of points) {
      bounds.minX = Math.min(bounds.minX, p.x - r);
      bounds.minY = Math.min(bounds.minY, p.y - r);
      bounds.maxX = Math.max(bounds.maxX, p.x + r);
      bounds.maxY = Math.max(bounds.maxY, p.y + r);
    }
    obstacles.push({
      ...bounds,
      polygon,
      radius: r,
      cornerBounds: obstacleCornerBounds(points, r + safety, bounds),
      edges: polygon
        ? polygonEdges(polygon)
        : points.length === 1
          ? [[points[0], points[0]]]
          : points.slice(1).map((p, i) => [points[i], p]),
    });
  };
  for (const f of board.footprints)
    for (const p of f.pads) {
      if ((netId === null || p.netId !== netId) && padCopperLayers(board, f, p).includes(layer)) {
        if (p.shape === 'circle') add([padPosition(f, p)], p.size.x / 2);
        else {
          const shape = borrowPCBPadOutline(f, p);
          const radius =
            Math.min(p.size.x, p.size.y) *
            (p.shape === 'oval' ? 0.5 : p.shape === 'roundrect' ? (p.roundrectRatio ?? 0) : 0);
          // Cover the maximum sagitta of padPolygon's 9-point quarter arcs.
          add(shape.outer, radius * (1 - Math.cos(Math.PI / 32)), shape);
        }
      }
      // A plated same-net pad is a legal routing anchor, including its center.
      if (p.drill && (netId === null || p.netId !== netId || p.type === 'np_thru_hole')) {
        add([padDrillPosition(f, p)], p.drill / 2);
      }
    }
  for (const t of board.tracks)
    if (t.layer === layer && t.netId !== netId) add([t.start, t.end], t.width / 2);
  for (const v of board.vias) if (v.netId !== netId) add([v], v.diameter / 2);
  // New tracks invalidate saved pours; only explicit track keepouts block routing.
  for (const z of worldZones(board)) {
    if (z.layer !== layer) continue;
    if (z.keepout?.[obstacleType === 'pad' ? 'pads' : obstacleType === 'via' ? 'vias' : 'tracks']) {
      const shape = { outer: z.outline, holes: z.holes ?? [] };
      add(shape.outer, 0, shape);
    }
  }
  const graphics = board.graphics.filter((g) => g.layer === layer || g.layer === 'Edge.Cuts');
  for (const footprint of board.footprints) {
    const point = (p: Point) => footprintPoint(footprint, p);
    for (const graphic of footprint.graphics) {
      if (graphic.layer !== layer && graphic.layer !== 'Edge.Cuts') continue;
      if (graphic.kind === 'dimension' && graphic.dimension && graphic.layer.endsWith('.Cu')) {
        // Match the local strokes used by the artwork collision adapter before
        // rounding their transformed endpoints into board space.
        for (const stroke of pcbDimensionStrokes(graphic))
          graphics.push(transformPCBGraphic(stroke, point));
      } else graphics.push(transformPCBGraphic(graphic, point));
    }
  }
  let edgeTolerance = 0;
  for (const g of graphics) {
    if (g.layer !== layer && g.layer !== 'Edge.Cuts') continue;
    if (g.kind === 'text') continue;
    if (g.kind === 'dimension') {
      if (g.layer === layer)
        for (const stroke of pcbDimensionStrokes(g))
          add([stroke.start, stroke.end], stroke.width / 2);
      continue;
    }
    const points = graphicVertices(g);
    const arc = g.kind === 'arc' ? pcbArc(g) : null;
    const tolerance =
      g.kind === 'circle'
        ? Math.sqrt(squaredDistance(g.start, g.end)) * (1 - Math.cos(Math.PI / points.length))
        : arc
          ? arc.radius * (1 - Math.cos(Math.abs(arc.delta) / (2 * (points.length - 1))))
          : 0;
    if (g.layer === 'Edge.Cuts') {
      edgeTolerance = Math.max(edgeTolerance, tolerance);
      continue;
    }
    if (g.fill && (g.kind === 'polygon' || g.kind === 'circle'))
      add(points, g.width / 2 + tolerance, { outer: points, holes: [] });
    else
      add(
        g.kind === 'polygon' || g.kind === 'circle' ? [...points, points[0]] : points,
        g.width / 2 + tolerance,
      );
  }
  // No outline permits early layout work. An existing broken outline fails closed.
  const boundary = graphics.some((g) => g.layer === 'Edge.Cuts') ? boardPolygons(board) : [];
  const edgeMargin = margin + edgeTolerance;
  const boundaryEdges = boundary.flatMap(polygonEdges);
  vertices += boundaryEdges.length;
  if (vertices > 120000) throw new Error(limitMessage);
  // Validation and direct paths need exact boundary edges, but no offset
  // clipping. Prepare private detour hints only if a route reaches search.
  // Publish after success so a failed preparation remains retryable.
  let boundaryNodes: Point[] | undefined;
  const detourBoundaryNodes = () =>
    (boundaryNodes ??= boundary.length
      ? offsetPolygons(boundary, -edgeMargin - safety)
          .flatMap((p) => [p.outer, ...p.holes])
          .flat()
      : []);
  // Capture the source support planes during construction, but clip a detour
  // hull only when search needs it. Never reread caller geometry or settings.
  const detourCorners = (obstacle: Obstacle) =>
    (obstacle.corners ??= obstacleCorners(obstacle.cornerBounds));
  // Prepared geometry is private to this router. Every retained candidate still
  // receives exact polygon/segment tests; the tree only removes distant work.
  const tree = obstacleTree(obstacles);

  function visitObstacles(
    bounds: Bounds,
    visit: (obstacle: Obstacle) => boolean,
    spend: () => void,
  ): boolean {
    const pending = tree ? [tree] : [];
    while (pending.length) {
      const node = pending.pop()!;
      spend();
      if (!overlaps(bounds, node)) continue;
      if (node.children) pending.push(...node.children);
      else
        for (const obstacle of node.items!) {
          spend();
          if (overlaps(bounds, obstacle) && !visit(obstacle)) return false;
        }
    }
    return true;
  }

  function checker(budget?: () => void) {
    let work = 0;
    const spend = () => {
      if (++work > 2_000_000) throw new Error(limitMessage);
      budget?.();
    };
    const segmentClear = (a: Point, b: Point) => {
      if (boundary.length) {
        if (![a, b].every((p) => boundary.some((shape) => insidePolygon(p, shape, spend))))
          return false;
        for (const [c, d] of boundaryEdges) {
          spend();
          if (segmentDistance(a, b, c, d) < edgeMargin ** 2) return false;
        }
      }
      return visitObstacles(
        {
          minX: Math.min(a.x, b.x),
          maxX: Math.max(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxY: Math.max(a.y, b.y),
        },
        (o) => {
          if (
            o.polygon &&
            (insidePolygon(a, o.polygon, spend) || insidePolygon(b, o.polygon, spend))
          )
            return false;
          for (const [c, d] of o.edges) {
            spend();
            if (segmentDistance(a, b, c, d) < o.radius ** 2) return false;
          }
          return true;
        },
        spend,
      );
    };
    const clear = (points: Point[]) =>
      points.length === 1
        ? segmentClear(points[0], points[0])
        : points.slice(1).every((p, i) => segmentClear(points[i], p));
    return { clear, spend };
  }
  const invalidCoordinates = (points: Point[]) =>
    !points.length ||
    points.length > 15000 ||
    points.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        Math.abs(p.x) > 100000 ||
        Math.abs(p.y) > 100000,
    );
  function validate(points: Point[], budget?: () => void): string {
    if (invalidCoordinates(points)) return 'Routing coordinates are outside the supported range.';
    try {
      return checker(budget).clear(points) ? '' : blockedMessage;
    } catch (error) {
      return (error as Error).message;
    }
  }
  /** Check a convex swept centreline region, including obstacles wholly inside it.
   * The ordinary routing margin still applies around every boundary segment. */
  function validateRegion(points: Point[], budget?: () => void): string {
    if (invalidCoordinates(points)) return 'Routing coordinates are outside the supported range.';
    try {
      const { clear, spend } = checker(budget);
      if (!clear(points.length > 2 ? points.concat(points[0]) : points)) return blockedMessage;
      if (points.length < 3) return '';
      const shape = { outer: points, holes: [] };
      const minX = Math.min(...points.map((point) => point.x)),
        maxX = Math.max(...points.map((point) => point.x)),
        minY = Math.min(...points.map((point) => point.y)),
        maxY = Math.max(...points.map((point) => point.y));
      const contained = ([a, b]: [Point, Point]) => {
        spend();
        return insidePolygon(a, shape, spend) || insidePolygon(b, shape, spend);
      };
      if (
        !visitObstacles(
          { minX, maxX, minY, maxY },
          (obstacle) => !obstacle.edges.some(contained),
          spend,
        )
      )
        return blockedMessage;
      // A complete board cutout can fit inside the sweep without touching its edges.
      if (boundaryEdges.some(contained)) return blockedMessage;
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  }
  function route(
    start: Point,
    end: Point,
    mode: '45' | 'straight' = '45',
    flip = false,
    budget?: () => void,
    blockedHead: 'clip' | 'omit' = 'clip',
  ): RouteResult {
    const blocked = (message = blockedMessage): RouteResult => {
      const points = [start];
      // Stop the head at the first obstacle, leaving fixed waypoints untouched.
      if (message === blockedMessage && blockedHead === 'clip')
        try {
          const { clear } = checker(budget);
          if (clear([start])) {
            const desired = flip
              ? routePoints(end, start, mode).reverse()
              : routePoints(start, end, mode);
            for (const b of desired.slice(1)) {
              const a = points[points.length - 1];
              if (clear([a, b])) {
                points.push(b);
                continue;
              }
              let low = 0,
                high = 1;
              for (let i = 0; i < 18; i++) {
                const t = (low + high) / 2;
                if (clear([a, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }])) low = t;
                else high = t;
              }
              if (low > 0) points.push({ x: a.x + (b.x - a.x) * low, y: a.y + (b.y - a.y) * low });
              break;
            }
          }
        } catch {
          /* A complexity failure must never become an unchecked route. */
        }
      return { points, blocked: true, message };
    };
    if (![start.x, start.y, end.x, end.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 100000))
      return blocked('Routing coordinates are outside the supported range.');
    try {
      const { clear, spend } = checker(budget);
      if (!clear([start]) || !clear([end])) return blocked();
      const candidates = (a: Point, b: Point) => {
        const first = routePoints(a, b, mode),
          second = routePoints(b, a, mode).reverse();
        return flip ? [second, first] : [first, second];
      };
      for (const path of candidates(start, end))
        if (clear(path)) return { points: path, blocked: false, message: '' };
      if (mode === 'straight' || !walkAround) return blocked();

      // A bounded local visibility graph. Every edge is checked against ALL
      // obstacles, including objects outside the candidate window and hidden layers.
      const padding = Math.max(6, margin * 8);
      const minX = Math.min(start.x, end.x) - padding,
        maxX = Math.max(start.x, end.x) + padding,
        minY = Math.min(start.y, end.y) - padding,
        maxY = Math.max(start.y, end.y) + padding;
      const nearby = obstacles
        .filter((o) => o.maxX >= minX && o.minX <= maxX && o.maxY >= minY && o.minY <= maxY)
        .sort((a, b) => {
          const score = (o: Obstacle) =>
            Math.sqrt(
              squaredDistance(start, { x: (o.minX + o.maxX) / 2, y: (o.minY + o.maxY) / 2 }),
            );
          return score(a) - score(b);
        })
        .slice(0, 56);
      const search = (obstacleCount: number, extraNodes: Point[] = []): Point[] | undefined => {
        const nodes = [start, end];
        const seen = new Set([`${start.x},${start.y}`, `${end.x},${end.y}`]);
        const addNode = (p: Point) => {
          const rounded = { x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) };
          if (
            !Number.isFinite(rounded.x) ||
            !Number.isFinite(rounded.y) ||
            Math.abs(rounded.x) > 100000 ||
            Math.abs(rounded.y) > 100000
          )
            return;
          const key = `${rounded.x},${rounded.y}`;
          if (!seen.has(key) && clear([rounded])) {
            nodes.push(rounded);
            seen.add(key);
          }
        };
        for (const o of nearby.slice(0, obstacleCount))
          for (const p of detourCorners(o)) addNode(p);
        for (const p of detourBoundaryNodes()
          .filter((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)
          .slice(0, 64))
          addNode(p);
        for (const point of extraNodes) addNode(point);
        const costs = nodes.map(() => Infinity),
          closed = new Set<number>();
        const previous = new Map<number, { from: number; path: Point[] }>();
        costs[0] = 0;
        for (let step = 0; step < nodes.length; step++) {
          let next = -1,
            score = Infinity;
          for (let i = 0; i < nodes.length; i++) {
            // Near-45-degree native spans have a per-edge angle tolerance.
            // Euclidean distance stays admissible across any number of them.
            const estimate = costs[i] + Math.sqrt(squaredDistance(nodes[i], end));
            if (!closed.has(i) && estimate < score) {
              next = i;
              score = estimate;
            }
          }
          if (next < 0) break;
          if (next === 1) {
            const parts: Point[][] = [];
            for (let at = 1; at !== 0;) {
              const edge = previous.get(at)!;
              parts.unshift(edge.path.slice(1));
              at = edge.from;
            }
            const points = compact([start, ...parts.flat()]);
            return points;
          }
          closed.add(next);
          for (let i = 1; i < nodes.length; i++) {
            spend();
            if (closed.has(i)) continue;
            // Avoid allocating two rounded path variants when even their travel
            // lower bound cannot improve this node's already checked arrival.
            if (
              costs[next] + Math.max(0, octileDistance(nodes[next], nodes[i]) - 0.00005) >=
              costs[i]
            )
              continue;
            for (const path of candidates(nodes[next], nodes[i])) {
              const cost = costs[next] + length(path);
              if (cost >= costs[i] || !clear(path)) continue;
              costs[i] = cost;
              previous.set(i, { from: next, path });
              break;
            }
          }
        }
      };
      // Dense local artwork need not enter every preview's graph. Grow to the
      // complete bounded candidate set only when the nearby search cannot pass.
      const first = search(32);
      if (first) return { points: first, blocked: false, message: '' };
      const extraNodes = polygonDetourNodes(nearby, { minX, minY, maxX, maxY }, clear, spend);
      if (nearby.length > 32 || extraNodes.length) {
        const points = search(56, extraNodes);
        if (points) return { points, blocked: false, message: '' };
      }
      return blocked();
    } catch (error) {
      return blocked((error as Error).message);
    }
  }
  /** Keep the requested spine on either side of a local obstruction. Unlike an
   * endpoint-only search, a hull walk rejoins that spine as soon as possible. */
  function walk(points: Point[], flip = false, budget?: () => void): RouteResult {
    const blocked = (message = blockedMessage): RouteResult => ({
      points: [],
      blocked: true,
      message,
    });
    if (invalidCoordinates(points))
      return blocked('Routing coordinates are outside the supported range.');
    try {
      const { clear, spend } = checker(budget);
      if (clear(points)) return { points, blocked: false, message: '' };
      if (!walkAround || !clear([points[0]]) || !clear([points.at(-1)!])) return blocked();
      const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
      const difference = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
      const rounded = (p: Point) => ({ x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) });
      const queue = [{ points, depth: 0 }];
      const seen = new Set<string>();
      for (let attempt = 0; queue.length && attempt < 64; attempt++) {
        queue.sort((a, b) => length(a.points) - length(b.points));
        const current = queue.shift()!;
        if (clear(current.points)) return { points: current.points, blocked: false, message: '' };
        if (current.depth >= 32) continue;
        type Hit = {
          startIndex: number;
          endIndex: number;
          hull: Point[];
          entry: Point;
          exit: Point;
          first: number;
          last: number;
        };
        const interval = (hull: Point[]): Hit | undefined => {
          let entry: { index: number; point: Point; edge: number } | undefined;
          for (let index = 0; index < current.points.length - 1; index++) {
            const a = current.points[index],
              b = current.points[index + 1],
              direction = difference(b, a);
            let lower = 0,
              upper = 1,
              first = -1,
              last = -1,
              miss = false;
            for (let edgeIndex = 0; edgeIndex < hull.length; edgeIndex++) {
              spend();
              const origin = hull[edgeIndex],
                edge = difference(hull[(edgeIndex + 1) % hull.length], origin);
              const offset = cross(edge, difference(a, origin)),
                slope = cross(edge, direction);
              if (Math.abs(slope) < 1e-12) {
                if (offset < -1e-9) miss = true;
                continue;
              }
              const t = -offset / slope;
              if (slope > 0 && t > lower) {
                lower = t;
                first = edgeIndex;
              }
              if (slope < 0 && t < upper) {
                upper = t;
                last = edgeIndex;
              }
            }
            if (miss || lower > upper + 1e-9 || upper < -1e-9 || lower > 1 + 1e-9) continue;
            const at = (t: number) =>
              rounded({ x: a.x + direction.x * t, y: a.y + direction.y * t });
            if (!entry && lower > 1e-9 && lower < 1 && first >= 0)
              entry = { index, point: at(lower), edge: first };
            if (entry && upper < 1 - 1e-9 && upper >= -1e-9 && last >= 0)
              return {
                startIndex: entry.index,
                endIndex: index,
                hull,
                entry: entry.point,
                exit: at(Math.max(0, upper)),
                first: entry.edge,
                last,
              };
          }
        };
        let hit: Hit | undefined;
        for (let index = 0; index < current.points.length - 1 && !hit; index++) {
          const a = current.points[index],
            b = current.points[index + 1];
          if (clear([a, b])) continue;
          visitObstacles(
            {
              minX: Math.min(a.x, b.x),
              maxX: Math.max(a.x, b.x),
              minY: Math.min(a.y, b.y),
              maxY: Math.max(a.y, b.y),
            },
            (obstacle) => {
              const collides =
                Boolean(
                  obstacle.polygon &&
                  (insidePolygon(a, obstacle.polygon, spend) ||
                    insidePolygon(b, obstacle.polygon, spend)),
                ) ||
                obstacle.edges.some(([c, d]) => {
                  spend();
                  return segmentDistance(a, b, c, d) < obstacle.radius ** 2;
                });
              if (!collides) return true;
              const candidate = interval(detourCorners(obstacle));
              if (
                candidate &&
                (!hit ||
                  candidate.startIndex < hit.startIndex ||
                  (candidate.startIndex === hit.startIndex &&
                    squaredDistance(current.points[candidate.startIndex], candidate.entry) <
                      squaredDistance(current.points[hit.startIndex], hit.entry)))
              )
                hit = candidate;
              return true;
            },
            spend,
          );
        }
        if (!hit) continue;
        const { startIndex, endIndex, hull, entry, exit, first, last } = hit;
        for (const step of flip ? [-1, 1] : [1, -1]) {
          const arc = [entry];
          let vertex = step === 1 ? (first + 1) % hull.length : first;
          const end = step === 1 ? (last + 1) % hull.length : last;
          for (let count = 0; vertex !== end && count < hull.length; count++) {
            arc.push(rounded(hull[vertex]));
            vertex = (vertex + step + hull.length) % hull.length;
          }
          arc.push(exit);
          const candidate = compact([
            ...current.points.slice(0, startIndex + 1),
            ...arc,
            ...current.points.slice(endIndex + 1),
          ]);
          if (candidate.length > 15000) return blocked(limitMessage);
          const key = JSON.stringify(candidate);
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push({ points: candidate, depth: current.depth + 1 });
        }
      }
      return points.length === 2
        ? route(points[0], points.at(-1)!, '45', flip, budget, 'omit')
        : blocked();
    } catch (error) {
      return blocked((error as Error).message);
    }
  }
  return { route, walk, validate, validateRegion };
}
