import { thermalPlanarGraph } from './thermal-planar.mjs';

/** PCB-specific mesh preparation only. Gmsh meshes the planar arrangement; Elmer
 * assembles and solves the heat equation on the conformal extruded prisms. */
const number = (value) => {
  if (!Number.isFinite(value)) throw new Error('Thermal geometry contains a nonfinite coordinate.');
  return String(Number(value.toPrecision(14)));
};
const area = (a, b, c) => ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
const center = (points) => ({
  x: points.reduce((n, p) => n + p.x, 0) / points.length,
  y: points.reduce((n, p) => n + p.y, 0) / points.length,
});
function insideRing(point, ring) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      result = !result;
  }
  return result;
}
const insideThermalPolygon = (point, polygon) =>
  insideRing(point, polygon.outer) &&
  !(polygon.holes ?? []).some((ring) => insideRing(point, ring));
const inside = (point, polygons) =>
  polygons.some((polygon) => insideThermalPolygon(point, polygon));
const ringArea = (ring) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p.x * q.y - q.x * p.y;
    }, 0),
  ) / 2;
const polygonArea = (polygons) =>
  polygons.reduce(
    (sum, polygon) =>
      sum +
      ringArea(polygon.outer) -
      (polygon.holes ?? []).reduce((n, hole) => n + ringArea(hole), 0),
    0,
  );

export function thermalGeometry(model) {
  if (model.board.length !== 1)
    throw new Error(
      'Layout Thermal currently requires one contiguous board outline; board cutouts are supported.',
    );
  const lines = [
    'SetFactory("Built-in");',
    'Geometry.Tolerance = 1e-8;',
    'Mesh.MshFileVersion = 2.2;',
    'Mesh.Binary = 0;',
    'Mesh.SaveAll = 0;',
    'Mesh.ElementOrder = 1;',
    'Mesh.Algorithm = 6;',
    `Mesh.MeshSizeMax = ${number(model.config.meshSizeMm)};`,
    `Mesh.MeshSizeMin = ${number(Math.min(model.config.meshSizeMm / 8, 0.01))};`,
    'Mesh.MeshSizeFromCurvature = 0;',
    'Mesh.MeshSizeExtendFromBoundary = 0;',
    'Mesh.MeshSizeFromPoints = 1;',
    'Mesh.MinimumCirclePoints = 16;',
    'General.NumThreads = 2;',
  ];
  const graph = thermalPlanarGraph(model);
  graph.points.forEach((p, i) =>
    lines.push(
      `Point(${i + 1}) = {${number(p.x)},${number(p.y)},0,${number(model.config.meshSizeMm)}};`,
    ),
  );
  graph.segments.forEach(([a, b], i) => lines.push(`Line(${i + 1}) = {${a + 1},${b + 1}};`));
  let nextLoop = 1;
  const surfaces = graph.loops.map((polygon, i) => {
    const loops = polygon.map((edges) => {
      const id = nextLoop++;
      lines.push(`Curve Loop(${id}) = {${edges.join(',')}};`);
      return id;
    });
    lines.push(`Plane Surface(${i + 1}) = {${loops.join(',')}};`);
    return i + 1;
  });
  if (graph.embedded.length)
    lines.push(`Curve{${graph.embedded.join(',')}} In Surface{${surfaces[0]}};`);
  lines.push('Physical Curve(2) = Curve{:};', 'Physical Surface(1) = Surface{:};', 'Mesh 2;');
  return lines.join('\n') + '\n';
}

export function parseThermalPlanarMesh(text) {
  const lines = text.trim().split(/\r?\n/);
  const nodeStart = lines.indexOf('$Nodes'),
    elementStart = lines.indexOf('$Elements');
  if (lines[lines.indexOf('$MeshFormat') + 1] !== '2.2 0 8' || nodeStart < 0 || elementStart < 0)
    throw new Error('Gmsh returned an unsupported mesh encoding.');
  const count = Number(lines[nodeStart + 1]),
    elementCount = Number(lines[elementStart + 1]);
  if (!(count > 0 && count <= 100000) || !(elementCount > 0 && elementCount <= 400000))
    throw new Error(
      'Thermal planar mesh is empty or exceeds the supported mesh budget. Increase Mesh size.',
    );
  const nodes = new Map();
  for (let i = 0; i < count; i++) {
    const [id, x, y, z] = lines[nodeStart + 2 + i].trim().split(/\s+/).map(Number);
    if (![id, x, y, z].every(Number.isFinite) || Math.abs(z) > 1e-7 || nodes.has(id))
      throw new Error('Gmsh returned invalid planar nodes.');
    nodes.set(id, { x, y });
  }
  const triangles = [],
    segments = [];
  for (let i = 0; i < elementCount; i++) {
    const values = lines[elementStart + 2 + i].trim().split(/\s+/).map(Number);
    const ids = values.slice(3 + values[2]);
    if (values[1] === 1) {
      if (ids.length !== 2 || ids.some((id) => !nodes.has(id)))
        throw new Error('Invalid Gmsh constraint edge.');
      segments.push(ids);
      continue;
    }
    if (values[1] !== 2) continue;
    if (ids.length !== 3 || ids.some((id) => !nodes.has(id)))
      throw new Error('Invalid Gmsh triangle.');
    if (Math.abs(area(...ids.map((id) => nodes.get(id)))) <= 1e-16)
      throw new Error('Degenerate Gmsh triangle.');
    if (area(...ids.map((id) => nodes.get(id))) < 0) [ids[1], ids[2]] = [ids[2], ids[1]];
    triangles.push(ids);
  }
  return { nodes, triangles, segments };
}

export function extrudeThermalMesh(planar, model) {
  const kept = planar.triangles.filter((ids) =>
    inside(center(ids.map((id) => planar.nodes.get(id))), model.board),
  );
  if (!kept.length) throw new Error('The PCB mesh contains no board material.');
  const used = [...new Set(kept.flat())].sort((a, b) => a - b);
  const index = new Map(used.map((id, i) => [id, i]));
  const xy = used.map((id) => planar.nodes.get(id));
  const triangles = kept.map((ids) => ids.map((id) => index.get(id)));
  const gapLevels = model.dielectricLayers.flatMap((layer) => {
    const steps = Math.ceil((layer.zMax - layer.zMin) / model.config.meshSizeMm);
    if (!(steps >= 1 && steps <= 1024))
      throw new Error(
        'Thermal thickness resolution exceeds the supported mesh budget. Increase Mesh size.',
      );
    return Array.from(
      { length: steps + 1 },
      (_, i) => layer.zMin + ((layer.zMax - layer.zMin) * i) / steps,
    );
  });
  const levels = [
    ...new Set(
      [...model.layers.flatMap((layer) => [layer.zMin, layer.zMax]), ...gapLevels].map((z) =>
        Number(z.toFixed(10)),
      ),
    ),
  ].sort((a, b) => a - b);
  if (levels.length < 2 || levels.some((z, i) => i > 0 && z - levels[i - 1] < 1e-7))
    throw new Error('PCB thermal layer thickness is below the supported numerical precision.');
  const nodeCount = xy.length * levels.length;
  const elementCount = triangles.length * (levels.length - 1);
  if (nodeCount > 200000 || elementCount > 250000)
    throw new Error(
      `Thermal mesh has ${nodeCount.toLocaleString('en-US')} nodes and ${elementCount.toLocaleString('en-US')} elements (${xy.length.toLocaleString('en-US')} planar nodes; ${levels.length} thickness planes), exceeding the supported 200,000-node / 250,000-element budget. Increase Mesh size.`,
    );
  const sourceAreas = model.sources.map(() => 0);
  const triangleInfo = triangles.map((ids) => {
    const points = ids.map((id) => xy[id]);
    const at = center(points),
      areaMm2 = area(...points);
    const sources = model.sources.flatMap((source, i) => (inside(at, source.polygons) ? [i] : []));
    sources.forEach((i) => {
      sourceAreas[i] += areaMm2;
    });
    return { ids, at, areaMm2, sources };
  });
  const meshArea = triangleInfo.reduce((sum, triangle) => sum + triangle.areaMm2, 0);
  const boardArea = polygonArea(model.board);
  if (Math.abs(meshArea - boardArea) > Math.max(1e-6, boardArea * 1e-6))
    throw new Error(
      `Thermal mesh has overlapping or missing board faces: ${meshArea.toPrecision(9)} mm² meshed; ${boardArea.toPrecision(9)} mm² expected.`,
    );
  for (const region of [...model.layers, ...model.barrels]) {
    const expected = polygonArea(region.polygons);
    if (expected === 0) continue;
    const actual = triangleInfo.reduce(
      (sum, triangle) => sum + (inside(triangle.at, region.polygons) ? triangle.areaMm2 : 0),
      0,
    );
    if (Math.abs(actual - expected) > Math.max(1e-7, expected * 0.02))
      throw new Error(
        `Thermal mesh does not resolve ${region.layer ?? 'plated barrel ' + region.id}: ${actual.toPrecision(9)} mm² meshed; ${expected.toPrecision(9)} mm² expected. Reduce Mesh size.`,
      );
  }
  sourceAreas.forEach((value, i) => {
    if (
      !(value > 0) ||
      Math.abs(value - model.sources[i].areaMm2) / model.sources[i].areaMm2 > 0.02
    )
      throw new Error(
        `Mesh does not resolve the complete heat-source region for ${model.sources[i].reference ?? model.sources[i].footprintId}: ${value.toPrecision(9)} mm² meshed; ${model.sources[i].areaMm2.toPrecision(9)} mm² expected. Reduce Mesh size.`,
      );
  });
  const nodeId = (i, z) => z * xy.length + i + 1;
  const bodyElements = [];
  for (let z = 0; z < levels.length - 1; z++) {
    const middle = (levels[z] + levels[z + 1]) / 2;
    const layer = model.layers.find((layer) => middle > layer.zMin && middle < layer.zMax);
    for (const triangle of triangleInfo) {
      const { at, ids } = triangle;
      const barrel = model.barrels.some((barrel) => {
        return middle >= barrel.zMin && middle <= barrel.zMax && inside(at, barrel.polygons);
      });
      const copper = barrel || (layer && inside(at, layer.polygons));
      bodyElements.push({
        type: 6,
        tag: copper ? 2 : 1,
        ids: [...ids.map((i) => nodeId(i, z)), ...ids.map((i) => nodeId(i, z + 1))],
      });
    }
  }
  const boundaries = [],
    groups = [],
    groupIds = new Map();
  function boundary(ids, side, sourceIds = [], areaM2) {
    const key = `${side}:${sourceIds.join(',')}`;
    let tag = groupIds.get(key);
    if (!tag) {
      tag = 101 + groups.length;
      groupIds.set(key, tag);
      groups.push({
        tag,
        side,
        heatFluxWm2: sourceIds.reduce(
          (q, i) => q + model.sources[i].powerW / (sourceAreas[i] * 1e-6),
          0,
        ),
      });
    }
    boundaries.push({ type: ids.length === 3 ? 2 : 3, tag, ids, side, areaM2 });
  }
  triangleInfo.forEach(({ ids, sources, areaMm2 }) => {
    boundary(
      ids.map((i) => nodeId(i, 0)),
      'bottom',
      sources.filter((i) => model.sources[i].side === 'back'),
      areaMm2 * 1e-6,
    );
    boundary(
      ids.map((i) => nodeId(i, levels.length - 1)),
      'top',
      sources.filter((i) => model.sources[i].side === 'front'),
      areaMm2 * 1e-6,
    );
  });
  const edges = new Map();
  for (const ids of triangles)
    for (let i = 0; i < 3; i++) {
      const edge = [ids[i], ids[(i + 1) % 3]],
        key = [...edge].sort((a, b) => a - b).join(',');
      const item = edges.get(key);
      if (item) item.count++;
      else edges.set(key, { edge, count: 1 });
    }
  for (const segment of planar.segments ?? []) {
    const mapped = segment.map((id) => index.get(id));
    if (
      mapped.some((i) => i === undefined) ||
      !edges.has([...mapped].sort((a, b) => a - b).join(','))
    )
      throw new Error(
        'Gmsh left a copper or heat-source contour outside the conformal PCB triangulation.',
      );
  }
  const onBoardBoundary = (point) =>
    model.board.some((polygon) =>
      [polygon.outer, ...(polygon.holes ?? [])].some((ring) =>
        ring.some((a, i) => {
          const b = ring[(i + 1) % ring.length],
            dx = b.x - a.x,
            dy = b.y - a.y;
          const length = Math.hypot(dx, dy),
            projection = ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length);
          return (
            length > 0 &&
            projection >= -1e-7 &&
            projection <= 1 + 1e-7 &&
            Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / length <= 1e-6
          );
        }),
      ),
    );
  for (const {
    edge: [a, b],
    count,
  } of edges.values()) {
    if (count > 2) throw new Error('Gmsh produced a nonmanifold thermal triangle edge.');
    if (count !== 1) continue;
    if (!onBoardBoundary({ x: (xy[a].x + xy[b].x) / 2, y: (xy[a].y + xy[b].y) / 2 }))
      throw new Error(
        'Gmsh produced an unjoined internal PCB seam; thermal convection cannot be applied there.',
      );
    const lengthMm = Math.hypot(xy[a].x - xy[b].x, xy[a].y - xy[b].y);
    for (let z = 0; z < levels.length - 1; z++)
      boundary(
        [nodeId(a, z), nodeId(b, z), nodeId(b, z + 1), nodeId(a, z + 1)],
        'edge',
        [],
        lengthMm * (levels[z + 1] - levels[z]) * 1e-6,
      );
  }
  const nodes = levels.flatMap((z) => xy.map(({ x, y }) => ({ x, y, z })));
  const all = [...bodyElements, ...boundaries];
  const msh = [
    '$MeshFormat',
    '2.2 0 8',
    '$EndMeshFormat',
    '$Nodes',
    String(nodes.length),
    ...nodes.map(
      ({ x, y, z }, i) => `${i + 1} ${number(x * 0.001)} ${number(y * 0.001)} ${number(z * 0.001)}`,
    ),
    '$EndNodes',
    '$Elements',
    String(all.length),
    ...all.map(
      (element, i) =>
        `${i + 1} ${element.type} 2 ${element.tag} ${element.tag} ${element.ids.join(' ')}`,
    ),
    '$EndElements',
    '',
  ].join('\n');
  return { msh, nodes, boundaries, groups, nodeCount, elementCount, sourceAreasMm2: sourceAreas };
}
