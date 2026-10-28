import type { Point } from './circuit';
import type { BoardLine, CopperLayer, PCB } from './pcb';
import { padCopperLayers } from './pcb-connectivity';
import { transformPCBGraphic } from './pcb-geometry';
import { footprintPoint, padDrillPosition } from './pcb-layout';
import {
  boardPolygons,
  circlePolygon,
  filledCopperPolygons,
  graphicVertices,
  intersectPolygons,
  padPolygon,
  strokePolygon,
  subtractPolygons,
  worldZones,
  type Polygon,
} from './pcb-polygons';
import type { ThermalConfig, ThermalModel } from './thermal';

type Geometry = Pick<
  ThermalModel,
  'board' | 'layers' | 'dielectricLayers' | 'barrels' | 'sources' | 'notices'
>;
const limit = { footprints: 256, pads: 3000, copperObjects: 12000, vertices: 120000 };
const point = (p: Point) =>
  Number.isFinite(p.x) &&
  Number.isFinite(p.y) &&
  Math.abs(p.x) <= 100000 &&
  Math.abs(p.y) <= 100000;
const positive = (value: number) => Number.isFinite(value) && value > 0;

function ringArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export function thermalPolygonArea(polygons: Polygon[]): number {
  return polygons.reduce(
    (sum, polygon) =>
      sum +
      ringArea(polygon.outer) -
      polygon.holes.reduce((total, hole) => total + ringArea(hole), 0),
    0,
  );
}

function graphicCopper(graphic: BoardLine): Polygon[] {
  if (graphic.kind === 'text' || graphic.kind === 'dimension')
    throw new Error(
      'Copper text and dimensions are not supported by thermal analysis. Preserve them and use a supported board.',
    );
  const vertices = graphicVertices(graphic);
  const closed = graphic.kind === 'circle' || graphic.kind === 'polygon';
  const polygons: Polygon[] = closed && graphic.fill ? [{ outer: vertices, holes: [] }] : [];
  if (graphic.width > 0)
    polygons.push(...strokePolygon(closed ? [...vertices, vertices[0]] : vertices, graphic.width));
  return polygons;
}

/** Only physical geometry enters this adapter. It never fills a zone or edits a PCB. */
export function prepareThermalGeometry(board: PCB, config: ThermalConfig): Geometry {
  if (
    !['F.Cu,B.Cu', 'F.Cu,In1.Cu,In2.Cu,B.Cu'].includes(board.layers.join(',')) ||
    !positive(board.thickness) ||
    board.thickness > 1000
  )
    throw new Error(
      'Thermal analysis requires a supported two- or four-layer PCB and a finite positive board thickness.',
    );
  const padCount = board.footprints.reduce((sum, footprint) => sum + footprint.pads.length, 0);
  if (
    board.footprints.length > limit.footprints ||
    padCount > limit.pads ||
    board.tracks.length + board.vias.length > limit.copperObjects
  )
    throw new Error(
      'The PCB exceeds the thermal geometry limit (256 footprints, 3000 pads and 12000 tracks/vias).',
    );
  if (new Set(board.footprints.map((footprint) => footprint.id)).size !== board.footprints.length)
    throw new Error('Thermal analysis requires unique footprint IDs.');
  let vertices = 0;
  const inspect = (points: Point[]) => {
    vertices += points.length;
    if (vertices > limit.vertices)
      throw new Error('The PCB exceeds the 120000-vertex thermal geometry limit.');
    if (!points.every(point)) throw new Error('Thermal geometry contains an invalid coordinate.');
  };
  const inspectGraphics = (graphics: BoardLine[]) => {
    for (const g of graphics) {
      if (g.layer !== 'Edge.Cuts' && !g.layer.endsWith('.Cu')) continue;
      inspect([g.start, g.end, ...(g.mid ? [g.mid] : []), ...(g.points ?? [])]);
      if (!Number.isFinite(g.width) || g.width < 0)
        throw new Error('Thermal geometry contains an invalid artwork width.');
    }
  };
  inspectGraphics(board.graphics);
  for (const footprint of board.footprints) {
    inspect([footprint]);
    if (!Number.isFinite(footprint.rotation))
      throw new Error('Thermal geometry contains an invalid footprint rotation.');
    inspectGraphics(footprint.graphics);
    for (const pad of footprint.pads) {
      inspect([pad]);
      if (!positive(pad.size.x) || !positive(pad.size.y) || !Number.isFinite(pad.rotation))
        throw new Error('Thermal geometry contains invalid pad dimensions or rotation.');
      if (pad.type !== 'smd' && !positive(pad.drill ?? 0))
        throw new Error(
          'Every through-hole pad needs a finite positive drill for thermal analysis.',
        );
      if (pad.type === 'smd' && pad.drill !== undefined)
        throw new Error('SMD pads with drill holes are not supported by thermal analysis.');
      if (pad.drillOffset) inspect([pad.drillOffset]);
      if (pad.removeUnusedLayers)
        throw new Error(
          'Thermal analysis cannot infer removed internal through-hole pad layers. Retain this board and use an explicitly defined pad stack.',
        );
    }
  }
  const zones = worldZones(board);
  for (const zone of zones) {
    if (!zone.layer.endsWith('.Cu')) continue;
    inspect(zone.outline);
    for (const hole of zone.holes ?? []) inspect(hole);
    for (const fill of zone.filledPolygons ?? []) inspect(fill.points);
  }
  if (
    zones.some(
      (zone) =>
        zone.layer.endsWith('.Cu') &&
        !zone.keepout &&
        zone.fillEnabled !== false &&
        zone.filledPolygons === undefined,
    )
  )
    throw new Error(
      'Fill copper zones in Layout before thermal analysis. Unfilled or invalidated zone outlines cannot be used as copper.',
    );
  for (const track of board.tracks) {
    inspect([track.start, track.end]);
    if (!positive(track.width) || !board.layers.some((layer) => layer === track.layer))
      throw new Error('Thermal geometry contains an invalid track width or copper layer.');
  }
  for (const via of board.vias) {
    inspect([via]);
    if (!positive(via.drill) || !positive(via.diameter) || via.diameter <= via.drill)
      throw new Error('Thermal geometry contains invalid through-via dimensions.');
  }

  const outline = boardPolygons(board);
  const drills: Polygon[] = [];
  const barrels: ThermalModel['barrels'] = [];
  const barrelKeys = new Set<string>();
  const half = board.thickness / 2;
  const addDrill = (
    id: string,
    position: Point,
    drill: number,
    plated: boolean,
    annulusDiameter?: number,
  ) => {
    const innerRadiusMm = drill / 2;
    drills.push({ outer: circlePolygon(position, innerRadiusMm), holes: [] });
    if (!plated) return;
    const outerRadiusMm = innerRadiusMm + config.viaPlatingMm;
    if (annulusDiameter !== undefined && outerRadiusMm > annulusDiameter / 2 + 1e-8)
      throw new Error(`Configured plating exceeds the copper annulus at ${id}.`);
    const outer = [{ outer: circlePolygon(position, outerRadiusMm), holes: [] }];
    const area = thermalPolygonArea(intersectPolygons(outer, outer));
    if (
      Math.abs(thermalPolygonArea(intersectPolygons(outer, outline)) - area) >
      Math.max(1e-6, area * 1e-5)
    )
      throw new Error(
        'Plated holes touching a board edge or cutout are not supported by thermal analysis.',
      );
    const key = [position.x, position.y, drill].join(',');
    if (barrelKeys.has(key)) return;
    barrelKeys.add(key);
    barrels.push({
      id,
      x: position.x,
      y: position.y,
      innerRadiusMm,
      outerRadiusMm,
      polygons: [],
      zMin: -half,
      zMax: half,
    });
  };
  for (const via of board.vias) addDrill(via.id, via, via.drill, true, via.diameter);
  for (const footprint of board.footprints)
    for (const pad of footprint.pads)
      if (pad.drill)
        addDrill(pad.id, padDrillPosition(footprint, pad), pad.drill, pad.type === 'thru_hole');
  const body = subtractPolygons(outline, drills);
  if (!(thermalPolygonArea(body) > 0))
    throw new Error('The drilled PCB does not contain a positive thermal domain.');
  for (const barrel of barrels)
    barrel.polygons = intersectPolygons(
      [{ outer: circlePolygon(barrel, barrel.outerRadiusMm), holes: [] }],
      body,
    );
  const fills = filledCopperPolygons(board);
  const copper = new Map<CopperLayer, Polygon[]>(board.layers.map((layer) => [layer, []]));
  for (const track of board.tracks)
    copper.get(track.layer)!.push(...strokePolygon([track.start, track.end], track.width));
  for (const via of board.vias)
    for (const layer of board.layers)
      copper.get(layer)!.push({ outer: circlePolygon(via, via.diameter / 2), holes: [] });
  for (const footprint of board.footprints)
    for (const pad of footprint.pads)
      for (const layer of padCopperLayers(board, footprint, pad))
        copper.get(layer as CopperLayer)!.push(padPolygon(footprint, pad));
  const graphics = [
    ...board.graphics,
    ...board.footprints.flatMap((footprint) =>
      footprint.graphics.map((g) => transformPCBGraphic(g, (p) => footprintPoint(footprint, p))),
    ),
  ];
  for (const graphic of graphics)
    if (graphic.layer.endsWith('.Cu')) {
      const group = copper.get(graphic.layer as CopperLayer);
      if (!group)
        throw new Error('Thermal copper artwork refers to an unavailable PCB copper layer.');
      group.push(...graphicCopper(graphic));
    }
  for (const zone of zones)
    if (zone.layer.endsWith('.Cu') && !zone.keepout && zone.fillEnabled !== false) {
      const group = copper.get(zone.layer as CopperLayer);
      if (!group) throw new Error('Thermal copper fill refers to an unavailable PCB copper layer.');
      group.push(...(fills.get(zone.id) ?? []));
    }
  const dielectricThickness =
    (board.thickness - config.copperThicknessMm.reduce((sum, thickness) => sum + thickness, 0)) /
    (board.layers.length - 1);
  const dielectricLayers: Geometry['dielectricLayers'] = [];
  let z = half;
  const layers = board.layers.map((layer, index) => {
    const zMax = z,
      zMin = z - config.copperThicknessMm[index];
    const polygons = intersectPolygons(copper.get(layer)!, body);
    z = zMin;
    if (index < board.layers.length - 1) {
      dielectricLayers.push({ zMin: z - dielectricThickness, zMax: z });
      z -= dielectricThickness;
    }
    return { layer, zMin, zMax, polygons };
  });
  const sources: Geometry['sources'] = config.heatSources
    .filter((source) => source.powerW > 0)
    .map((source) => {
      const footprint = board.footprints.find((candidate) => candidate.id === source.footprintId)!;
      const sideLayer = footprint.side === 'front' ? 'F.Cu' : 'B.Cu';
      const pads = footprint.pads.filter((pad) =>
        padCopperLayers(board, footprint, pad).includes(sideLayer),
      );
      const polygons = intersectPolygons(
        pads.map((pad) => padPolygon(footprint, pad)),
        body,
      );
      const areaMm2 = thermalPolygonArea(polygons);
      if (!(areaMm2 > 1e-8))
        throw new Error(
          `Heat source ${footprint.reference || footprint.id} has no copper pad area on its PCB side.`,
        );
      return {
        ...source,
        ...(footprint.reference ? { reference: footprint.reference } : {}),
        side: footprint.side,
        polygons,
        areaMm2,
      };
    });
  // Bound the derived contours too: clipping and artwork sampling can add vertices.
  vertices = 0;
  for (const polygon of [
    ...body,
    ...layers.flatMap((layer) => layer.polygons),
    ...barrels.flatMap((barrel) => barrel.polygons),
    ...sources.flatMap((source) => source.polygons),
  ]) {
    inspect(polygon.outer);
    for (const hole of polygon.holes) inspect(hole);
  }
  return {
    board: body,
    layers,
    dielectricLayers,
    barrels,
    sources,
    notices: [],
  };
}
