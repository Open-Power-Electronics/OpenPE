import type { Point } from './circuit';
import type { PCB } from './pcb';
import {
  insidePolygon,
  pointSegmentDistance,
  polygonEdges,
  segmentDistance,
  squaredDistance,
  trackTouchesPolygon,
} from './pcb-collision';
import { preparePCBTrackAnchors, type CenteredPCBTrackAnchor } from './pcb-track-anchors';

export const PARASITICS_DEFAULTS = { copperThicknessMm: 0.035, viaPlatingMm: 0.025 } as const;
export const PARASITICS_THICKNESS_RANGE = { min: 0.001, max: 1 } as const;

export type ParasiticsInput = {
  startId: string;
  endId: string;
  copperThicknessMm?: number;
  viaPlatingMm?: number;
};

type PathItem = { id: string; kind: 'track' | 'via' };
export type LayoutParasiticsResult = {
  netId: string;
  netName: string;
  startLayer: string;
  endLayer: string;
  shortestLengthMm: number;
  shortestResistanceOhm: number;
  equivalentResistanceOhm: number;
  copperThicknessMm: number;
  viaPlatingMm: number;
  path: PathItem[];
};

type Track = PCB['tracks'][number];
type Edge = PathItem & { to: number; length: number; resistance: number };
type Graph = Edge[][];
const copperResistivityOhmMm = 1.724e-5; // Copper at 20 °C, in Ω·mm.
const coordinateTolerance = 0.000001; // Millimetres.
const maxNodes = 256;
const limitMessage = 'The selected net exceeds the Layout Parasitics analysis limit.';
const pointsMatch = (a: Point, b: Point) => squaredDistance(a, b) <= coordinateTolerance ** 2;

function bounds(points: readonly Point[], radius = 0) {
  return {
    left: Math.min(...points.map(({ x }) => x)) - radius,
    right: Math.max(...points.map(({ x }) => x)) + radius,
    top: Math.min(...points.map(({ y }) => y)) - radius,
    bottom: Math.max(...points.map(({ y }) => y)) + radius,
  };
}

function mayTouch(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) {
  return (
    a.left <= b.right + coordinateTolerance &&
    b.left <= a.right + coordinateTolerance &&
    a.top <= b.bottom + coordinateTolerance &&
    b.top <= a.bottom + coordinateTolerance
  );
}

function checkContacts(tracks: Track[], anchors: CenteredPCBTrackAnchor[]) {
  let operations = 0;
  const spend = () => {
    if (++operations > 2_000_000) throw new Error(limitMessage);
  };
  const trackBounds = tracks.map(({ start, end, width }) => bounds([start, end], width / 2));
  const anchorBounds = anchors.map(({ polygon }) => bounds(polygon.outer));
  const trackContactMessage =
    'Track copper must join at a shared endpoint without overlapping segments.';
  for (const [index, track] of tracks.entries()) {
    for (let next = index + 1; next < tracks.length; next++) {
      spend();
      const other = tracks[next];
      if (track.layer !== other.layer || !mayTouch(trackBounds[index], trackBounds[next])) continue;
      const distance = segmentDistance(track.start, track.end, other.start, other.end);
      if (distance > ((track.width + other.width) / 2 + coordinateTolerance) ** 2) continue;
      const sharedStart =
        pointsMatch(track.start, other.start) || pointsMatch(track.start, other.end);
      const sharedEnd = pointsMatch(track.end, other.start) || pointsMatch(track.end, other.end);
      if (sharedStart === sharedEnd) throw new Error(trackContactMessage);
      const freeEnd = sharedStart ? track.end : track.start;
      const joint = sharedStart ? track.start : track.end;
      const otherFree = pointsMatch(joint, other.start) ? other.end : other.start;
      if (
        Math.min(
          pointSegmentDistance(freeEnd, other.start, other.end),
          pointSegmentDistance(otherFree, track.start, track.end),
        ) <=
        coordinateTolerance ** 2
      )
        throw new Error(trackContactMessage);
    }
    for (const [anchorIndex, anchor] of anchors.entries()) {
      spend();
      if (!anchor.layers.includes(track.layer)) continue;
      const joinsCenter =
        pointsMatch(track.start, anchor.center) || pointsMatch(track.end, anchor.center);
      const touchesCopper =
        mayTouch(trackBounds[index], anchorBounds[anchorIndex]) &&
        trackTouchesPolygon(track, anchor.polygon, spend);
      if (touchesCopper !== joinsCenter)
        throw new Error('Track copper must connect to a pad or via at its center.');
    }
  }
  const contours = anchors.map(({ polygon }) => polygonEdges(polygon));
  for (const [index, anchor] of anchors.entries()) {
    for (let next = index + 1; next < anchors.length; next++) {
      spend();
      const other = anchors[next];
      if (!anchor.layers.some((layer) => other.layers.includes(layer))) continue;
      if (pointsMatch(anchor.center, other.center))
        throw new Error('Overlapping pads or vias are outside the Layout Parasitics model.');
      if (!mayTouch(anchorBounds[index], anchorBounds[next])) continue;
      const touches =
        insidePolygon(anchor.polygon.outer[0], other.polygon, spend) ||
        insidePolygon(other.polygon.outer[0], anchor.polygon, spend) ||
        contours[index].some(([a, b]) =>
          contours[next].some(([c, d]) => {
            spend();
            return segmentDistance(a, b, c, d) <= coordinateTolerance ** 2;
          }),
        );
      if (touches)
        throw new Error('Overlapping pads or vias are outside the Layout Parasitics model.');
    }
  }
}

function shortestPath(graph: Graph, start: number, end: number) {
  const distances = graph.map(() => Infinity);
  const visited = new Set<number>();
  const predecessors: ({ from: number; edge: Edge } | undefined)[] = [];
  distances[start] = 0;
  for (let pass = 0; pass < graph.length; pass++) {
    let next = -1;
    for (const [node, distance] of distances.entries())
      if (!visited.has(node) && distance < (next === -1 ? Infinity : distances[next])) next = node;
    if (next === -1 || next === end) break;
    visited.add(next);
    for (const edge of graph[next]) {
      const candidate = distances[next] + edge.length;
      if (candidate >= distances[edge.to]) continue;
      distances[edge.to] = candidate;
      predecessors[edge.to] = { from: next, edge };
    }
  }
  if (!Number.isFinite(distances[end]))
    throw new Error('The selected terminals are disconnected in the modeled copper.');
  const reversed: PathItem[] = [];
  let resistance = 0;
  for (let node = end; node !== start;) {
    const { from, edge } = predecessors[node]!;
    resistance += edge.resistance;
    if (reversed.at(-1)?.id !== edge.id) reversed.push({ id: edge.id, kind: edge.kind });
    node = from;
  }
  return { length: distances[end], resistance, path: reversed.reverse() };
}

/** Eliminate internal nodes using conductance so branches and parallel edges combine. */
function equivalentResistance(graph: Graph, start: number, end: number) {
  const network = graph.map((edges) => {
    const neighbors = new Map<number, number>();
    for (const { to, resistance } of edges)
      neighbors.set(to, (neighbors.get(to) ?? 0) + 1 / resistance);
    return neighbors;
  });
  for (const [node, neighbors] of network.entries()) {
    if (node === start || node === end || !neighbors.size) continue;
    const total = [...neighbors.values()].reduce((sum, conductance) => sum + conductance, 0);
    for (const [a, from] of neighbors) {
      const adjacent = network[a];
      adjacent.delete(node);
      for (const [b, to] of neighbors)
        if (a < b) {
          const conductance = (adjacent.get(b) ?? 0) + from * (to / total);
          adjacent.set(b, conductance);
          network[b].set(a, conductance);
        }
    }
  }
  const resistance = 1 / (network[start].get(end) ?? 0);
  if (!Number.isFinite(resistance) || resistance <= 0)
    throw new Error('The selected net exceeds the Layout Parasitics numerical range.');
  return resistance;
}

export function analyzeLayoutParasitics(
  board: PCB,
  input: ParasiticsInput,
): LayoutParasiticsResult {
  const { startId, endId } = input;
  const {
    copperThicknessMm = PARASITICS_DEFAULTS.copperThicknessMm,
    viaPlatingMm = PARASITICS_DEFAULTS.viaPlatingMm,
  } = input;
  const { min, max } = PARASITICS_THICKNESS_RANGE;
  if (
    ![copperThicknessMm, viaPlatingMm].every(
      (value) => Number.isFinite(value) && value >= min && value <= max,
    )
  )
    throw new Error(`Copper thickness and via plating must be between ${min} and ${max} mm.`);
  if (startId === endId) throw new Error('Choose two different copper pads or vias.');
  const terminalNet = (id: string) => {
    for (const footprint of board.footprints)
      for (const pad of footprint.pads) if (pad.id === id) return pad.netId;
    return board.vias.find((via) => via.id === id)?.netId;
  };
  const netId = terminalNet(startId);
  const net = board.nets.find(({ id }) => id === netId);
  if (!net || terminalNet(endId) !== net.id)
    throw new Error('Choose two copper pads or vias on the same assigned net.');
  for (const { graphics, zones } of [board, ...board.footprints]) {
    if (graphics.some(({ layer }) => layer.endsWith('.Cu')))
      throw new Error('Copper artwork is outside the Layout Parasitics model.');
    if (
      zones?.some((zone) => zone.netId === net.id && !zone.keepout && zone.filledPolygons?.length)
    )
      throw new Error(
        'Filled copper zones on the selected net are outside the Layout Parasitics model.',
      );
  }
  const tracks = board.tracks.filter((track) => track.netId === net.id);
  const vias = board.vias.filter((via) => via.netId === net.id);
  if (tracks.length > maxNodes * 2 || vias.length * board.layers.length > maxNodes)
    throw new Error(limitMessage);
  const anchors = preparePCBTrackAnchors(board, { netId: net.id, centers: true, limitMessage });
  if (anchors.length > maxNodes) throw new Error(limitMessage);
  if (!anchors.some(({ id }) => id === startId) || !anchors.some(({ id }) => id === endId))
    throw new Error('Choose two pads or vias with enabled copper layers.');
  checkContacts(tracks, anchors);

  const graph: Graph = [];
  const nodesByLayer = new Map<string, { point: Point; node: number }[]>(
    board.layers.map((layer) => [layer, []]),
  );
  const addNode = () => {
    if (graph.length === maxNodes) throw new Error(limitMessage);
    return graph.push([]) - 1;
  };
  const nodeAt = (layer: string, point: Point) => {
    const locations = nodesByLayer.get(layer)!;
    const matches = locations.filter((entry) => pointsMatch(entry.point, point));
    if (matches.length > 1) throw new Error('Copper junction coordinates are ambiguous.');
    if (matches.length) return matches[0].node;
    const node = addNode();
    locations.push({ point, node });
    return node;
  };
  const addEdge = (from: number, to: number, length: number, area: number, item: PathItem) => {
    const resistance = (copperResistivityOhmMm * length) / area;
    if (from === to || !Number.isFinite(resistance) || resistance <= 0)
      throw new Error('A copper segment has unusable dimensions.');
    graph[from].push({ ...item, to, length, resistance });
    graph[to].push({ ...item, to: from, length, resistance });
  };
  const terminals = new Map<string, { node: number; layer: string }>();
  const viaById = new Map(vias.map((via) => [via.id, via]));
  for (const { id, center, layers } of anchors) {
    const via = viaById.get(id);
    if (via) {
      if (viaPlatingMm > (via.diameter - via.drill) / 2)
        throw new Error('Via plating thickness must fit the selected net’s via annuli.');
      const gap = board.thickness / (board.layers.length - 1);
      const area = Math.PI * viaPlatingMm * (via.drill + viaPlatingMm);
      const nodes = layers.map((layer) => nodeAt(layer, center));
      terminals.set(id, { node: nodes[0], layer: layers[0] });
      for (let index = 1; index < nodes.length; index++)
        addEdge(nodes[index - 1], nodes[index], gap, area, { id, kind: 'via' });
    } else {
      const node = addNode();
      for (const layer of layers) nodesByLayer.get(layer)!.push({ point: center, node });
      terminals.set(id, {
        node,
        layer: layers.length === board.layers.length ? 'All copper layers' : layers.join(', '),
      });
    }
  }
  for (const { id, start, end, width, layer } of tracks)
    addEdge(
      nodeAt(layer, start),
      nodeAt(layer, end),
      Math.sqrt(squaredDistance(start, end)),
      width * copperThicknessMm,
      { id, kind: 'track' },
    );
  const start = terminals.get(startId)!;
  const end = terminals.get(endId)!;
  const shortest = shortestPath(graph, start.node, end.node);
  return {
    netId: net.id,
    netName: net.name,
    startLayer: start.layer,
    endLayer: end.layer,
    shortestLengthMm: shortest.length,
    shortestResistanceOhm: shortest.resistance,
    equivalentResistanceOhm: equivalentResistance(graph, start.node, end.node),
    copperThicknessMm,
    viaPlatingMm,
    path: shortest.path,
  };
}
