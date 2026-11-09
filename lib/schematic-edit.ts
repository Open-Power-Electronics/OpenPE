import {
  type Circuit,
  type Point,
  type Part,
  type Wire,
  pinPositions,
  serializeCircuit,
  snap,
  uid,
  fmt,
} from './circuit';
import { child, children, parseSExpr, val, quote, type SExpr } from './sexpr';
import { symbolAnnotation, unitGraphics } from './library';
import { schematicTexts } from './schematic-text';
import { samePoint, onWire, wireRoute } from './wiring';
import { removePartConnections } from './schematic-delete';
import { documentPinKey, projectNetGroups } from './project-net-groups';
import { fromProjectDocument, toProjectDocument } from './project-document';

type ConnectionNetIdentities = {
  readonly wireNets: ReadonlyMap<string, number>;
  readonly pointNets: ReadonlyMap<string, number>;
};
// Editor transactions replace Circuit objects. Pointer previews reuse their
// immutable source snapshot; weak keys release indexes with those documents.
const connectionNetCache = new WeakMap<Circuit, ConnectionNetIdentities>();
type GestureSourceGeometry = {
  partPins: ReadonlyMap<string, readonly Point[]>;
  pins: readonly Point[];
  wireEnds: readonly Point[];
  endpoints: ReadonlySet<string>;
  branches: ReadonlySet<string>;
  incident: ReadonlyMap<string, readonly Wire[]>;
};
const gestureSourceGeometryCache = new WeakMap<Circuit, GestureSourceGeometry>();
const connectionPointKey = (point: Point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
function gestureSourceGeometry(source: Circuit, immutableSource: boolean): GestureSourceGeometry {
  const cached = immutableSource ? gestureSourceGeometryCache.get(source) : undefined;
  if (cached) return cached;
  const partPins = new Map(
    source.parts.map((part) => [part.id, pinPositions(part, source.libraries[part.libId])]),
  );
  const wireEnds = source.wires.flatMap((wire) => [wire.a, wire.b]);
  const incident = new Map<string, Wire[]>();
  for (const wire of source.wires)
    for (const point of [wire.a, wire.b]) {
      const key = connectionPointKey(point);
      const wires = incident.get(key);
      if (wires) wires.push(wire);
      else incident.set(key, [wire]);
    }
  return {
    partPins,
    pins: [...partPins.values()].flat(),
    wireEnds,
    endpoints: new Set(wireEnds.map(connectionPointKey)),
    branches: new Set([...source.junctions, ...source.labels].map(connectionPointKey)),
    incident,
  };
}
function connectionNetIdentities(
  source: Circuit,
  immutableSource: boolean,
  partPins: GestureSourceGeometry['partPins'],
): ConnectionNetIdentities {
  const cached = immutableSource ? connectionNetCache.get(source) : undefined;
  if (cached) return cached;
  const wireNets = new Map<string, number>(),
    pinNets = new Map<string, number>(),
    pointNets = new Map<string, number>();
  projectNetGroups(source).forEach((group, index) => {
    for (const wire of group.wires) wireNets.set(source.wires[wire].id, index);
    for (const pin of group.pins) pinNets.set(pin, index);
  });
  for (const part of source.parts) {
    const library = source.libraries[part.libId],
      definitions = unitGraphics(library, part.unit || 1).flatMap((group) =>
        children(group, 'pin'),
      ),
      positions = partPins.get(part.id)!;
    positions.forEach((point, index) => {
      const definition = definitions[index];
      if (!definition) throw new Error('A component has inconsistent pin definitions.');
      const net = pinNets.get(documentPinKey(part.id, val(child(definition, 'number'))));
      if (net === undefined) throw new Error('A component pin has no connection identity.');
      pointNets.set(connectionPointKey(point), net);
    });
  }
  const result: ConnectionNetIdentities = Object.freeze({ wireNets, pointNets });
  if (immutableSource) connectionNetCache.set(source, result);
  return result;
}

export type SelectableField = 'Reference' | 'Value' | 'Sim.Params';
export const fieldId = (id: string, field: SelectableField) => `field/${id}/${field}`;
export function selectedField(id: string | null) {
  const match = id?.match(/^field\/([^/]+)\/(Reference|Value|Sim\.Params)$/);
  return match ? { id: match[1], field: match[2] as SelectableField } : null;
}
export function objectPosition(d: Circuit, id: string): Point | null {
  const field = selectedField(id);
  if (field) {
    const p = d.parts.find((p) => p.id === field.id);
    return p ? symbolAnnotation(p, d.libraries[p.libId], field.field) : null;
  }
  return (
    [
      ...d.parts,
      ...d.labels,
      ...d.junctions,
      ...(d.noConnects || []),
      ...schematicTexts(d.original),
    ].find((p) => p.id === id) || null
  );
}
function setFieldPosition(d: Circuit, id: string, position: Point) {
  const field = selectedField(id)!;
  const p = d.parts.find((p) => p.id === field.id)!;
  // Materialize just this instance, preserving imported effects and other fields.
  const raw = children(parseSExpr(serializeCircuit(d)), 'symbol').find(
    (s) => val(child(s, 'uuid')) === p.id,
  )!;
  const property = children(raw, 'property').find((n) => val(n) === field.field)!;
  const at = child(property, 'at')!;
  at[1] = fmt(position.x);
  at[2] = fmt(position.y);
  p.raw = raw;
}

// Floating poses have an immutable gesture basis. Copy only objects that this
// pose can modify so retained symbol libraries and unrelated native content keep
// their identities. Ordinary editing functions still return detached documents.
function selectionPoseCopy(source: Circuit, ids: readonly string[]): Circuit {
  const selected = new Set(ids);
  const owners = new Set(ids.map((id) => selectedField(id)?.id).filter(Boolean));
  const original = source.original?.map((node) =>
    Array.isArray(node) && node[0] === 'text' && selected.has(val(child(node, 'uuid')))
      ? structuredClone(node)
      : node,
  );
  return {
    ...source,
    parts: source.parts.map((part) =>
      selected.has(part.id) || owners.has(part.id) ? { ...part } : part,
    ),
    wires: source.wires.map((wire) => (selected.has(wire.id) ? { ...wire } : wire)),
    labels: source.labels.map((label) => (selected.has(label.id) ? { ...label } : label)),
    junctions: source.junctions.map((point) => (selected.has(point.id) ? { ...point } : point)),
    ...(source.noConnects
      ? {
          noConnects: source.noConnects.map((point) =>
            selected.has(point.id) ? { ...point } : point,
          ),
        }
      : {}),
    ...(original?.some((node, index) => node !== source.original![index]) ? { original } : {}),
  };
}
export function moveSelection(
  source: Circuit,
  ids: string[],
  delta: Point,
  connected = false,
  immutablePose = false,
): Circuit {
  const d = immutablePose ? selectionPoseCopy(source, ids) : structuredClone(source),
    selected = new Set(ids);
  const translate = (p: Point) => ({
    x: Number((p.x + delta.x).toFixed(4)),
    y: Number((p.y + delta.y).toFixed(4)),
  });
  for (const p of d.parts) if (selected.has(p.id)) Object.assign(p, translate(p));
  for (const p of [...d.labels, ...d.junctions, ...(d.noConnects || [])])
    if (selected.has(p.id)) Object.assign(p, translate(p));
  for (const w of d.wires)
    if (selected.has(w.id)) {
      w.a = translate(w.a);
      w.b = translate(w.b);
    }
  for (const text of children(d.original || [], 'text'))
    if (selected.has(val(child(text, 'uuid')))) {
      const at = child(text, 'at')!,
        p = translate({ x: Number(at[1]), y: Number(at[2]) });
      at[1] = fmt(p.x);
      at[2] = fmt(p.y);
    }
  for (const id of ids) {
    const field = selectedField(id),
      position = objectPosition(source, id);
    if (field && position && !selected.has(field.id)) setFieldPosition(d, id, translate(position));
  }
  return connected && (delta.x || delta.y)
    ? rerouteSelectionConnections(source, d, ids, immutablePose)
    : d;
}

/**
 * Reroute once from the original connectivity graph to a complete selection pose.
 * Only a gesture's immutable basis may opt into cached source net identities;
 * generic editing callers can mutate their fixture between calls and stay uncached.
 */
export function rerouteSelectionConnections(
  source: Circuit,
  posed: Circuit,
  ids: readonly string[],
  immutableSource = false,
): Circuit {
  const d = immutableSource
      ? {
          ...posed,
          labels: posed.labels.map((label) => ({ ...label })),
          junctions: posed.junctions.map((point) => ({ ...point })),
          ...(posed.noConnects
            ? { noConnects: posed.noConnects.map((point) => ({ ...point })) }
            : {}),
        }
      : structuredClone(posed),
    selected = new Set(ids);
  const selectedWires = source.wires.filter((w) => selected.has(w.id));
  // A pin merely drawn over a segment is not a KiCad connection. Only endpoints
  // and explicit junction/label anchors may branch while rerouting an existing net.
  const key = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  const geometry = gestureSourceGeometry(source, immutableSource);
  const { endpoints, branches } = geometry;
  const attached = (p: Point, w: (typeof source.wires)[number]) =>
    samePoint(p, w.a) ||
    samePoint(p, w.b) ||
    (onWire(p, w) && (endpoints.has(key(p)) || branches.has(key(p))));
  const anchors = [
    ...geometry.pins,
    ...geometry.wireEnds,
    ...source.labels,
    ...source.junctions,
    ...(source.noConnects || []),
  ];
  const moving: Point[] = [],
    targets = new Map<string, Point>(),
    posedParts = new Map(d.parts.map((p) => [p.id, p])),
    posedWires = new Map(d.wires.map((w) => [w.id, w])),
    posedMarkers = new Map([...d.junctions, ...d.labels].map((p) => [p.id, p])),
    posedPartPins = new Map<string, readonly Point[]>();
  const posedPinsFor = (part: Part) => {
    const cached = posedPartPins.get(part.id);
    if (cached) return cached;
    const next = posedParts.get(part.id)!;
    const pins = pinPositions(next, d.libraries[next.libId]);
    posedPartPins.set(part.id, pins);
    return pins;
  };
  const add = (from: Point, to: Point) => {
    moving.push(from);
    targets.set(key(from), { x: to.x, y: to.y });
  };
  for (const part of source.parts.filter((p) => selected.has(p.id))) {
    const next = posedParts.get(part.id);
    if (!next) throw new Error('A moving component no longer exists.');
    const pins = geometry.partPins.get(part.id)!,
      nextPins = posedPinsFor(part);
    if (pins.length !== nextPins.length) throw new Error('A moving component changed its pins.');
    pins.forEach((pin, index) => add(pin, nextPins[index]));
  }
  for (const wire of selectedWires) {
    const next = posedWires.get(wire.id);
    if (!next) throw new Error('A moving wire no longer exists.');
    add(wire.a, next.a);
    add(wire.b, next.b);
    const dx = wire.b.x - wire.a.x,
      dy = wire.b.y - wire.a.y,
      length = dx * dx + dy * dy;
    for (const point of anchors.filter((p) => attached(p, wire))) {
      const t = length ? ((point.x - wire.a.x) * dx + (point.y - wire.a.y) * dy) / length : 0;
      add(point, {
        x: Number((next.a.x + t * (next.b.x - next.a.x)).toFixed(4)),
        y: Number((next.a.y + t * (next.b.y - next.a.y)).toFixed(4)),
      });
    }
  }
  for (const marker of [...source.junctions, ...source.labels].filter((p) => selected.has(p.id))) {
    const next = posedMarkers.get(marker.id);
    if (next) add(marker, next);
  }
  if (!moving.some((p) => !samePoint(p, targets.get(key(p))!))) return d;
  const incident = geometry.incident;
  const pins = new Set(geometry.pins.map(key));
  const flexible = new Map<string, boolean>();
  const canSlide = (p: Point) => {
    const k = key(p);
    if (!flexible.has(k)) {
      const wires = incident.get(k) || [];
      flexible.set(
        k,
        wires.length > 0 &&
          wires.length <= 2 &&
          !pins.has(k) &&
          !targets.has(k) &&
          wires.every((w) => !selected.has(w.id)) &&
          !source.wires.some((w) => !wires.includes(w) && onWire(p, w)),
      );
    }
    return flexible.get(k)!;
  };
  const slidingBranches = new Map<string, ReadonlySet<string>>();
  const slideBranch = (point: Point, lead: Wire, axis: 'x' | 'y', target: Point) => {
    const k = key(point);
    if (pins.has(k) || targets.has(k)) return false;
    const trunk = source.wires.filter((wire) => wire.id !== lead.id && onWire(point, wire));
    const fixedAxis = axis === 'x' ? 'y' : 'x';
    if (
      !trunk.length ||
      trunk.some(
        (wire) =>
          selected.has(wire.id) ||
          wire.a[fixedAxis] !== point[fixedAxis] ||
          wire.b[fixedAxis] !== point[fixedAxis],
      )
    )
      return false;
    // Include contiguous subdivisions so a later drag can pass the old contact
    // in either direction without stretching any of those stationary segments.
    const collinear = source.wires
      .filter(
        (wire) =>
          wire.id !== lead.id &&
          !selected.has(wire.id) &&
          wire.a[fixedAxis] === point[fixedAxis] &&
          wire.b[fixedAxis] === point[fixedAxis],
      )
      .sort((a, b) => Math.min(a.a[axis], a.b[axis]) - Math.min(b.a[axis], b.b[axis]));
    let min = Infinity,
      max = -Infinity;
    const trunkIds = new Set<string>();
    for (const wire of collinear) {
      const start = Math.min(wire.a[axis], wire.b[axis]),
        end = Math.max(wire.a[axis], wire.b[axis]);
      if (start > max) {
        if (min <= point[axis] && point[axis] <= max) break;
        min = start;
        trunkIds.clear();
      }
      max = Math.max(max, end);
      trunkIds.add(wire.id);
    }
    if (min >= point[axis] || max <= point[axis] || target[axis] < min || target[axis] > max)
      return false;
    // The branch changes its contact along an existing trunk. Its old wire
    // subdivisions and stationary pins stay exact instead of folding backwards
    // when the contact passes them. Interior crossings are not propagated.
    slidingBranches.set(k, trunkIds);
    moving.push(point);
    return true;
  };
  // Slide free bends, subdivisions and branch contacts before adding elbows.
  // A branch can slide only along its existing straight trunk; pins stay fixed.
  const queue = [...targets.keys()];
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    const target = targets.get(k)!;
    for (const w of incident.get(k) || []) {
      if (selected.has(w.id)) continue;
      const other = key(w.a) === k ? w.b : w.a;
      const axis = w.a.y === w.b.y ? 'y' : w.a.x === w.b.x ? 'x' : null;
      if (!axis) continue;
      const next = targets.get(key(other)) || other;
      if (next[axis] === target[axis] || (!canSlide(other) && !slideBranch(other, w, axis, target)))
        continue;
      // Each free coordinate is assigned at most once, bounding propagation.
      if (next[axis] !== other[axis]) continue;
      targets.set(key(other), { ...next, [axis]: target[axis] });
      queue.push(key(other));
    }
  }
  const moved = (p: Point) => targets.get(key(p)) || p;
  const movedOnWire = (p: Point, wire: Wire) =>
    slidingBranches.get(key(p))?.has(wire.id) ? p : moved(p);
  const fixedAnchors = [
    ...geometry.wireEnds,
    ...source.junctions,
    ...source.parts
      .filter((part) => !selected.has(part.id))
      .flatMap((part) => geometry.partPins.get(part.id)!),
  ].filter((point) => !targets.has(key(point)));
  const { wireNets, pointNets } = connectionNetIdentities(
    source,
    immutableSource,
    geometry.partPins,
  );
  const routedNets = new Map<string, number>(),
    segments = new Map<string, Wire[]>();
  const pinTargets = source.parts.flatMap((part) => {
    const next = posedParts.get(part.id)!;
    const before = geometry.partPins.get(part.id)!,
      after = next === part ? before : posedPinsFor(part);
    return before.map((from, index) => ({ from, to: after[index] }));
  });
  const sourceNet = (wire: Wire) => wireNets.get(wire.id) ?? pointNets.get(key(wire.a));
  const routeWithoutNewJoins = (points: Point[], wire: Wire) => {
    const net = sourceNet(wire),
      forbidden = pinTargets
        .filter(({ from }) => {
          if (attached(from, wire)) return false;
          const pinNet = pointNets.get(key(from));
          // A pin drawn over this segment without an explicit anchor remains
          // incidental, even when geometric grouping gave it the same identity.
          return onWire(from, wire) || net === undefined || pinNet === undefined || pinNet !== net;
        })
        .map(({ to }) => to),
      foreign = [
        ...d.wires.filter((other) => routedNets.get(other.id) !== net),
        ...source.wires
          .filter((other) => !segments.has(other.id) && sourceNet(other) !== net)
          .map((other) =>
            selected.has(other.id)
              ? posedWires.get(other.id)!
              : { ...other, a: movedOnWire(other.a, other), b: movedOnWire(other.b, other) },
          ),
      ];
    const clear = (route: Point[]) =>
      route.slice(1).every((b, index) => {
        const segment = { a: route[index], b, id: '' };
        return (
          !forbidden.some((pin) => onWire(pin, segment)) &&
          !foreign.some(
            (other) =>
              onWire(segment.a, other) ||
              onWire(segment.b, other) ||
              onWire(other.a, segment) ||
              onWire(other.b, segment),
          )
        );
      });
    if (clear(points)) return points;
    const a = points[0],
      b = points.at(-1)!,
      candidates = [wireRoute(a, b), wireRoute(a, b, true)];
    // A rotated or mirrored lead may touch a foreign pin or wire endpoint. Keep
    // that connection separate while allowing unanchored interior crossings.
    for (const spacing of [1.27, 2.54, 5.08, 10.16]) {
      const xs = [Math.min(a.x, b.x) - spacing, Math.max(a.x, b.x) + spacing].map((n) =>
          Number(n.toFixed(4)),
        ),
        ys = [Math.min(a.y, b.y) - spacing, Math.max(a.y, b.y) + spacing].map((n) =>
          Number(n.toFixed(4)),
        );
      for (const x of xs) candidates.push([a, { x, y: a.y }, { x, y: b.y }, b]);
      for (const y of ys) candidates.push([a, { x: a.x, y }, { x: b.x, y }, b]);
      for (const x of xs)
        for (const y of ys) {
          candidates.push([a, { x, y: a.y }, { x, y }, { x: b.x, y }, b]);
          candidates.push([a, { x: a.x, y }, { x, y }, { x, y: b.y }, b]);
        }
    }
    const route = candidates.find(clear);
    if (!route)
      throw new Error(
        'Connected movement would join another net. Move the selection farther from nearby connections.',
      );
    return route.filter((point, index) => !index || !samePoint(point, route[index - 1]));
  };
  d.wires = [];
  for (const w of source.wires) {
    const routed: Wire[] = [];
    segments.set(w.id, routed);
    const connectionMoved =
      !samePoint(movedOnWire(w.a, w), w.a) ||
      !samePoint(movedOnWire(w.b, w), w.b) ||
      moving.some((point) => attached(point, w) && !samePoint(movedOnWire(point, w), point));
    const splits = [
      w.a,
      // A moving connection or free bend can pass an interior branch. Keep its
      // anchor in the route even when it does not itself follow the selection.
      // Labels alone remain free to follow the routed wire below.
      ...[...moving, ...(connectionMoved ? fixedAnchors : [])].filter(
        (p) =>
          !selected.has(w.id) &&
          !slidingBranches.get(key(p))?.has(w.id) &&
          attached(p, w) &&
          !samePoint(p, w.a) &&
          !samePoint(p, w.b),
      ),
      w.b,
    ]
      .sort((a, b) => Math.hypot(a.x - w.a.x, a.y - w.a.y) - Math.hypot(b.x - w.a.x, b.y - w.a.y))
      .filter((p, i, all) => !i || !samePoint(p, all[i - 1]));
    let first = true;
    for (let i = 1; i < splits.length; i++) {
      const a = movedOnWire(splits[i - 1], w),
        b = movedOnWire(splits[i], w);
      const aMoved = !samePoint(a, splits[i - 1]);
      const bMoved = !samePoint(b, splits[i]);
      const straight = a.x === b.x || a.y === b.y || (w.a.x !== w.b.x && w.a.y !== w.b.y);
      let points =
        straight || (!aMoved && !bMoved)
          ? [a, b]
          : !aMoved && bMoved
            ? wireRoute(b, a, w.a.x === w.b.x).reverse()
            : wireRoute(a, b, w.a.x === w.b.x);
      if (!selected.has(w.id) && (aMoved || bMoved)) points = routeWithoutNewJoins(points, w);
      for (let j = 1; j < points.length; j++) {
        if (samePoint(points[j - 1], points[j])) continue;
        const segment = { ...w, id: first ? w.id : uid(), a: points[j - 1], b: points[j] };
        if (!first && w.raw) {
          segment.raw = structuredClone(w.raw);
          child(segment.raw, 'uuid')![1] = quote(segment.id);
        }
        d.wires.push(segment);
        routedNets.set(segment.id, wireNets.get(w.id)!);
        routed.push(segment);
        first = false;
      }
    }
  }
  // A stationary pin is an anchor; retain its old connection with an orthogonal stub.
  for (const p of source.parts.filter((p) => !selected.has(p.id)))
    for (const pin of geometry.partPins.get(p.id)!) {
      if (!samePoint(pin, moved(pin))) {
        const wire = source.wires.find((w) => attached(pin, w)) || { id: '', a: pin, b: pin };
        const route = routeWithoutNewJoins(wireRoute(pin, moved(pin)), wire);
        for (let i = 1; i < route.length; i++) {
          const segment = { id: uid(), a: route[i - 1], b: route[i] };
          d.wires.push(segment);
          const net = sourceNet(wire);
          if (net !== undefined) routedNets.set(segment.id, net);
        }
      }
    }
  for (const p of [...d.labels, ...d.junctions, ...(d.noConnects || [])]) {
    if (!selected.has(p.id)) Object.assign(p, moved(p));
  }
  // Interior labels follow their own wire, including a newly introduced elbow.
  for (const label of d.labels) {
    if (selected.has(label.id)) continue;
    const original = source.labels.find((p) => p.id === label.id)!;
    if (targets.has(key(original))) continue;
    const wire = source.wires.find((w) => onWire(original, w));
    if (!wire) continue;
    const routed = segments.get(wire.id)!;
    if (!routed.length) {
      // A short lead disappears when its moving pin reaches the fixed contact.
      // Keep its interior net label on that contact instead of orphaning it.
      const contact = moved(wire.a);
      if (samePoint(contact, moved(wire.b))) Object.assign(label, contact);
      continue;
    }
    if (routed.some((w) => onWire(label, w))) continue;
    const positions = routed.map((w) => {
      const dx = w.b.x - w.a.x,
        dy = w.b.y - w.a.y;
      const t = Math.max(
        0,
        Math.min(1, ((original.x - w.a.x) * dx + (original.y - w.a.y) * dy) / (dx * dx + dy * dy)),
      );
      return { x: w.a.x + t * dx, y: w.a.y + t * dy };
    });
    positions.sort(
      (a, b) =>
        Math.hypot(a.x - original.x, a.y - original.y) -
        Math.hypot(b.x - original.x, b.y - original.y),
    );
    if (positions[0]) Object.assign(label, positions[0]);
  }
  for (const pin of targets.values()) {
    if (
      d.wires.reduce(
        (count, w) =>
          count + (onWire(pin, w) ? (samePoint(w.a, pin) || samePoint(w.b, pin) ? 1 : 2) : 0),
        0,
      ) >= 3 &&
      !d.junctions.some((j) => samePoint(j, pin))
    )
      d.junctions.push({ id: uid(), ...pin });
  }
  const stationaryTrunks = new Set([...slidingBranches.values()].flatMap((ids) => [...ids]));
  const result = simplifyWiresWithPins(d, [...ids], immutableSource, [
    ...d.parts.flatMap((part, index) =>
      source.parts[index] === part && source.libraries[part.libId] === d.libraries[part.libId]
        ? geometry.partPins.get(part.id)!
        : posedPinsFor(part),
    ),
    // Relocating a contact does not replace the trunk's existing UUIDs.
    ...source.wires
      .filter((wire) => stationaryTrunks.has(wire.id))
      .flatMap((wire) => [wire.a, wire.b]),
  ]);
  if (immutableSource) {
    // Cache only a complete successful pose. Invalid proposals remain retryable
    // without certifying partially prepared source geometry.
    gestureSourceGeometryCache.set(source, geometry);
    const wires = new Map(source.wires.map((wire) => [wire.id, wire]));
    result.wires = result.wires.map((wire) => {
      const before = wires.get(wire.id);
      return before &&
        before.raw === wire.raw &&
        before.a.x === wire.a.x &&
        before.a.y === wire.a.y &&
        before.b.x === wire.b.x &&
        before.b.y === wire.b.y
        ? before
        : wire;
    });
    const points = new Map(
      [...posed.labels, ...posed.junctions, ...(posed.noConnects ?? [])].map((point) => [
        point.id,
        point,
      ]),
    );
    const retainPoint = <T extends Point & { id: string }>(point: T): T => {
      const before = points.get(point.id);
      return before && before.x === point.x && before.y === point.y ? (before as T) : point;
    };
    result.labels = result.labels.map(retainPoint);
    result.junctions = result.junctions.map(retainPoint);
    if (result.noConnects) result.noConnects = result.noConnects.map(retainPoint);
  }
  return result;
}
export function moveText(source: Circuit, id: string, target: Point) {
  const origin = objectPosition(source, id);
  if (!origin) throw new Error('The selected text no longer exists.');
  return moveSelection(source, [id], {
    x: snap(target.x) - origin.x,
    y: snap(target.y) - origin.y,
  });
}
/** Placement and Properties share these preparations with Core commands. */
export function saveLabel(
  source: Circuit,
  changes: {
    id?: string;
    text?: string;
    position?: Point;
    scope?: 'global';
    shape?: NonNullable<Circuit['labels'][number]['shape']>;
  },
) {
  const existing = changes.id ? source.labels.find((label) => label.id === changes.id) : undefined;
  if (changes.id && !existing) throw new Error('This net label no longer exists.');
  if (!existing && !changes.position) throw new Error('A new net label needs a position.');
  const text = changes.text ?? existing?.text ?? 'NET';
  if (!text.trim() || text.length > 4096)
    throw new Error('Enter a net name between 1 and 4096 characters.');
  const position = changes.position
    ? { x: snap(changes.position.x), y: snap(changes.position.y) }
    : existing!;
  const scope = changes.scope ?? existing?.scope;
  if (changes.shape && scope !== 'global') throw new Error('Only global labels have a shape.');
  const label = {
    ...existing,
    id: existing?.id ?? uid(),
    x: position.x,
    y: position.y,
    text,
    ...(scope ? { scope } : {}),
    ...(scope === 'global' ? { shape: changes.shape ?? existing?.shape ?? 'input' } : {}),
  };
  return {
    circuit: {
      ...source,
      labels: existing
        ? source.labels.map((item) => (item.id === label.id ? label : item))
        : [...source.labels, label],
    },
    id: label.id,
  };
}

export function placeNoConnect(source: Circuit, position: Point) {
  const point = { x: snap(position.x), y: snap(position.y) };
  if (
    !source.parts.some((part) =>
      pinPositions(part, source.libraries[part.libId]).some((pin) => samePoint(pin, point)),
    )
  )
    throw new Error('Place a no-connect marker on an existing component pin.');
  const existing = source.noConnects?.find((marker) => samePoint(marker, point));
  if (existing) return { circuit: source, id: existing.id };
  const marker = { id: uid(), ...point };
  return {
    circuit: { ...source, noConnects: [...(source.noConnects ?? []), marker] },
    id: marker.id,
  };
}

export function saveAnnotation(source: Circuit, text: string, position: Point, id?: string) {
  if (!text.trim() || text.length > 4096)
    throw new Error('Enter annotation text between 1 and 4096 characters.');
  if (![position.x, position.y].every((n) => Number.isFinite(n) && Math.abs(snap(n)) <= 100000))
    throw new Error('The annotation position is outside the supported grid range.');
  const circuit = structuredClone(source);
  if (id) {
    const node = children(circuit.original || [], 'text').find((n) => val(child(n, 'uuid')) === id);
    if (!node) throw new Error('This annotation no longer exists.');
    node[1] = quote(text);
  } else {
    id = uid();
    circuit.original ||= parseSExpr(serializeCircuit(circuit));
    circuit.original.push([
      'text',
      quote(text),
      ['at', fmt(snap(position.x)), fmt(snap(position.y)), '0'],
      ['effects', ['font', ['size', '1.27', '1.27']], ['justify', 'left', 'top']],
      ['uuid', quote(id)],
    ]);
  }
  schematicTexts(circuit.original);
  return { circuit, id };
}
export function removeSelection(source: Circuit, ids: string[]) {
  const selected = new Set(ids),
    d = removePartConnections(source, selected);
  d.parts = d.parts.filter((p) => !selected.has(p.id));
  d.wires = d.wires.filter((p) => !selected.has(p.id));
  d.labels = d.labels.filter((p) => !selected.has(p.id));
  d.junctions = d.junctions.filter((p) => !selected.has(p.id));
  if (d.noConnects) d.noConnects = d.noConnects.filter((p) => !selected.has(p.id));
  if (d.original)
    d.original = d.original.filter(
      (n) => !Array.isArray(n) || n[0] !== 'text' || !selected.has(val(child(n, 'uuid'))),
    );
  return d;
}
function freshRaw(raw: SExpr | undefined) {
  if (!raw) return undefined;
  const result = structuredClone(raw);
  const visit = (n: SExpr) => {
    for (const c of n.filter((v): v is SExpr => Array.isArray(v))) {
      if (c[0] === 'uuid') c[1] = quote(uid());
      else visit(c);
    }
  };
  visit(result);
  return result;
}
export function duplicateSelection(
  source: Circuit,
  ids: string[],
  delta: Point = { x: 10.16, y: 10.16 },
  reservedReferences: string[] = [],
) {
  const d = structuredClone(source),
    selected = new Set(ids),
    copies: string[] = [],
    refs = new Map<string, string>();
  const clone = <T extends { id: string; raw?: SExpr }>(p: T): T => {
    const v = structuredClone(p);
    v.id = uid();
    if (v.raw) {
      v.raw = freshRaw(v.raw);
      child(v.raw!, 'uuid')![1] = quote(v.id);
    }
    copies.push(v.id);
    return v;
  };
  for (const p of source.parts.filter((p) => selected.has(p.id))) {
    const c = clone(p),
      prefix = p.ref.replace(/\d+$/, '') || 'U';
    let i = 1;
    while (
      d.parts.some((p) => p.ref === prefix + i) ||
      reservedReferences.includes(prefix + i) ||
      [...refs.values()].includes(prefix + i)
    )
      i++;
    if (!refs.has(p.ref)) refs.set(p.ref, prefix + i);
    c.ref = refs.get(p.ref)!;
    d.parts.push(c);
  }
  d.wires.push(...source.wires.filter((p) => selected.has(p.id)).map(clone));
  d.labels.push(...source.labels.filter((p) => selected.has(p.id)).map(clone));
  d.junctions.push(...source.junctions.filter((p) => selected.has(p.id)).map(clone));
  if (source.noConnects)
    d.noConnects!.push(...source.noConnects.filter((p) => selected.has(p.id)).map(clone));
  for (const text of children(source.original || [], 'text'))
    if (selected.has(val(child(text, 'uuid')))) {
      const c = freshRaw(text)!;
      copies.push(val(child(c, 'uuid')));
      d.original!.push(c);
    }
  return { circuit: moveSelection(d, copies, delta), selection: copies };
}

/** Paste a retained same-sheet snapshot without replacing any current objects. */
export function pasteSchematicSelection(
  current: Circuit,
  snapshot: Circuit,
  ids: readonly string[],
  delta: Point = { x: 10.16, y: 10.16 },
): { circuit: Circuit; selection: string[] } {
  if (snapshot.id !== current.id) throw new Error('Copy a selection from this document first.');
  const selection = ids.filter((id) => !selectedField(id));
  const picked = new Set(selection);
  for (const part of snapshot.parts.filter((part) => picked.has(part.id)))
    if (
      current.libraries[part.libId] &&
      JSON.stringify(current.libraries[part.libId]) !==
        JSON.stringify(snapshot.libraries[part.libId])
    )
      throw new Error('The embedded symbol changed. Copy the selection again before pasting.');
  const source = structuredClone(current);
  // Agent snapshots cross the canonical document boundary. Normalize the copied
  // snapshot through that same mapping so GUI copies have identical native
  // metadata/default ordering; untouched live objects keep their original bytes.
  const restored = fromProjectDocument(
    toProjectDocument({
      format: 'openpe',
      version: 1,
      units: 'mm',
      id: snapshot.id,
      schematic: snapshot,
      pcb: null,
      extensions: {},
    }),
  ).schematic;
  for (const key of ['parts', 'wires', 'labels', 'junctions', 'noConnects'] as const)
    Object.assign(source, {
      [key]: [
        ...(source[key] || []).filter((item) => !picked.has(item.id)),
        ...(restored[key] || []).filter((item) => picked.has(item.id)),
      ],
    });
  source.libraries = { ...restored.libraries, ...source.libraries };
  source.original = restored.original;
  const result = duplicateSelection(
    source,
    selection,
    delta,
    current.parts.map((part) => part.ref),
  );
  if (!result.selection.length) return { circuit: current, selection: [] };
  const copies = new Set(result.selection),
    next = structuredClone(current);
  for (const key of ['parts', 'wires', 'labels', 'junctions', 'noConnects'] as const)
    Object.assign(next, {
      [key]: [
        ...(next[key] || []),
        ...(result.circuit[key] || []).filter((item) => copies.has(item.id)),
      ],
    });
  next.libraries = source.libraries;
  const texts = children(result.circuit.original || [], 'text').filter((node) =>
    copies.has(val(child(node, 'uuid'))),
  );
  if (texts.length) {
    next.original ||= parseSExpr(serializeCircuit(next));
    next.original.push(...texts);
  }
  return { circuit: next, selection: result.selection };
}

export function transformSelection(
  source: Circuit,
  ids: string[],
  operation: 'rotate' | 'rotateReverse' | 'mirrorX' | 'mirrorY',
  pivot?: Point,
  immutablePose = false,
) {
  const d = immutablePose ? selectionPoseCopy(source, ids) : structuredClone(source),
    selected = new Set(ids);
  const points = ids.flatMap((id) => {
    const p = objectPosition(d, id),
      w = d.wires.find((w) => w.id === id);
    return p ? [p] : w ? [w.a, w.b] : [];
  });
  if (!points.length) return d;
  const center =
    pivot ??
    (points.length === 1
      ? points[0]
      : {
          x: snap((Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2),
          y: snap((Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2),
        });
  const transform = (p: Point) => {
    const next =
      operation === 'rotate'
        ? { x: center.x + p.y - center.y, y: center.y - p.x + center.x }
        : operation === 'rotateReverse'
          ? { x: center.x - p.y + center.y, y: center.y + p.x - center.x }
          : operation === 'mirrorX'
            ? { x: p.x, y: 2 * center.y - p.y }
            : { x: 2 * center.x - p.x, y: p.y };
    return { x: Number(next.x.toFixed(4)), y: Number(next.y.toFixed(4)) };
  };
  for (const p of d.parts.filter((p) => selected.has(p.id))) {
    Object.assign(p, transform(p));
    if (operation === 'rotate' || operation === 'rotateReverse')
      p.rotation =
        (p.rotation + (p.mirror ? -90 : 90) * (operation === 'rotate' ? 1 : -1) + 360) % 360;
    else {
      const axis = operation === 'mirrorX' ? 'x' : 'y';
      if (p.mirror === axis) delete p.mirror;
      else if (p.mirror) {
        delete p.mirror;
        p.rotation = (p.rotation + 180) % 360;
      } else p.mirror = axis;
    }
  }
  for (const p of [...d.labels, ...d.junctions, ...(d.noConnects || [])].filter((p) =>
    selected.has(p.id),
  ))
    Object.assign(p, transform(p));
  for (const l of d.labels.filter((l) => selected.has(l.id)))
    if (operation === 'rotate' || operation === 'rotateReverse')
      l.rotation = ((l.rotation || 0) + (operation === 'rotate' ? 90 : 270)) % 360;
  for (const w of d.wires.filter((w) => selected.has(w.id))) {
    w.a = transform(w.a);
    w.b = transform(w.b);
  }
  for (const id of ids) {
    const f = selectedField(id),
      p = objectPosition(source, id);
    if (f && p && !selected.has(f.id)) setFieldPosition(d, id, transform(p));
  }
  for (const text of children(d.original || [], 'text'))
    if (selected.has(val(child(text, 'uuid')))) {
      const at = child(text, 'at')!,
        p = transform({ x: Number(at[1]), y: Number(at[2]) });
      at[1] = fmt(p.x);
      at[2] = fmt(p.y);
    }
  return d;
}
function wireEndpointIndex(wires: readonly Wire[]) {
  const cells = new Map<string, number[]>();
  const cell = (coordinate: number) => Math.floor(coordinate / 0.0001);
  wires.forEach((wire, index) => {
    for (const point of [wire.a, wire.b]) {
      const key = `${cell(point.x)},${cell(point.y)}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(index);
      else cells.set(key, [index]);
    }
  });
  return (point: Point) => {
    const x = cell(point.x),
      y = cell(point.y);
    const candidates = new Set<number>();
    // Adjacent cells retain samePoint's Euclidean tolerance at cell boundaries.
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const index of cells.get(`${x + dx},${y + dy}`) ?? []) candidates.add(index);
    return candidates;
  };
}
export function simplifyWires(source: Circuit, retainedIds: string[] = [], immutablePose = false) {
  return simplifyWiresWithPins(
    source,
    retainedIds,
    immutablePose,
    source.parts.flatMap((part) => pinPositions(part, source.libraries[part.libId])),
  );
}
function simplifyWiresWithPins(
  source: Circuit,
  retainedIds: string[],
  immutablePose: boolean,
  pins: readonly Point[],
) {
  const d = immutablePose
    ? { ...source, wires: source.wires.map((wire) => ({ ...wire })) }
    : structuredClone(source);
  const retained = new Set(retainedIds);
  const metadataCache = new Map<SExpr | undefined, string>();
  const metadata = (raw?: SExpr) => {
    const cached = metadataCache.get(raw);
    if (cached !== undefined) return cached;
    const signature = JSON.stringify(
      raw?.filter((n) => !Array.isArray(n) || !['pts', 'uuid'].includes(String(n[0]))) || null,
    );
    metadataCache.set(raw, signature);
    return signature;
  };
  const duplicateCandidates = wireEndpointIndex(d.wires);
  d.wires = d.wires.filter(
    (w, i, all) =>
      !samePoint(w.a, w.b) &&
      ![...duplicateCandidates(w.a)].some((j) => {
        const q = all[j];
        return (
          (retained.has(w.id) === retained.has(q.id) ? j < i : retained.has(q.id)) &&
          metadata(w.raw) === metadata(q.raw) &&
          ((samePoint(w.a, q.a) && samePoint(w.b, q.b)) ||
            (samePoint(w.a, q.b) && samePoint(w.b, q.a)))
        );
      }),
  );
  const protectedPoints = [...d.labels, ...d.junctions, ...(d.noConnects || []), ...pins];
  let changed = true;
  while (changed) {
    changed = false;
    const jointCandidates = wireEndpointIndex(d.wires);
    outer: for (let i = 0; i < d.wires.length; i++)
      for (const j of [
        ...new Set([...jointCandidates(d.wires[i].a), ...jointCandidates(d.wires[i].b)]),
      ]
        .filter((index) => index > i)
        .sort((a, b) => a - b)) {
        const a = d.wires[i],
          b = d.wires[j],
          joint = [a.a, a.b].find((p) => samePoint(p, b.a) || samePoint(p, b.b));
        if (!joint) continue;
        const start = samePoint(a.a, joint) ? a.b : a.a,
          end = samePoint(b.a, joint) ? b.b : b.a;
        if (
          Math.abs(
            (start.x - joint.x) * (end.y - joint.y) - (start.y - joint.y) * (end.x - joint.x),
          ) > 0.0001
        )
          continue;
        if ((start.x - joint.x) * (end.x - joint.x) + (start.y - joint.y) * (end.y - joint.y) >= 0)
          continue;
        if (metadata(a.raw) !== metadata(b.raw) || protectedPoints.some((p) => samePoint(p, joint)))
          continue;
        // Count only after cheap merge tests. Interior crossings still count via
        // the exact geometry predicate, and a third contact already rejects.
        let contacts = 0;
        for (const wire of d.wires) if (onWire(joint, wire) && ++contacts > 2) break;
        if (contacts !== 2) continue;
        a.a = start;
        a.b = end;
        if (retained.has(b.id) && !retained.has(a.id)) {
          a.id = b.id;
          a.raw = b.raw;
        }
        d.wires.splice(j, 1);
        changed = true;
        break outer;
      }
  }
  return d;
}
export function partTransform(p: Part) {
  return `translate(${p.x} ${p.y}) scale(${p.mirror === 'y' ? -1 : 1} ${p.mirror === 'x' ? -1 : 1}) rotate(${-p.rotation})`;
}
