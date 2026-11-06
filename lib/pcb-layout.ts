import { uid, type Circuit, type Point } from './circuit';
import type { BoardLine, BoardText, CopperLayer, Footprint, Pad, PCB } from './pcb';
import { child, children, val, type SExpr } from './sexpr';
import { pcbGraphicPoints, transformPCBGraphic, transformPCBZone } from './pcb-geometry';
import { footprintModels } from './pcb-models';
import { squaredDistance } from './pcb-collision';

export type PCBSelection = {
  kind: 'footprint' | 'track' | 'via' | 'graphic' | 'zone';
  id: string;
};
export type PCBBounds = { minX: number; minY: number; maxX: number; maxY: number };
type Selection = PCBSelection | readonly PCBSelection[];

const round = (n: number) => Number(n.toFixed(6));
const angle = (n: number) => round(((n % 360) + 360) % 360);
function fail(message: string): never {
  throw new Error(`Layout: ${message}`);
}
const coordinate = (n: number) => {
  if (!Number.isFinite(n) || Math.abs(n) > 100000) fail('Coordinates must be within ±100000 mm.');
  return round(n);
};
const point = (p: Point): Point => ({ x: coordinate(p.x), y: coordinate(p.y) });

export function createEmptyPCB(): PCB {
  return {
    id: uid(),
    thickness: 1.6,
    layers: ['F.Cu', 'B.Cu'],
    nets: [],
    footprints: [],
    tracks: [],
    vias: [],
    graphics: [],
    zones: [],
  };
}

/** Native PCB coordinates are already mirrored for a back-side footprint.
 * KiCad 10 rotates local coordinates counterclockwise in its downward-Y canvas;
 * applying another reflection merely because side is back would misplace pads.
 */
export function footprintPoint(footprint: Footprint, local: Point): Point {
  const radians = (-footprint.rotation * Math.PI) / 180;
  return {
    x: round(footprint.x + local.x * Math.cos(radians) - local.y * Math.sin(radians)),
    y: round(footprint.y + local.x * Math.sin(radians) + local.y * Math.cos(radians)),
  };
}
export const padPosition = (footprint: Footprint, pad: Pad) => footprintPoint(footprint, pad);
/** Positive KiCad angle; negate this value for an SVG rotate transform. */
export const padRotation = (footprint: Footprint, pad: Pad) =>
  angle(footprint.rotation + pad.rotation);
export function padDrillPosition(footprint: Footprint, pad: Pad): Point {
  const at = padPosition(footprint, pad),
    offset = pad.drillOffset ?? { x: 0, y: 0 };
  return footprintPoint({ ...footprint, ...at, rotation: padRotation(footprint, pad) }, offset);
}

/** Flip through the footprint origin's horizontal board axis, preserving IDs/nets. */
export function flipPCBFootprint(footprint: Footprint): Footprint {
  if (footprint.locked) fail('Unlock the footprint before editing.');
  const mirror = (p: Point): Point => ({ x: p.x, y: -p.y || 0 });
  const flipText = (text: BoardText): BoardText => {
    const { justify, ...rest } = text;
    const next = justify?.includes('mirror')
      ? justify.filter((v) => v !== 'mirror')
      : [...(justify ?? []), 'mirror' as const];
    return { ...rest, rotation: angle(-text.rotation), ...(next.length ? { justify: next } : {}) };
  };
  return {
    ...footprint,
    side: footprint.side === 'front' ? 'back' : 'front',
    rotation: angle(-footprint.rotation),
    pads: footprint.pads.map((p) => ({
      ...p,
      ...mirror(p),
      rotation: angle(-p.rotation),
      ...(p.drillOffset ? { drillOffset: mirror(p.drillOffset) } : {}),
      ...(p.layers
        ? {
            layers: p.layers.map(
              (l) =>
                l
                  .replace(/^F\./, 'temporary.')
                  .replace(/^B\./, 'F.')
                  .replace(/^temporary\./, 'B.') as NonNullable<Pad['layers']>[number],
            ),
          }
        : {}),
      ...(p.chamfer
        ? {
            chamfer: p.chamfer.map(
              (c) =>
                c
                  .replace(/^top_/, 'temporary_')
                  .replace(/^bottom_/, 'top_')
                  .replace(/^temporary_/, 'bottom_') as NonNullable<Pad['chamfer']>[number],
            ),
          }
        : {}),
    })),
    graphics: footprint.graphics.map((g) => ({
      ...transformPCBGraphic(g, mirror, (n) => angle(-n)),
      ...(g.text ? { text: flipText(g.text) } : {}),
      layer: (g.layer.startsWith('F.')
        ? g.layer.replace(/^F\./, 'B.')
        : g.layer.replace(/^B\./, 'F.')) as BoardLine['layer'],
    })),
    ...(footprint.zones
      ? {
          zones: footprint.zones.map((z) => ({
            ...transformPCBZone(z, mirror),
            layer: z.layer
              .replace(/^F\./, 'temporary.')
              .replace(/^B\./, 'F.')
              .replace(/^temporary\./, 'B.') as BoardLine['layer'],
          })),
        }
      : {}),
  };
}

function allowedChildren(node: SExpr, allowed: readonly string[], context: string) {
  const seen = new Set<string>();
  for (const item of node.filter((n): n is SExpr => Array.isArray(n))) {
    const name = String(item[0]);
    if (!allowed.includes(name))
      fail(`${context} uses unsupported ${name}. Choose another footprint.`);
    if (seen.has(name)) fail(`${context} repeats ${name}. Choose another footprint.`);
    seen.add(name);
  }
}
function sourceNumber(node: SExpr | undefined, index: number, context: string, optional = false) {
  const raw = val(node, index);
  if (!raw && optional) return 0;
  const n = Number(raw);
  if (
    !raw ||
    !Number.isFinite(n) ||
    Math.abs(n) > 100000 ||
    Math.abs(n - Number(n.toFixed(6))) > 1e-9
  )
    fail(`${context} needs finite dimensions at 0.000001 mm precision.`);
  return n;
}
const sourcePoint = (node: SExpr | undefined, context: string): Point => ({
  x: sourceNumber(node, 1, context),
  y: sourceNumber(node, 2, context),
});
function tuple(node: SExpr | undefined, min: number, max: number, context: string) {
  if (!node || node.length < min + 1 || node.length > max + 1 || node.slice(1).some(Array.isArray))
    fail(`${context} uses unsupported coordinates or dimensions.`);
}
function sourcePositive(node: SExpr | undefined, index: number, context: string) {
  const n = sourceNumber(node, index, context);
  if (n < 0.0001 || n > 1000) fail(`${context} must be between 0.0001 and 1000 mm.`);
  return n;
}

/** Convert only geometry represented exactly by the existing PCB v1 schema.
 * Library metadata/3D links and standard reference/value captions are not board
 * geometry: the board serializer regenerates those captions from the schematic.
 * Pads remain unassigned until the user explicitly assigns a board net.
 */
export function createPCBFootprint(
  detail: { id: string; footprint: SExpr },
  circuit: Circuit,
  symbolId: string,
  at: Point,
): Footprint {
  const root = detail.footprint;
  const symbol = circuit.parts.find((p) => p.id === symbolId);
  if (!symbol) fail('Choose a component in the primary schematic before placing a footprint.');
  const library = circuit.libraries[symbol.libId];
  if (!library) fail('The schematic component has no embedded symbol.');
  if (
    !detail.id.includes(':') ||
    detail.id.length > 4096 ||
    root[0] !== 'footprint' ||
    detail.id.split(':').slice(1).join(':') !== val(root)
  )
    fail('The selected footprint does not match its library identity.');
  if (root.length > 10000) fail('This footprint exceeds the supported size.');
  if (val(child(root, 'layer')) !== 'F.Cu')
    fail('Only front-side library footprints can be placed.');
  const pins = new Set(
    children(library, 'symbol')
      .flatMap((unit) => children(unit, 'pin'))
      .map((pin) => val(child(pin, 'number'))),
  );
  const pads: Pad[] = [],
    graphics: BoardLine[] = [];
  const graphicLayers = ['F.SilkS', 'B.SilkS', 'F.Fab', 'B.Fab', 'F.CrtYd', 'B.CrtYd'];
  for (const node of root.slice(2)) {
    if (!Array.isArray(node)) fail('This footprint contains an unsupported top-level flag.');
    const kind = String(node[0]);
    if (
      [
        'version',
        'generator',
        'generator_version',
        'layer',
        'descr',
        'tags',
        'tstamp',
        'uuid',
        'model',
      ].includes(kind)
    )
      continue;
    if (kind === 'embedded_fonts' || kind === 'duplicate_pad_numbers_are_jumpers') {
      if (val(node) !== 'no') fail(`Footprints with ${kind} enabled are not supported.`);
      continue;
    }
    if (kind === 'attr') {
      if (node.slice(1).some((a) => a !== 'smd' && a !== 'through_hole'))
        fail('This footprint uses unsupported placement attributes.');
      continue;
    }
    if (kind === 'property') {
      if (
        !['Reference', 'Value', 'Datasheet', 'Description'].includes(val(node)) &&
        val(child(node, 'hide')) !== 'yes'
      )
        fail('Custom visible footprint properties are not supported.');
      continue;
    }
    if (kind === 'fp_text') {
      if (
        !['reference', 'value'].includes(val(node)) &&
        !(val(node) === 'user' && val(node, 2) === '${REFERENCE}')
      )
        fail('Custom footprint text is not supported. Choose a footprint without custom text.');
      continue;
    }
    if (kind === 'pad') {
      allowedChildren(
        node,
        [
          'at',
          'size',
          'drill',
          'layers',
          'uuid',
          'tstamp',
          'remove_unused_layers',
          'roundrect_rratio',
        ],
        'The pad',
      );
      const type = val(node, 2),
        shape = val(node, 3),
        number = val(node);
      if (type !== 'smd' && type !== 'thru_hole') fail(`Pad type ${type} is not supported.`);
      if (!['rect', 'circle', 'oval', 'roundrect'].includes(shape))
        fail(
          `Pad shape ${shape} is not supported. Use rectangular, circular, oval or rounded rectangular pads.`,
        );
      const ratioNode = child(node, 'roundrect_rratio');
      if ((shape === 'roundrect') !== Boolean(ratioNode))
        fail(
          'Rounded rectangular pads require an explicit corner ratio; other pad shapes cannot use it.',
        );
      let roundrectRatio: number | undefined;
      if (ratioNode) {
        tuple(ratioNode, 1, 1, 'Pad corner ratio');
        roundrectRatio = sourceNumber(ratioNode, 1, 'Pad corner ratio');
        if (roundrectRatio < 0 || roundrectRatio > 0.5)
          fail('Pad corner ratio must be between 0 and 0.5.');
      }
      if (!pins.has(number))
        fail(`${symbol.ref} has no pin ${number || '(unnumbered)'} for this footprint pad.`);
      tuple(child(node, 'size'), 2, 2, 'Pad size');
      tuple(child(node, 'at'), 2, 3, 'Pad position');
      const size = {
        x: sourcePositive(child(node, 'size'), 1, 'Pad width'),
        y: sourcePositive(child(node, 'size'), 2, 'Pad height'),
      };
      if (shape === 'circle' && size.x !== size.y)
        fail('Circular pads must have equal width and height.');
      const layers = child(node, 'layers')
        ?.slice(1)
        .map((_, i) => val(child(node, 'layers'), i + 1))
        .sort();
      const expectedLayers = type === 'smd' ? ['F.Cu', 'F.Mask', 'F.Paste'] : ['*.Cu', '*.Mask'];
      if (JSON.stringify(layers) !== JSON.stringify(expectedLayers))
        fail('Custom pad layer sets are not supported.');
      const remove = child(node, 'remove_unused_layers');
      if (remove && val(remove) !== 'no')
        fail('Pads that remove unused copper layers are not supported.');
      const drillNode = child(node, 'drill');
      if (drillNode && (drillNode.length !== 2 || type !== 'thru_hole'))
        fail('Slotted, offset or SMD drills are not supported.');
      const drill = type === 'thru_hole' ? sourcePositive(drillNode, 1, 'Pad drill') : undefined;
      if (drill !== undefined && drill >= Math.min(size.x, size.y))
        fail('A through-hole drill must be smaller than its copper pad.');
      const position = child(node, 'at');
      pads.push({
        id: uid(),
        number,
        ...sourcePoint(position, 'Pad position'),
        rotation: angle(sourceNumber(position, 3, 'Pad rotation', true)),
        type,
        shape: shape as Pad['shape'],
        ...(roundrectRatio === undefined ? {} : { roundrectRatio }),
        size,
        ...(drill === undefined ? {} : { drill }),
        netId: null,
      });
    } else if (kind === 'fp_line' || kind === 'fp_rect' || kind === 'fp_poly') {
      allowedChildren(
        node,
        [
          ...(kind === 'fp_poly' ? ['pts'] : ['start', 'end']),
          'stroke',
          'layer',
          'fill',
          'uuid',
          'tstamp',
        ],
        'The footprint graphic',
      );
      const layer = val(child(node, 'layer'));
      if (!graphicLayers.includes(layer)) fail(`Footprint graphics on ${layer} are not supported.`);
      const fill = val(child(node, 'fill'));
      if (fill && fill !== 'no' && fill !== 'none')
        fail('Filled footprint graphics are not supported.');
      const stroke = child(node, 'stroke');
      if (!stroke) fail('The footprint graphic has no supported stroke.');
      allowedChildren(stroke, ['width', 'type'], 'The graphic stroke');
      if (!['solid', 'default'].includes(val(child(stroke, 'type'))))
        fail('Dashed footprint graphics are not supported.');
      const width = sourcePositive(child(stroke, 'width'), 1, 'Graphic width');
      let points: Point[];
      if (kind === 'fp_poly') {
        const pts = child(node, 'pts');
        if (!pts || pts.slice(1).some((p) => !Array.isArray(p) || p[0] !== 'xy'))
          fail('Curved footprint polygons are not supported.');
        points = children(pts, 'xy').map((p) => {
          tuple(p, 2, 2, 'Polygon vertex');
          return sourcePoint(p, 'Polygon vertex');
        });
        if (points.length < 3) fail('A footprint polygon needs at least three vertices.');
        points.push(points[0]);
      } else {
        tuple(child(node, 'start'), 2, 2, 'Graphic start');
        tuple(child(node, 'end'), 2, 2, 'Graphic end');
        const start = sourcePoint(child(node, 'start'), 'Graphic start'),
          end = sourcePoint(child(node, 'end'), 'Graphic end');
        points =
          kind === 'fp_rect'
            ? [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start]
            : [start, end];
      }
      for (let i = 1; i < points.length; i++)
        graphics.push({
          id: uid(),
          start: { ...points[i - 1] },
          end: { ...points[i] },
          width,
          layer: layer as BoardLine['layer'],
        });
    } else
      fail(
        `Footprint feature ${kind} is not supported. Choose a footprint with straight graphics and rectangular, circular, oval or rounded rectangular pads.`,
      );
    if (pads.length > 2000 || graphics.length > 2000)
      fail('This footprint exceeds the supported geometry limit.');
  }
  if (!pads.length) fail('Choose a footprint with numbered electrical pads.');
  return {
    id: uid(),
    symbolId,
    libraryId: detail.id,
    ...point(at),
    rotation: 0,
    side: 'front',
    pads,
    graphics,
    ...(children(root, 'model').length ? { models: footprintModels(root) } : {}),
  };
}

function selected(selection: Selection, kind: PCBSelection['kind'], id: string) {
  return (Array.isArray(selection) ? selection : [selection]).some(
    (s) => s.kind === kind && s.id === id,
  );
}

export function assertPCBSelectionUnlocked(board: PCB, selection: Selection) {
  if (
    board.graphics.some((graphic) => graphic.locked && selected(selection, 'graphic', graphic.id))
  )
    fail('Unlock selected graphics before editing.');
  if (
    board.footprints.some(
      (footprint) => footprint.locked && selected(selection, 'footprint', footprint.id),
    )
  )
    fail('Unlock selected footprints before editing.');
  if (board.tracks.some((track) => track.locked && selected(selection, 'track', track.id)))
    fail('Unlock selected tracks before editing.');
  if (board.vias.some((via) => via.locked && selected(selection, 'via', via.id)))
    fail('Unlock selected vias before editing.');
  if (board.zones.some((zone) => zone.locked && selected(selection, 'zone', zone.id)))
    fail('Unlock selected zones before editing.');
}

export function setPCBTrackProperties(
  board: PCB,
  trackId: string,
  changes: { netId?: string; layer?: CopperLayer; width?: number; locked?: boolean },
): PCB {
  const track = board.tracks.find((track) => track.id === trackId);
  if (!track) fail('The selected track is no longer on this board.');
  if (changes.netId !== undefined && !board.nets.some((net) => net.id === changes.netId))
    fail('Choose an existing track net.');
  if (changes.layer !== undefined && !board.layers.some((layer) => layer === changes.layer))
    fail('Choose an existing copper layer.');
  if (
    changes.width !== undefined &&
    (!Number.isFinite(changes.width) || changes.width <= 0 || changes.width > 1000)
  )
    fail('Track width must be greater than zero and at most 1000 mm.');
  const { locked } = changes;
  const next = { ...track };
  if (changes.netId !== undefined) next.netId = changes.netId;
  if (changes.layer !== undefined) next.layer = changes.layer;
  if (changes.width !== undefined) next.width = changes.width;
  if (locked === false) delete next.locked;
  else if (locked === true) next.locked = true;
  if (
    track.locked &&
    locked !== false &&
    (next.netId !== track.netId || next.layer !== track.layer || next.width !== track.width)
  )
    fail('Unlock the track before changing its properties.');
  if (JSON.stringify(next) === JSON.stringify(track)) return board;
  return { ...board, tracks: board.tracks.map((item) => (item.id === trackId ? next : item)) };
}

export function movePCBSelection(board: PCB, selection: Selection, delta: Point): PCB {
  const d = point(delta);
  if (!d.x && !d.y) return board;
  assertPCBSelectionUnlocked(board, selection);
  const move = (p: Point) => point({ x: p.x + d.x, y: p.y + d.y });
  return {
    ...board,
    footprints: board.footprints.map((f) =>
      selected(selection, 'footprint', f.id) ? { ...f, ...move(f) } : f,
    ),
    vias: board.vias.map((v) => (selected(selection, 'via', v.id) ? { ...v, ...move(v) } : v)),
    tracks: board.tracks.map((t) =>
      selected(selection, 'track', t.id) ? { ...t, start: move(t.start), end: move(t.end) } : t,
    ),
    graphics: board.graphics.map((g) =>
      selected(selection, 'graphic', g.id) ? transformPCBGraphic(g, move) : g,
    ),
    zones: board.zones.map((z) =>
      selected(selection, 'zone', z.id) ? transformPCBZone(z, move) : z,
    ),
  };
}
/** A supplied pivot rotates the complete selection as one group in board coordinates. */
export function rotatePCBSelection(
  board: PCB,
  selection: Selection,
  degrees = 90,
  pivot?: Point,
): PCB {
  if (!Number.isFinite(degrees)) fail('Rotation must be finite.');
  const origin = pivot ? point(pivot) : undefined;
  if (!angle(degrees)) return board;
  assertPCBSelectionUnlocked(board, selection);
  const rotate = (p: Point, center: Point) =>
    point(
      footprintPoint({ ...center, rotation: degrees } as Footprint, {
        x: p.x - center.x,
        y: p.y - center.y,
      }),
    );
  const line = <T extends { start: Point; end: Point }>(item: T): T => {
    const center = origin ?? {
      x: (item.start.x + item.end.x) / 2,
      y: (item.start.y + item.end.y) / 2,
    };
    return { ...item, start: rotate(item.start, center), end: rotate(item.end, center) };
  };
  return {
    ...board,
    footprints: board.footprints.map((f) =>
      selected(selection, 'footprint', f.id)
        ? { ...f, ...(origin ? rotate(f, origin) : {}), rotation: angle(f.rotation + degrees) }
        : f,
    ),
    vias: origin
      ? board.vias.map((v) =>
          selected(selection, 'via', v.id) ? { ...v, ...rotate(v, origin) } : v,
        )
      : board.vias,
    tracks: board.tracks.map((t) => (selected(selection, 'track', t.id) ? line(t) : t)),
    graphics: board.graphics.map((g) => {
      if (!selected(selection, 'graphic', g.id)) return g;
      const center = origin ?? {
        x: (g.start.x + g.end.x) / 2,
        y: (g.start.y + g.end.y) / 2,
      };
      return transformPCBGraphic(
        g,
        (p) => rotate(p, center),
        (n) => angle(n + degrees),
      );
    }),
    zones: board.zones.map((z) => {
      if (!selected(selection, 'zone', z.id)) return z;
      const center = origin ?? {
        x: z.outline.reduce((n, p) => n + p.x, 0) / z.outline.length,
        y: z.outline.reduce((n, p) => n + p.y, 0) / z.outline.length,
      };
      return transformPCBZone(z, (p) => rotate(p, center));
    }),
  };
}
/** Pickup flips reflect package origins across the anchor's horizontal axis. */
export function flipPCBSelection(board: PCB, selection: Selection, pivot?: Point): PCB {
  const origin = pivot ? point(pivot) : undefined;
  return {
    ...board,
    footprints: board.footprints.map((footprint) => {
      if (!selected(selection, 'footprint', footprint.id)) return footprint;
      const flipped = flipPCBFootprint(footprint);
      return origin ? { ...flipped, y: coordinate(2 * origin.y - footprint.y) } : flipped;
    }),
  };
}

export type PCBMoveOperation = 'rotate' | 'rotateReverse' | 'flip';

/** Apply the same ordered pickup edits as the canvas, then place its exact pose. */
export function previewPCBMove(
  board: PCB,
  selection: readonly PCBSelection[],
  anchor: Point,
  target: Point,
  operations: readonly PCBMoveOperation[] = [],
): PCB {
  const origin = point(anchor),
    destination = point(target);
  let posed = board;
  for (const operation of operations)
    posed =
      operation === 'flip'
        ? flipPCBSelection(posed, selection, origin)
        : rotatePCBSelection(posed, selection, operation === 'rotate' ? 90 : -90, origin);
  return movePCBSelection(posed, selection, {
    x: destination.x - origin.x,
    y: destination.y - origin.y,
  });
}

export function deletePCBSelection(board: PCB, selection: Selection): PCB {
  assertPCBSelectionUnlocked(board, selection);
  return {
    ...board,
    footprints: board.footprints.filter((f) => !selected(selection, 'footprint', f.id)),
    tracks: board.tracks.filter((t) => !selected(selection, 'track', t.id)),
    vias: board.vias.filter((v) => !selected(selection, 'via', v.id)),
    graphics: board.graphics.filter((g) => !selected(selection, 'graphic', g.id)),
    zones: board.zones.filter((z) => !selected(selection, 'zone', z.id)),
  };
}

/** Keep precise pad endpoints; only pointer placement is snapped by the caller. */
export function routePoints(start: Point, end: Point, mode: 'straight' | '45' = '45'): Point[] {
  const a = point(start),
    b = point(end),
    dx = b.x - a.x,
    dy = b.y - a.y;
  if (!dx && !dy) return [a];
  if (mode === 'straight' || !dx || !dy || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.00005)
    return [a, b];
  const diagonal = Math.min(Math.abs(dx), Math.abs(dy));
  return [a, point({ x: a.x + Math.sign(dx) * diagonal, y: a.y + Math.sign(dy) * diagonal }), b];
}

/** Anchor a pointer hit to the finite track segment at canonical coordinate precision. */
export function projectPointToTrack(
  track: Pick<PCB['tracks'][number], 'start' | 'end'>,
  p: Point,
): Point {
  const dx = track.end.x - track.start.x,
    dy = track.end.y - track.start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(0, ((p.x - track.start.x) * dx + (p.y - track.start.y) * dy) / lengthSquared),
        );
  return point({ x: track.start.x + dx * t, y: track.start.y + dy * t });
}

/** Closest finite-track contacts, retaining canonical precision and endpoint tie order. */
export function closestTrackPoints(
  a: Pick<PCB['tracks'][number], 'start' | 'end'>,
  b: Pick<PCB['tracks'][number], 'start' | 'end'>,
): [Point, Point] {
  const ax = a.end.x - a.start.x,
    ay = a.end.y - a.start.y,
    bx = b.end.x - b.start.x,
    by = b.end.y - b.start.y,
    denominator = ax * by - ay * bx;
  if (Math.abs(denominator) > 1e-12) {
    const dx = b.start.x - a.start.x,
      dy = b.start.y - a.start.y,
      t = (dx * by - dy * bx) / denominator,
      u = (dx * ay - dy * ax) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const contact = { x: round(a.start.x + t * ax), y: round(a.start.y + t * ay) };
      return [contact, contact];
    }
  }
  return (
    [
      [a.start, projectPointToTrack(b, a.start)],
      [a.end, projectPointToTrack(b, a.end)],
      [projectPointToTrack(a, b.start), b.start],
      [projectPointToTrack(a, b.end), b.end],
    ] as [Point, Point][]
  ).sort((p, q) => squaredDistance(...p) - squaredDistance(...q))[0];
}

export function pcbBounds(board: PCB): PCBBounds {
  const points: Point[] = [];
  const add = (p: Point, radius = 0) =>
    points.push({ x: p.x - radius, y: p.y - radius }, { x: p.x + radius, y: p.y + radius });
  for (const f of board.footprints) {
    add(f);
    for (const p of f.pads) {
      const center = padPosition(f, p),
        radians = (-padRotation(f, p) * Math.PI) / 180;
      for (const x of [-p.size.x / 2, p.size.x / 2])
        for (const y of [-p.size.y / 2, p.size.y / 2])
          add({
            x: center.x + x * Math.cos(radians) - y * Math.sin(radians),
            y: center.y + x * Math.sin(radians) + y * Math.cos(radians),
          });
    }
    for (const g of f.graphics) {
      for (const p of pcbGraphicPoints(g)) add(footprintPoint(f, p), g.width / 2);
    }
  }
  for (const item of board.tracks) {
    add(item.start, item.width / 2);
    add(item.end, item.width / 2);
  }
  for (const g of board.graphics) for (const p of pcbGraphicPoints(g)) add(p, g.width / 2);
  for (const v of board.vias) add(v, v.diameter / 2);
  for (const z of board.zones) for (const p of z.outline) add(p);
  if (!points.length) return { minX: 0, minY: 0, maxX: 80, maxY: 60 };
  return points.reduce(
    (b, p) => ({
      minX: Math.min(b.minX, p.x),
      minY: Math.min(b.minY, p.y),
      maxX: Math.max(b.maxX, p.x),
      maxY: Math.max(b.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}
