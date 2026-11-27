import { child, children, quote, val, type SExpr } from './sexpr';
import type { BoardLine, BoardText, Footprint } from './pcb';
import type { Project } from './project';
import {
  maxPCBTextCachePolygons,
  maxPCBTextCachePolygonVertices,
  pcbTextCacheCoordinatePattern,
} from './pcb-text-cache-format';

export type PCBTextRenderCache = {
  value: string;
  rotation: number;
  /** Native board coordinates encoded as bounded SVG point pairs. */
  polygons: string[];
};

const cacheCoordinate = new RegExp(`^${pcbTextCacheCoordinatePattern}$`);

export const nativeFootprintCaptionDefaultSize = 1.27;

export function isExplicitlyHiddenFootprintCaption(record: SExpr): boolean {
  const [hide, duplicate] = children(record, 'hide');
  return (
    record[0] === 'property' &&
    ['Reference', 'Value'].includes(val(record)) &&
    hide?.length === 2 &&
    hide[1] === 'yes' &&
    !duplicate &&
    !record.includes('hide')
  );
}

export function readPCBTextLineSpacing(
  font: SExpr,
  fail: (message: string) => never,
): Pick<BoardText, 'lineSpacing'> {
  const [record, duplicate] = children(font, 'line_spacing');
  if (!record) return {};
  const raw = record[1];
  const value = Number(raw);
  if (
    duplicate ||
    record.length !== 2 ||
    typeof raw !== 'string' ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ||
    !(value >= 0 && value <= 1000)
  )
    return fail('Invalid native PCB text line spacing.');
  return { lineSpacing: value || 0 };
}

export function pcbTextLineAdvance(text: BoardText): number {
  return text.size.y * 1.25 * (text.lineSpacing ?? 1);
}

export function readPCBTextFont(
  text: SExpr,
  font: SExpr,
  fail: (message: string) => never,
): Pick<BoardText, 'fontFace' | 'renderCache'> {
  const faces = children(font, 'face');
  const caches = children(text, 'render_cache');
  const face = faces[0];
  const cache = caches[0];
  if (faces.length > 1 || caches.length > 1)
    return fail('Duplicate PCB text font or render cache.');
  if (!face) {
    if (cache) return fail('PCB text render cache requires a font face.');
    return {};
  }
  const name = val(face);
  if (
    face.length !== 2 ||
    typeof face[1] !== 'string' ||
    !face[1].startsWith('"') ||
    !name.trim() ||
    name.length > 256 ||
    /[\x00-\x1f]/.test(name)
  )
    return fail('Invalid PCB text font face.');
  if (!cache) return { fontFace: name };
  const value = val(cache);
  const rotation = Number(cache[2]) + 0;
  if (
    cache.length < 3 ||
    cache.length > maxPCBTextCachePolygons + 3 ||
    typeof cache[1] !== 'string' ||
    !cache[1].startsWith('"') ||
    value.length > 4096 ||
    typeof cache[2] !== 'string' ||
    !cacheCoordinate.test(cache[2]) ||
    Math.abs(rotation) > 360
  )
    return fail('Invalid PCB text render cache.');
  const polygons: string[] = [];
  for (const record of cache.slice(3)) {
    const pts = Array.isArray(record) ? child(record, 'pts') : undefined;
    if (
      !Array.isArray(record) ||
      record[0] !== 'polygon' ||
      record.length !== 2 ||
      !pts ||
      pts.length < 4 ||
      pts.length > maxPCBTextCachePolygonVertices + 1
    )
      return fail('Unsupported PCB text render cache polygon.');
    polygons.push(
      pts
        .slice(1)
        .map((point) => {
          if (
            !Array.isArray(point) ||
            point[0] !== 'xy' ||
            point.length !== 3 ||
            typeof point[1] !== 'string' ||
            !cacheCoordinate.test(point[1]) ||
            typeof point[2] !== 'string' ||
            !cacheCoordinate.test(point[2])
          )
            return fail('Unsupported PCB text render cache point.');
          return `${point[1]},${point[2]}`;
        })
        .join(' '),
    );
  }
  return { fontFace: name, renderCache: { value, rotation, polygons } };
}

export function writePCBTextRenderCache(cache: PCBTextRenderCache | undefined): string {
  if (!cache) return '';
  const polygons = cache.polygons.map(
    (polygon) =>
      ` (polygon (pts ${polygon
        .split(' ')
        .map((p) => `(xy ${p.replace(',', ' ')})`)
        .join(' ')}))`,
  );
  return ` (render_cache ${quote(cache.value)} ${cache.rotation}${polygons.join('')})`;
}

/** Only the literal text and native draw rotation can identify usable ink. */
export function pcbTextDisplayValue(text: BoardText): string {
  return text.nativeExpansion?.source === text.value ? text.nativeExpansion.value : text.value;
}

export function matchingPCBTextRenderCache(
  text: BoardText,
  drawRotation: number,
): string[] | undefined {
  const cache = text.renderCache;
  if (!cache || cache.value !== pcbTextDisplayValue(text)) return undefined;
  const delta = ((cache.rotation - drawRotation + 540) % 360) - 180;
  return Math.abs(delta) < 0.000001 ? cache.polygons : undefined;
}

/** Retained artwork keeps its native geometry until Source
 * replaces the complete record. */
export function assertNativePCBArtworkUnchanged(previous: Project | null, next: Project): void {
  if (!previous || (previous.pcb === next.pcb && previous.schematic.parts === next.schematic.parts))
    return;
  const records = (project: Project) => {
    const result = new Map<string, { kind?: string; value: unknown[] }>();
    if (!project.pcb) return result;
    const parts = new Map(project.schematic.parts.map((part) => [part.id, part]));
    const add = (graphic: BoardLine, owner?: Footprint) => {
      const text = graphic.text ?? graphic.dimension?.caption;
      const kind = graphic.textBox
        ? 'text box'
        : graphic.dimension?.type === 'orthogonal'
          ? 'orthogonal dimension'
          : graphic.roundedRectRadius !== undefined
            ? 'rounded rectangle'
            : graphic.polygonArcs
              ? 'curved polygon'
              : undefined;
      if (!text?.renderCache && !kind) return;
      const part = owner?.symbolId ? parts.get(owner.symbolId) : undefined;
      const { locked: _lock, ...geometry } = graphic;
      result.set(graphic.id, {
        kind,
        value: [
          geometry,
          owner && [
            owner.id,
            owner.x,
            owner.y,
            owner.rotation,
            owner.side,
            part?.ref ?? owner.reference,
            part?.value ?? owner.value,
          ],
        ],
      });
    };
    for (const graphic of project.pcb.graphics) add(graphic);
    for (const footprint of project.pcb.footprints)
      for (const graphic of footprint.graphics) add(graphic, footprint);
    return result;
  };
  const before = records(previous);
  const after = records(next);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id),
      updated = after.get(id);
    if (JSON.stringify(old) === JSON.stringify(updated)) continue;
    const kind = old?.kind ?? updated?.kind;
    if (kind) throw new Error(`Changing a native PCB ${kind} requires native Source.`);
    throw new Error('Changing PCB text with native cached outlines requires native Source.');
  }
}

/** KiCad's footprint-text orientation flag is independent of its editing lock. */
export function footprintTextPlacement(node: SExpr, fail: (message: string) => never) {
  const at = child(node, 'at');
  const inPosition = at?.at(-1) === 'unlocked';
  const flags = children(node, 'unlocked');
  const bare = node.filter((item) => item === 'unlocked').length;
  const [flag] = flags;
  if (
    flags.length + bare + Number(inPosition) > 1 ||
    (flag && (flag.length !== 2 || !['yes', 'no'].includes(val(flag))))
  )
    fail('Invalid footprint text orientation flag.');
  return {
    at: inPosition ? at!.slice(0, -1) : at,
    unlocked: inPosition || bare === 1 || val(flag) === 'yes',
    flag,
    bare: bare === 1,
    inPosition,
  };
}
