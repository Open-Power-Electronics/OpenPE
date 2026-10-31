import type { Point } from './circuit';
import type { BoardLine, Footprint, Pad } from './pcb';
import { pcbArc } from './pcb-geometry';
import { padPosition, padRotation } from './pcb-layout';
import glyphs from './manufacturing-font.json';

const decimal = (v: number) => String(Number(v.toFixed(6)));
const coordinate = (v: number) => {
  if (!Number.isFinite(v) || Math.abs(v) >= 1000000)
    throw new Error('Gerber coordinates exceed the supported range.');
  return String(Math.round(v * 1e6));
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
  pad(footprint: Footprint, pad: Pad, marginX = 0, marginY = marginX) {
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
    if (pad.chamfer?.length && (marginX || marginY))
      throw new Error('Gerber export does not support margins on chamfered pads.');
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
  graphic(g: BoardLine) {
    if (g.text?.hidden) return;
    if (g.kind === 'dimension')
      throw new Error('Gerber export does not support dimensions on manufacturing layers.');
    if (g.stroke && !['solid', 'default'].includes(g.stroke))
      throw new Error('Gerber export does not support dashed artwork on manufacturing layers.');
    if (g.text) {
      this.text(g);
      return;
    }
    if (g.kind === 'circle') {
      const radius = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
      if (g.fill) this.circle(g.start, 2 * radius + g.width);
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
        if (g.fill) this.region([points]);
        points.push(g.start);
      }
      if (g.width > 0 || g.layer === 'Edge.Cuts')
        for (let i = 1; i < points.length; i++)
          this.line(points[i - 1], points[i], g.width || 0.05);
    }
  }
  private text(g: BoardLine) {
    const t = g.text!;
    if (/\$\{|[~^_]\{/.test(t.value))
      throw new Error('Gerber export does not support unresolved or formatted text.');
    const lines = t.value.split('\n'),
      angle = (-t.rotation * Math.PI) / 180;
    const glyph = (char: string) => {
      const code = char.codePointAt(0)!;
      if (code < 32 || code >= 0x400 || glyphs[code - 32] === glyphs[0x7f - 32])
        throw new Error(
          `Gerber export does not support text character U+${code.toString(16).toUpperCase()}.`,
        );
      return glyphs[code - 32];
    };
    const spacing = 1.25 * t.size.y;
    const top = t.justify?.includes('top')
      ? t.size.y
      : t.justify?.includes('bottom')
        ? -(lines.length - 1) * spacing
        : t.size.y / 2 - ((lines.length - 1) * spacing) / 2;
    for (const [index, line] of lines.entries()) {
      const width = [...line].reduce((n, char) => {
        const s = glyph(char);
        return n + ((s.charCodeAt(1) - s.charCodeAt(0)) * t.size.x) / 21;
      }, 0);
      let cursor = t.justify?.includes('left')
        ? 0
        : t.justify?.includes('right')
          ? -width
          : -width / 2;
      for (const char of line) {
        const s = glyph(char),
          left = s.charCodeAt(0);
        let previous: Point | undefined;
        for (let i = 2; i < s.length; i += 2) {
          if (s.slice(i, i + 2) === ' R') {
            previous = undefined;
            continue;
          }
          const y = ((s.charCodeAt(i + 1) - 82 - 8) * t.size.y) / 21;
          const x =
            (cursor + ((s.charCodeAt(i) - left) * t.size.x) / 21 - (t.italic ? y / 8 : 0)) *
            (t.justify?.includes('mirror') ? -1 : 1);
          const yy = y + top + index * spacing;
          const at = {
            x: g.start.x + x * Math.cos(angle) - yy * Math.sin(angle),
            y: g.start.y + x * Math.sin(angle) + yy * Math.cos(angle),
          };
          if (previous)
            this.line(previous, at, t.thickness || Math.min(t.size.x, t.size.y) / (t.bold ? 5 : 8));
          previous = at;
        }
        cursor += ((s.charCodeAt(1) - left) * t.size.x) / 21;
      }
    }
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
