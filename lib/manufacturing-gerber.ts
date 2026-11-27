import Clipper from 'clipper-lib';
import type { Point } from './circuit';
import type { BoardLine, Footprint, Pad } from './pcb';
import { pcbArc, pcbBezierVertices, pcbRoundedRectArcs } from './pcb-geometry';
import { footprintPoint, padPosition, padRotation } from './pcb-layout';
import { nativeCustomPadAnchor, nativeCustomPadPlotGraphics } from './pcb-native-custom-pad';
import { offsetPadPolygons, offsetPolygons, padPolygon } from './pcb-polygons';
import { pcbStrokeText } from './pcb-stroke-text';

const decimal = (v: number) => String(Number(v.toFixed(6)));
const coordinatesPerMillimetre = 1e6;
const coordinate = (v: number) => {
  const rounded = Math.round(v * coordinatesPerMillimetre);
  if (!Number.isFinite(rounded) || Math.abs(rounded) >= coordinatesPerMillimetre ** 2)
    throw new Error('Gerber coordinates exceed the supported range.');
  return rounded;
};
const xy = (p: Point) => `X${coordinate(p.x)}Y${coordinate(-p.y)}`;

/** Gerber X2, metric 6.6 coordinates. All transforms use design millimetres.
 * Circular interpolation/round apertures retain analytic arcs and pad corners.
 */
export class GerberLayer {
  private apertures = new Map<string, number>();
  private commands: string[] = [];
  private size = 0;
  constructor(private fileFunction: string) {}
  private add(command: string) {
    this.size += command.length;
    if (this.size > 32 * 1024 * 1024) throw new Error('A Gerber layer exceeds 32 MiB.');
    this.commands.push(command);
  }
  private aperture(diameter: number) {
    if (!(diameter > 0)) throw new Error('Gerber strokes require positive widths.');
    const key = decimal(diameter);
    let id = this.apertures.get(key);
    if (!id) {
      id = this.apertures.size + 10;
      this.apertures.set(key, id);
    }
    this.add(`D${id}*`);
  }
  line(a: Point, b: Point, width: number) {
    this.aperture(width);
    this.add(`G01*\n${xy(a)}D02*\n${xy(b)}D01*`);
  }
  circle(at: Point, diameter: number) {
    this.aperture(diameter);
    this.add(`${xy(at)}D03*`);
  }
  private arc(end: Point, center: Point, start: Point, clockwise: boolean) {
    // KiCad's downward-Y plane is reflected into the manufacturing upward-Y plane.
    this.add(
      `${clockwise ? 'G02' : 'G03'}${xy(end)}I${coordinate(center.x - start.x)}J${coordinate(start.y - center.y)}D01*\nG01*`,
    );
  }
  region(rings: Point[][]) {
    this.aperture(0.001);
    this.add('G01*\nG36*');
    for (const ring of rings) {
      if (ring.length < 3) throw new Error('A Gerber region needs at least three vertices.');
      this.add(`${xy(ring[0])}D02*`);
      for (const point of [...ring.slice(1), ring[0]]) this.add(`${xy(point)}D01*`);
    }
    this.add('G37*');
  }
  zoneFills(polygons: Point[][]) {
    if (!polygons.length) return;
    const engine = new Clipper.Clipper();
    engine.StrictlySimple = true;
    const tree = new Clipper.PolyTree();
    let vertices = 0;
    for (const polygon of polygons) {
      vertices += polygon.length;
      if (vertices > 250000) throw new Error('Gerber zone fills exceed the layer geometry limit.');
      const path = polygon.map(({ x, y }) => ({ X: coordinate(x), Y: coordinate(-y) }));
      // Each native fractured path winds its cutouts in the opposite direction.
      // Normalize outer orientation so the union retains overlapping artwork.
      if (!Clipper.Clipper.Orientation(path)) path.reverse();
      if (!engine.AddPath(path, Clipper.PolyType.ptSubject, true))
        throw new Error('A saved zone has no drawable contour at Gerber resolution.');
    }
    if (
      !engine.Execute(
        Clipper.ClipType.ctUnion,
        tree,
        Clipper.PolyFillType.pftNonZero,
        Clipper.PolyFillType.pftNonZero,
      ) ||
      !tree.ChildCount()
    )
      throw new Error('Saved zone contours do not enclose drawable Gerber area.');
    // Gerber fills each contour independently. Emit holes in clear polarity,
    // visiting ancestors first so nested islands and later flashes stay dark.
    let clear = false;
    for (let node = tree.GetFirst(); node; node = node.GetNext()) {
      if (node.IsHole() !== clear) {
        clear = node.IsHole();
        this.add(clear ? '%LPC*%' : '%LPD*%');
      }
      this.region([
        node.Contour().map(({ X, Y }) => ({
          x: X / coordinatesPerMillimetre,
          y: -Y / coordinatesPerMillimetre,
        })),
      ]);
    }
    if (clear) this.add('%LPD*%');
  }
  pad(footprint: Footprint, pad: Pad, marginX = 0, marginY = marginX) {
    if (pad.nativeCustomPad) {
      if (marginX !== 0 || marginY !== 0)
        throw new Error(
          'Gerber export requires zero mask and paste margins on native custom pads.',
        );
      const placement = { ...padPosition(footprint, pad), rotation: padRotation(footprint, pad) };
      const graphics = nativeCustomPadPlotGraphics(pad, (point) =>
        footprintPoint(placement, point),
      );
      const anchor = nativeCustomPadAnchor(pad);
      if (anchor) this.pad(footprint, anchor);
      for (const graphic of graphics) {
        if (!graphic.kind && graphic.start.x === graphic.end.x && graphic.start.y === graphic.end.y)
          this.circle(graphic.start, graphic.width);
        else this.graphic(graphic);
      }
      return;
    }
    if (pad.shape === 'trapezoid') {
      if (marginX || marginY)
        throw new Error('Gerber export supports trapezoid pads only with zero aperture margin.');
      this.region([padPolygon(footprint, pad).outer]);
      return;
    }
    if (pad.outline) {
      if (marginX !== marginY)
        throw new Error('Gerber export requires uniform custom pad margins.');
      for (const aperture of offsetPadPolygons(footprint, pad, marginX))
        this.region([aperture.outer, ...aperture.holes]);
      return;
    }
    const w = pad.size.x + 2 * marginX,
      h = pad.size.y + 2 * marginY;
    if (w <= 0 || h <= 0) return; // Native negative paste margins may close an aperture.
    if (pad.shape === 'circle' && Math.abs(w - h) < 1e-9) {
      this.circle(padPosition(footprint, pad), w);
      return;
    }
    if (pad.shape === 'circle')
      throw new Error('Gerber export does not support elliptical pad apertures.');
    const at = padPosition(footprint, pad),
      angle = (-padRotation(footprint, pad) * Math.PI) / 180;
    const point = (x: number, y: number) => ({
      x: at.x + x * Math.cos(angle) - y * Math.sin(angle),
      y: at.y + x * Math.sin(angle) + y * Math.cos(angle),
    });
    if (pad.shape === 'oval') {
      const radius = Math.min(w, h) / 2;
      this.line(
        point(w > h ? -w / 2 + radius : 0, h > w ? -h / 2 + radius : 0),
        point(w > h ? w / 2 - radius : 0, h > w ? h / 2 - radius : 0),
        2 * radius,
      );
      return;
    }
    if (pad.chamfer?.length && (marginX || marginY)) {
      if (marginX !== marginY || pad.roundrectRatio)
        throw new Error('Gerber export supports only uniform margins on straight-chamfered pads.');
      for (const aperture of offsetPadPolygons(footprint, pad, marginX))
        this.region([aperture.outer, ...aperture.holes]);
      return;
    }
    const r = pad.shape === 'roundrect' ? Math.min(w, h) * (pad.roundrectRatio ?? 0) : 0;
    const c = Math.min(w, h) * (pad.chamferRatio ?? 0);
    const corners = [
      { x: 1, y: -1, name: 'top_right' },
      { x: 1, y: 1, name: 'bottom_right' },
      { x: -1, y: 1, name: 'bottom_left' },
      { x: -1, y: -1, name: 'top_left' },
    ] as const;
    this.aperture(0.001);
    this.add('G01*\nG36*');
    let first: Point | undefined;
    for (const [i, corner] of corners.entries()) {
      const chamfer = pad.chamfer?.includes(corner.name);
      const cut = chamfer ? c : r;
      const start =
        i % 2 === 0
          ? point(corner.x * (w / 2 - cut), (corner.y * h) / 2)
          : point((corner.x * w) / 2, corner.y * (h / 2 - cut));
      const end =
        i % 2 === 0
          ? point((corner.x * w) / 2, corner.y * (h / 2 - cut))
          : point(corner.x * (w / 2 - cut), (corner.y * h) / 2);
      this.add(`${xy(start)}D${first ? '01' : '02'}*`);
      first ??= start;
      if (r && !chamfer)
        this.arc(end, point(corner.x * (w / 2 - r), corner.y * (h / 2 - r)), start, true);
      else this.add(`${xy(end)}D01*`);
    }
    this.add(`${xy(first!)}D01*\nG37*`);
  }
  maskGraphic(g: BoardLine, expansion: number, nativeRectangle: boolean) {
    const nativeWidth = g.nativeNoStroke ? -1 : coordinate(g.width);
    const width = (nativeWidth + 2 * coordinate(expansion)) / coordinatesPerMillimetre;
    if (width > 0 || (width === 0 && g.fill)) {
      this.graphic({ ...g, width });
      return;
    }
    if (!g.fill) return;
    if (g.kind === 'circle') {
      const diameter = 2 * Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) + width;
      if (diameter > 0) this.circle(g.start, diameter);
      return;
    }
    if (g.kind !== 'polygon' || g.polygonArcs)
      throw new Error('Gerber export does not support shrinking this filled mask graphic.');
    const vertices = [g.start, ...(g.points ?? []), g.end];
    if (nativeRectangle) {
      // The native rectangle plot insets each side by the negative stroke width.
      if (
        [1, 3].some(
          (i) => Math.hypot(vertices[i].x - g.start.x, vertices[i].y - g.start.y) <= -2 * width,
        )
      )
        return;
      const [start, first, second, end] = vertices.map((vertex, index) => {
        const moveToward = (other: Point) => {
          const scale = -width / Math.hypot(other.x - vertex.x, other.y - vertex.y);
          return { x: scale * (other.x - vertex.x), y: scale * (other.y - vertex.y) };
        };
        const previous = moveToward(vertices[(index + 3) % 4]);
        const next = moveToward(vertices[(index + 1) % 4]);
        return { x: vertex.x + previous.x + next.x, y: vertex.y + previous.y + next.y };
      });
      const radius = (g.roundedRectRadius ?? 0) + width;
      this.graphic({
        ...g,
        start,
        end,
        points: [first, second],
        width: 0,
        roundedRectRadius: radius > 0 ? radius : undefined,
      });
    } else {
      for (const outline of offsetPolygons([{ outer: vertices, holes: [] }], width / 2, 0.0005)) {
        if (outline.holes.length)
          throw new Error('Gerber export does not support holes in a contracted mask graphic.');
        this.region([outline.outer]);
      }
    }
  }
  graphic(g: BoardLine) {
    if (g.text?.hidden || g.kind === 'point') return;
    if (g.kind === 'dimension')
      throw new Error('Gerber export does not support dimensions on manufacturing layers.');
    if (g.stroke && !['solid', 'default'].includes(g.stroke))
      throw new Error('Gerber export does not support dashed artwork on manufacturing layers.');
    if (g.text) {
      this.text(g);
      return;
    }
    if (g.kind === 'curve') {
      if (g.width > 0 || g.layer === 'Edge.Cuts') {
        // Gerber has no cubic interpolation. Use a 0.5 µm chord error bound
        // before rounding vertices to the metric 6.6 coordinate grid.
        const [start, ...ends] = pcbBezierVertices(g, 0.0005).map(xy);
        let previous = start;
        let started = false;
        for (const end of ends) {
          if (end === previous) continue;
          if (!started) {
            this.aperture(g.width || 0.05);
            this.add(`G01*\n${start}D02*`);
            started = true;
          }
          this.add(`${end}D01*`);
          previous = end;
        }
      }
      return;
    }
    if (g.roundedRectRadius !== undefined || g.polygonArcs) {
      this.curvedContour(g);
      return;
    }
    if (g.kind === 'circle') {
      const radius = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
      if (g.fill && g.layer !== 'Edge.Cuts') this.circle(g.start, 2 * radius + g.width);
      else {
        this.aperture(g.width || 0.05);
        const start = { x: g.start.x + radius, y: g.start.y },
          opposite = { x: g.start.x - radius, y: g.start.y };
        this.add(`${xy(start)}D02*`);
        this.arc(opposite, g.start, start, true);
        this.arc(start, g.start, opposite, true);
      }
    } else if (g.kind === 'arc') {
      const arc = pcbArc(g);
      if (!arc) throw new Error('Gerber export contains a degenerate arc.');
      this.aperture(g.width || 0.05);
      this.add(`${xy(g.start)}D02*`);
      this.arc(g.end, arc.center, g.start, arc.delta > 0);
    } else {
      const points = [g.start, ...(g.points ?? []), g.end];
      if (g.kind === 'polygon') {
        if (g.fill && g.layer !== 'Edge.Cuts') this.region([points]);
        points.push(g.start);
      }
      if (g.width > 0 || g.layer === 'Edge.Cuts')
        for (let i = 1; i < points.length; i++)
          this.line(points[i - 1], points[i], g.width || 0.05);
    }
  }
  private curvedContour(g: BoardLine) {
    const edges: { start: Point; end: Point; center?: Point; clockwise?: boolean }[] = [];
    if (g.roundedRectRadius !== undefined) {
      const corners = pcbRoundedRectArcs(g);
      for (const [index, corner] of corners.entries())
        edges.push(corner, { start: corner.end, end: corners[(index + 1) % corners.length].start });
    } else {
      const vertices = [g.start, ...(g.points ?? []), g.end];
      const mids = new Map(g.polygonArcs!.map(({ vertex, mid }) => [vertex, mid]));
      for (const [index, start] of vertices.entries()) {
        const end = vertices[(index + 1) % vertices.length];
        const mid = mids.get(index);
        if (!mid) {
          edges.push({ start, end });
          continue;
        }
        const arc = pcbArc({ start, mid, end });
        if (!arc) throw new Error('Gerber export contains a degenerate polygon arc.');
        edges.push({ start, end, center: arc.center, clockwise: arc.delta > 0 });
      }
    }
    const draw = (region: boolean) => {
      this.aperture(region ? 0.001 : g.width || 0.05);
      this.add(region ? 'G01*\nG36*' : 'G01*');
      this.add(`${xy(edges[0].start)}D02*`);
      for (const { start, end, center, clockwise } of edges) {
        const encoded = xy(end);
        if (center) {
          if (encoded === xy(start))
            throw new Error('A Gerber contour arc collapses at the output resolution.');
          this.arc(end, center, start, clockwise!);
        } else if (encoded !== xy(start)) this.add(`${encoded}D01*`);
      }
      if (region) this.add('G37*');
    };
    if (g.fill && g.layer !== 'Edge.Cuts') draw(true);
    if (g.width > 0 || g.layer === 'Edge.Cuts') draw(false);
  }
  private text(g: BoardLine) {
    const ink = pcbStrokeText(g.text!, g.start);
    if ('unsupported' in ink) throw new Error(`Gerber export does not support ${ink.unsupported}.`);
    for (const path of ink.paths)
      for (let i = 1; i < path.length; i++) this.line(path[i - 1], path[i], ink.width);
  }
  finish() {
    return [
      'G04 OpenPE manufacturing export*',
      '%FSLAX66Y66*%',
      '%MOMM*%',
      `%TF.FileFunction,${this.fileFunction}*%`,
      `%TF.FilePolarity,${this.fileFunction.startsWith('Soldermask,') ? 'Negative' : 'Positive'}*%`,
      ...[...this.apertures].map(([size, id]) => `%ADD${id}C,${size}*%`),
      '%LPD*%',
      'G75*',
      'G01*',
      ...this.commands,
      'M02*',
      '',
    ].join('\n');
  }
}
