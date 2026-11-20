import {
  materializedCircuitTree,
  pinPositions,
  snap,
  type Circuit,
  type Part,
  type Point,
} from '../../../lib/circuit';
import { displayPartValue, unitGraphics } from '../../../lib/library';
import type { PCB } from '../../../lib/pcb';
import { schematicPolylines, schematicTexts } from '../../../lib/schematic-text';
import { child, children, num, val, type SExpr } from '../../../lib/sexpr';
import { symbolBodyBounds } from '../../../lib/symbol-bounds';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Pin = { point: Point; number: string };
const grid = 1.27;
const gap = grid;
const coordinateLimit = 100000;
const hidden = (node?: SExpr) =>
  !!node && (node.includes('hide') || val(child(node, 'hide')) === 'yes');

function bounds(points: readonly Point[], radius = 0): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX: minX - radius, minY: minY - radius, maxX: maxX + radius, maxY: maxY + radius };
}

const center = (box: Bounds): Point => ({
  x: (box.minX + box.maxX) / 2,
  y: (box.minY + box.maxY) / 2,
});
const corners = (box: Bounds): Point[] => [
  { x: box.minX, y: box.minY },
  { x: box.maxX, y: box.minY },
  { x: box.maxX, y: box.maxY },
  { x: box.minX, y: box.maxY },
];

function transform(part: Part, point: Point): Point {
  const angle = (-part.rotation * Math.PI) / 180;
  return {
    x:
      part.x +
      (part.mirror === 'y' ? -1 : 1) * (point.x * Math.cos(angle) - point.y * Math.sin(angle)),
    y:
      part.y +
      (part.mirror === 'x' ? -1 : 1) * (point.x * Math.sin(angle) + point.y * Math.cos(angle)),
  };
}

function textBounds(
  text: string,
  point: Point,
  rotation: number,
  effects: SExpr = [],
  hidden = false,
): Bounds {
  if (hidden) return bounds([point]);
  const font = child(effects, 'font') ?? [];
  const size = num(child(font, 'size')) || 1.27;
  const lines = text.split('\n');
  const width =
    Math.max(
      1,
      ...lines.map((line) =>
        Array.from(line).reduce((sum, glyph) => sum + (glyph.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0),
      ),
    ) * size;
  const height = Math.max(1, lines.length) * size * 2;
  const justify = child(effects, 'justify') ?? [];
  const minX = justify.includes('left') ? 0 : justify.includes('right') ? -width : -width / 2;
  const minY = justify.includes('top') ? 0 : justify.includes('bottom') ? -height : -height / 2;
  const angle = (-rotation * Math.PI) / 180;
  return bounds(
    corners({ minX, minY, maxX: minX + width, maxY: minY + height }).map(({ x, y }) => ({
      x: point.x + x * Math.cos(angle) - y * Math.sin(angle),
      y: point.y + x * Math.sin(angle) + y * Math.cos(angle),
    })),
  );
}

/** Conservative geometry from the complete sheet, independently of display
 * layers. Hidden fields reserve their anchors, not invisible metadata glyphs. */
function obstacles(circuit: Circuit): Bounds[] {
  const result: Bounds[] = [];
  const instances = new Map(
    children(materializedCircuitTree(circuit), 'symbol').map((node) => [
      val(child(node, 'uuid')),
      node,
    ]),
  );
  for (const part of circuit.parts) {
    const library = circuit.libraries[part.libId];
    const units = unitGraphics(library, part.unit || 1);
    let bodyStroke = 0.5;
    for (const unit of units)
      for (const graphic of unit)
        if (Array.isArray(graphic))
          bodyStroke = Math.max(
            bodyStroke,
            num(child(child(graphic, 'stroke') ?? [], 'width')) / 2,
          );
    result.push(bounds([part]));
    const body = symbolBodyBounds(library, part.unit || 1);
    if (body)
      result.push(
        bounds(
          corners({
            minX: body.x,
            minY: body.y,
            maxX: body.x + body.width,
            maxY: body.y + body.height,
          }).map((point) => transform(part, point)),
          bodyStroke,
        ),
      );
    for (const unit of units) {
      for (const pin of children(unit, 'pin')) {
        const at = child(pin, 'at');
        const a = { x: num(at), y: -num(at, 2) };
        const angle = (num(at, 3) * Math.PI) / 180;
        const length = num(child(pin, 'length'));
        const b = { x: a.x + length * Math.cos(angle), y: a.y - length * Math.sin(angle) };
        result.push(bounds([transform(part, a), transform(part, b)], 0.25));
        const pinText = (text: string, point: Point, size: number) => {
          const world = transform(part, point);
          // Pin captions are upright in world space. Reserve either possible
          // horizontal justification rather than guessing from the part pose.
          const width = Math.max(1, Array.from(text).length) * size * 1.5;
          result.push({
            minX: world.x - width,
            maxX: world.x + width,
            minY: world.y - size * 1.5,
            maxY: world.y + size * 1.5,
          });
        };
        if (!hidden(pin)) {
          const number = child(pin, 'number');
          if (!hidden(child(library, 'pin_numbers')) && val(number))
            pinText(
              val(number),
              { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 0.5 },
              Math.max(
                0.9,
                num(child(child(child(number ?? [], 'effects') ?? [], 'font') ?? [], 'size')),
              ),
            );
          const name = child(pin, 'name');
          if (!hidden(child(library, 'pin_names')) && val(name) && val(name) !== '~')
            pinText(
              val(name).replace(/^~\{(.*)\}$/, '$1'),
              {
                x: a.x + (length + 0.7) * Math.cos(angle),
                y: a.y - (length + 0.7) * Math.sin(angle),
              },
              num(child(child(child(name ?? [], 'effects') ?? [], 'font') ?? [], 'size')) || 1,
            );
        }
      }
      for (const text of children(unit, 'text')) {
        const at = child(text, 'at');
        const local = textBounds(
          val(text),
          { x: num(at), y: -num(at, 2) },
          num(at, 3),
          child(text, 'effects'),
        );
        result.push(bounds(corners(local).map((point) => transform(part, point))));
        const world = transform(part, { x: num(at), y: -num(at, 2) });
        const nativeSize = num(child(child(child(text, 'effects') ?? [], 'font') ?? [], 'size'));
        const size = String(Math.max(1.27, nativeSize));
        result.push(textBounds(val(text), world, 0, ['effects', ['font', ['size', size, size]]]));
      }
    }
    // Materialization supplies the actual world field positions, including
    // current raw-origin displacement and hidden newly added properties.
    for (const field of children(instances.get(part.id) ?? [], 'property')) {
      const at = child(field, 'at');
      if (!at) continue;
      const effects = child(field, 'effects') ?? [];
      const concealed = hidden(field) || hidden(effects);
      const name = val(field);
      result.push(
        textBounds(
          name === 'Value' ? displayPartValue(part) : val(field, 2),
          { x: num(at), y: num(at, 2) },
          name === 'Reference' || name === 'Value' ? 0 : num(at, 3),
          effects,
          concealed,
        ),
      );
    }
  }
  for (const wire of circuit.wires) result.push(bounds([wire.a, wire.b], 0.25));
  for (const point of [...circuit.junctions, ...(circuit.noConnects ?? [])])
    result.push(bounds([point], 0.65));
  for (const label of circuit.labels) {
    const effects = child(label.raw ?? [], 'effects') ?? [
      'effects',
      ['font', ['size', '1.27', '1.27']],
      ['justify', 'left', 'bottom'],
    ];
    result.push(textBounds(label.text, label, label.rotation ?? 0, effects));
    if (label.scope === 'global') {
      const length = Math.max(9, label.text.length * 1.4 + 5);
      const angle = (-(label.rotation ?? 0) * Math.PI) / 180;
      result.push(
        bounds(
          corners({ minX: -0.5, maxX: length, minY: -2.3, maxY: 2.3 }).map(({ x, y }) => ({
            x: label.x + x * Math.cos(angle) - y * Math.sin(angle),
            y: label.y + x * Math.sin(angle) + y * Math.cos(angle),
          })),
        ),
      );
    }
  }
  const textNodes = new Map(
    children(circuit.original ?? [], 'text').map((node) => [val(child(node, 'uuid')), node]),
  );
  for (const text of schematicTexts(circuit.original)) {
    const node = textNodes.get(text.id)!;
    result.push(textBounds(text.text, text, 0, child(node, 'effects')));
  }
  for (const outline of schematicPolylines(circuit.original))
    for (let i = 1; i < outline.points.length; i++)
      result.push(bounds([outline.points[i - 1], outline.points[i]], outline.width / 2));
  return result;
}

function studyAnchor(
  board: PCB,
  target: Circuit,
  startId: string,
  endId: string,
  netId: string,
): Point {
  const parts = new Map(target.parts.map((part) => [part.id, part]));
  const componentUnits = new Map<string, Part[]>();
  const pins = new Map<string, Pin[]>();
  for (const part of target.parts) {
    const key = JSON.stringify([part.ref, part.libId]);
    const existing = componentUnits.get(key) ?? [];
    existing.push(part);
    componentUnits.set(key, existing);
    const positions = pinPositions(part, target.libraries[part.libId]);
    pins.set(
      part.id,
      unitGraphics(target.libraries[part.libId], part.unit || 1)
        .flatMap((unit) => children(unit, 'pin'))
        .map((pin, index) => ({
          point: positions[index],
          number: val(child(pin, 'number')),
        })),
    );
  }
  const mapped: { id: string; pins: Pin[] }[] = [];
  for (const footprint of board.footprints) {
    const owner = parts.get(footprint.symbolId ?? '');
    if (!owner) continue;
    const units = componentUnits.get(JSON.stringify([owner.ref, owner.libId]))!;
    for (const pad of footprint.pads) {
      if ((pad.id !== startId && pad.id !== endId) || pad.netId !== netId || !pad.number.trim())
        continue;
      const matches = units
        .flatMap((part) => pins.get(part.id)!)
        .filter((pin) => pin.number === pad.number);
      const points = new Set(matches.map(({ point }) => `${point.x},${point.y}`));
      if (points.size === 1) mapped.push({ id: pad.id, pins: matches });
    }
  }
  if (mapped.length !== 2)
    throw new Error('Series placement requires both exact schematic terminal anchors.');
  return center(bounds(mapped.map(({ pins }) => pins[0].point)));
}

const overlaps = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const translated = (box: Bounds, delta: Point): Bounds => ({
  minX: box.minX + delta.x,
  minY: box.minY + delta.y,
  maxX: box.maxX + delta.x,
  maxY: box.maxY + delta.y,
});
const allowed = (box: Bounds) =>
  [box.minX, box.minY, box.maxX, box.maxY].every(
    (value) => Number.isFinite(value) && Math.abs(value) <= coordinateLimit,
  );

/** At most 2,401 snapped local candidates and two million obstacle comparisons.
 * Spatial cells bound ordinary searches; oversized obstacles are checked whole. */
export function parasiticsStudyOffset(
  board: PCB,
  target: Circuit,
  study: Circuit,
  startId: string,
  endId: string,
  netId: string,
): Point {
  const occupied = obstacles(target);
  const shapes = [...new Map(obstacles(study).map((box) => [JSON.stringify(box), box])).values()];
  const shape = bounds(shapes.flatMap(corners));
  const origin = center(shape);
  const anchor = studyAnchor(board, target, startId, endId, netId);
  const cells = new Map<string, number[]>();
  const large: number[] = [];
  const cellSize = 25.4;
  const range = (box: Bounds) => ({
    left: Math.floor(box.minX / cellSize),
    right: Math.floor(box.maxX / cellSize),
    top: Math.floor(box.minY / cellSize),
    bottom: Math.floor(box.maxY / cellSize),
  });
  occupied.forEach((box, index) => {
    const r = range(box);
    if ((r.right - r.left + 1) * (r.bottom - r.top + 1) > 64) {
      large.push(index);
      return;
    }
    for (let x = r.left; x <= r.right; x++)
      for (let y = r.top; y <= r.bottom; y++) {
        const key = `${x},${y}`;
        const existing = cells.get(key) ?? [];
        existing.push(index);
        cells.set(key, existing);
      }
  });
  let comparisons = 0;
  const fits = (delta: Point) => {
    const box = translated(shape, delta);
    if (!allowed(box)) return false;
    for (const local of shapes) {
      const box = translated(local, delta);
      const expanded = {
        minX: box.minX - gap,
        minY: box.minY - gap,
        maxX: box.maxX + gap,
        maxY: box.maxY + gap,
      };
      const r = range(expanded);
      const candidates = new Set(large);
      if ((r.right - r.left + 1) * (r.bottom - r.top + 1) > 128)
        occupied.forEach((_, index) => candidates.add(index));
      else
        for (let x = r.left; x <= r.right; x++)
          for (let y = r.top; y <= r.bottom; y++)
            for (const index of cells.get(`${x},${y}`) ?? []) candidates.add(index);
      for (const index of candidates) {
        if (++comparisons > 2000000 || overlaps(expanded, occupied[index])) return false;
      }
    }
    return true;
  };
  const offset = (point: Point) => ({ x: snap(point.x - origin.x), y: snap(point.y - origin.y) });
  const candidates: Point[] = [];
  for (let x = -24; x <= 24; x++) for (let y = -24; y <= 24; y++) candidates.push({ x, y });
  candidates.sort(
    (a, b) =>
      a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y ||
      a.y - b.y ||
      Math.abs(a.x) - Math.abs(b.x) ||
      a.x - b.x,
  );
  for (const candidate of candidates) {
    if (comparisons > 2000000) break;
    const delta = offset({
      x: anchor.x + candidate.x * grid * 2,
      y: anchor.y + candidate.y * grid * 2,
    });
    if (fits(delta)) return delta;
  }
  throw new Error('The schematic has no supported nearby free space for this study.');
}
