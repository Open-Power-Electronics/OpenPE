/** Construct shared, intersected planar contour edges before calling Gmsh.
 * This is bounded geometry preparation, not a finite-element equation solver. */
const precision = 1e9;
const epsilon = 1e-8;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const delta = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
const coordinate = (value) => Math.round(value * precision) / precision;

export function thermalPlanarGraph(model) {
  const points = [],
    pointIds = new Map(),
    edges = [],
    edgeIds = new Map();
  const point = (p) => {
    const x = coordinate(p.x),
      y = coordinate(p.y),
      key = `${x},${y}`;
    let id = pointIds.get(key);
    if (id === undefined) {
      id = points.length;
      points.push({ x, y });
      pointIds.set(key, id);
    }
    return id;
  };
  const edge = (a, b) => {
    if (a === b) throw new Error('Thermal contour contains a zero-length edge.');
    const start = Math.min(a, b),
      end = Math.max(a, b),
      key = `${start},${end}`;
    let id = edgeIds.get(key);
    if (id === undefined) {
      id = edges.length;
      edgeIds.set(key, id);
      const p = points[start],
        q = points[end];
      edges.push({
        a: start,
        b: end,
        splits: new Set([start, end]),
        xmin: Math.min(p.x, q.x),
        xmax: Math.max(p.x, q.x),
        ymin: Math.min(p.y, q.y),
        ymax: Math.max(p.y, q.y),
      });
    }
    return { id, forward: a === start };
  };
  const ring = (vertices) => {
    if (vertices.length < 3) throw new Error('Thermal polygon has fewer than three vertices.');
    const ids = vertices.map(point);
    return ids.map((id, i) => edge(id, ids[(i + 1) % ids.length]));
  };
  const boardLoops = model.board.map((polygon) => [
    ring(polygon.outer),
    ...(polygon.holes ?? []).map(ring),
  ]);
  for (const region of [...model.layers, ...model.sources, ...model.barrels])
    for (const polygon of region.polygons) {
      ring(polygon.outer);
      for (const hole of polygon.holes ?? []) ring(hole);
    }
  if (edges.length > 120000) throw new Error('Thermal contour graph exceeds its edge budget.');
  const cell = Math.max(model.config.meshSizeMm, 0.25),
    buckets = new Map();
  const cells = (e, callback) => {
    for (
      let x = Math.floor((e.xmin - epsilon) / cell);
      x <= Math.floor((e.xmax + epsilon) / cell);
      x++
    )
      for (
        let y = Math.floor((e.ymin - epsilon) / cell);
        y <= Math.floor((e.ymax + epsilon) / cell);
        y++
      )
        callback(`${x},${y}`);
  };
  let references = 0;
  edges.forEach((e, i) =>
    cells(e, (key) => {
      if (++references > 2000000)
        throw new Error('Thermal contour graph exceeds its spatial preparation budget.');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }),
  );
  let comparisons = 0;
  const addEndpoint = (e, id) => {
    const p = points[id],
      a = points[e.a],
      b = points[e.b],
      r = delta(a, b),
      ap = delta(a, p);
    const length = Math.hypot(r.x, r.y),
      projection = (ap.x * r.x + ap.y * r.y) / (length * length);
    if (
      projection >= -epsilon / length &&
      projection <= 1 + epsilon / length &&
      Math.abs(cross(r, ap)) <= epsilon * length
    )
      e.splits.add(id);
  };
  edges.forEach((e, i) => {
    const candidates = new Set();
    cells(e, (key) => {
      for (const j of buckets.get(key)) if (j > i) candidates.add(j);
    });
    for (const j of candidates) {
      const f = edges[j];
      if (
        e.xmax + epsilon < f.xmin ||
        f.xmax + epsilon < e.xmin ||
        e.ymax + epsilon < f.ymin ||
        f.ymax + epsilon < e.ymin
      )
        continue;
      if (++comparisons > 12000000)
        throw new Error('Thermal contour intersections exceed their preparation budget.');
      const a = points[e.a],
        b = points[e.b],
        c = points[f.a],
        d = points[f.b];
      const r = delta(a, b),
        s = delta(c, d),
        q = delta(a, c),
        determinant = cross(r, s);
      const lr = Math.hypot(r.x, r.y),
        ls = Math.hypot(s.x, s.y);
      if (Math.abs(determinant) <= 1e-12 * lr * ls) {
        if (Math.abs(cross(r, q)) > epsilon * lr) continue;
        addEndpoint(e, f.a);
        addEndpoint(e, f.b);
        addEndpoint(f, e.a);
        addEndpoint(f, e.b);
      } else {
        const t = cross(q, s) / determinant,
          u = cross(q, r) / determinant;
        if (t < -epsilon / lr || t > 1 + epsilon / lr || u < -epsilon / ls || u > 1 + epsilon / ls)
          continue;
        let id;
        if (Math.abs(t) * lr < epsilon) id = e.a;
        else if (Math.abs(1 - t) * lr < epsilon) id = e.b;
        else if (Math.abs(u) * ls < epsilon) id = f.a;
        else if (Math.abs(1 - u) * ls < epsilon) id = f.b;
        else id = point({ x: a.x + t * r.x, y: a.y + t * r.y });
        e.splits.add(id);
        f.splits.add(id);
      }
    }
  });
  const segments = [],
    segmentIds = new Map();
  const splitEdges = edges.map((e) => {
    const a = points[e.a],
      b = points[e.b],
      r = delta(a, b);
    const ids = [...e.splits].sort(
      (i, j) => (points[i].x - points[j].x) * r.x + (points[i].y - points[j].y) * r.y,
    );
    return ids.slice(1).map((id, i) => {
      const from = ids[i],
        start = Math.min(from, id),
        end = Math.max(from, id),
        key = `${start},${end}`;
      let segment = segmentIds.get(key);
      if (segment === undefined) {
        segment = segments.length;
        segments.push([start, end]);
        segmentIds.set(key, segment);
      }
      return (from === start ? 1 : -1) * (segment + 1);
    });
  });
  const boundary = new Set();
  const loops = boardLoops.map((polygon) =>
    polygon.map((loop) =>
      loop.flatMap(({ id, forward }) => {
        const split = splitEdges[id];
        split.forEach((n) => boundary.add(Math.abs(n)));
        return forward ? split : [...split].reverse().map((n) => -n);
      }),
    ),
  );
  return {
    points,
    segments,
    loops,
    embedded: segments.flatMap((_, i) => (boundary.has(i + 1) ? [] : [i + 1])),
    comparisons,
  };
}
