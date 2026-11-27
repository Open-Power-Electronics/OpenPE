import type { Point } from './circuit';
import { nativeIdentity } from './kicad-project-identity';
import type { BoardLine } from './pcb';
import { pcbBoardLayers } from './pcb-layer-stack';
import { child, val, type SExpr } from './sexpr';

const strokeTypes = ['default', 'solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'] as const;
const fail = (): never => {
  throw new Error('KiCad PCB: Unsupported native PCB table geometry or cell fields.');
};

function fields(record: SExpr, offset: number, names: readonly string[]) {
  const result = new Map<string, SExpr>();
  for (const entry of record.slice(offset)) {
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== 'string' ||
      !names.includes(entry[0]) ||
      result.has(entry[0])
    )
      return fail();
    result.set(entry[0], entry);
  }
  return result;
}

function number(record: SExpr | undefined, index = 1) {
  const atom = val(record, index);
  const value = Number(atom);
  return !atom || !Number.isFinite(value) || Math.abs(value) > 100000 ? fail() : value;
}

function point(record?: SExpr): Point {
  return record?.length === 3 ? { x: number(record), y: number(record, 2) } : fail();
}

function flag(record?: SExpr): boolean {
  return record?.length === 2 && (record[1] === 'yes' || record[1] === 'no')
    ? record[1] === 'yes'
    : fail();
}

function positiveSizes(record?: SExpr): number[] {
  if (!record || record.length < 2 || record.length > 257) return fail();
  return record.slice(1).map((_, index) => {
    const size = number(record, index + 1);
    return size > 0 ? size : fail();
  });
}

function strokeSettings(record: SExpr | undefined, keys: readonly string[]) {
  if (!record) return fail();
  const values = fields(record, 1, [...keys, 'stroke']);
  const stroke = values.get('stroke');
  const width = child(stroke ?? [], 'width');
  const type = child(stroke ?? [], 'type');
  const kind = strokeTypes.find((name) => name === val(type));
  if (stroke?.length !== 3 || width?.length !== 2 || type?.length !== 2 || !kind) return fail();
  return {
    enabled: keys.map((key) => flag(values.get(key))),
    width: number(width),
    stroke: kind,
  };
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const samePoint = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= 0.000003;
const sameSize = (value: number, expected: number) => Math.abs(value - expected) <= 0.000003;

/** KiCad stores the cell rectangles in world coordinates, including rotated tables. */
export function readNativePCBTable(record: SExpr) {
  if (record[0] !== 'table') return fail();
  const native = fields(record, 1, [
    'column_count',
    'uuid',
    'layer',
    'border',
    'separators',
    'column_widths',
    'row_heights',
    'cells',
    'locked',
  ]);
  const id = val(native.get('uuid'));
  const layer = pcbBoardLayers.find((name) => name === val(native.get('layer')));
  const widths = positiveSizes(native.get('column_widths'));
  const heights = positiveSizes(native.get('row_heights'));
  const cellRecords = native.get('cells')?.slice(1) ?? [];
  const columns = widths.length;
  const rows = heights.length;
  const locked = native.get('locked');
  if (
    native.get('uuid')?.length !== 2 ||
    !uuidPattern.test(id) ||
    !layer ||
    native.get('layer')?.length !== 2 ||
    native.get('column_count')?.length !== 2 ||
    number(native.get('column_count')) !== columns ||
    cellRecords.length !== columns * rows ||
    cellRecords.length > 256
  )
    return fail();
  if (locked) flag(locked);

  const border = strokeSettings(native.get('border'), ['external', 'header']);
  const separators = strokeSettings(native.get('separators'), ['rows', 'cols']);
  const cells = cellRecords.map((cell, index) => {
    if (
      !Array.isArray(cell) ||
      cell[0] !== 'table_cell' ||
      typeof cell[1] !== 'string' ||
      !cell[1].startsWith('"') ||
      val(cell).includes('${')
    )
      return fail();
    const cellFields = fields(cell, 2, [
      'start',
      'end',
      'pts',
      'margins',
      'span',
      'angle',
      'layer',
      'uuid',
      'effects',
      'render_cache',
      'locked',
    ]);
    const span = cellFields.get('span');
    const nativeLayer = cellFields.get('layer');
    const uuid = cellFields.get('uuid');
    const outline = cellFields.get('pts');
    if (
      span?.length !== 3 ||
      span[1] !== '1' ||
      span[2] !== '1' ||
      nativeLayer?.length !== 2 ||
      val(nativeLayer) !== layer ||
      uuid?.length !== 2 ||
      !uuidPattern.test(val(uuid))
    )
      return fail();
    let corners: Point[];
    if (outline) {
      if (outline.length !== 5 || cellFields.has('start') || cellFields.has('end')) return fail();
      corners = outline
        .slice(1)
        .map((item) => (Array.isArray(item) && item[0] === 'xy' ? point(item) : fail()));
    } else {
      const start = point(cellFields.get('start'));
      const end = point(cellFields.get('end'));
      corners = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
    }
    const angle = cellFields.has('angle') ? number(cellFields.get('angle')) : 0;
    const rad = (angle * Math.PI) / 180;
    const [topLeft, topRight, bottomRight, bottomLeft] = corners;
    const w = widths[index % columns];
    const h = heights[Math.floor(index / columns)];
    const corner = (dx: number, dy: number) => ({
      x: topLeft.x + dx * Math.cos(rad) + dy * Math.sin(rad),
      y: topLeft.y - dx * Math.sin(rad) + dy * Math.cos(rad),
    });
    if (
      !sameSize(Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y), w) ||
      !samePoint(topRight, corner(w, 0)) ||
      !samePoint(bottomRight, corner(w, h)) ||
      !samePoint(bottomLeft, corner(0, h))
    )
      return fail();
    const text: SExpr = [
      'gr_text_box',
      cell[1],
      ...cell.slice(2).filter((entry) => entry !== span),
      ['border', 'no'],
      ['stroke', ['width', '0'], ['type', 'default']],
      ['knockout', 'no'],
    ];
    return { corners, text };
  });
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const at = cells[row * columns + col].corners;
      const right = col + 1 < columns ? cells[row * columns + col + 1].corners : null;
      const below = row + 1 < rows ? cells[(row + 1) * columns + col].corners : null;
      if (right && (!samePoint(at[1], right[0]) || !samePoint(at[2], right[3]))) return fail();
      if (below && (!samePoint(at[3], below[0]) || !samePoint(at[2], below[1]))) return fail();
    }
  }

  const borders: BoardLine[] = [];
  const line = (start: Point, end: Point, style: typeof border) => {
    if (style.width <= 0) return fail();
    borders.push({
      id: nativeIdentity(`${id}:table border:${borders.length}`),
      layer,
      start,
      end,
      width: style.width,
      stroke: style.stroke,
    });
  };
  const [external, header] = border.enabled;
  const [drawRows, drawColumns] = separators.enabled;
  for (let col = 0; col < columns - 1; col++)
    for (let row = 0; row < rows; row++) {
      const style = row === 0 && header ? border : drawColumns ? separators : null;
      const [, start, end] = cells[row * columns + col].corners;
      if (style) line(start, end, style);
    }
  for (let row = 0; row < rows - 1; row++)
    for (let col = 0; col < columns; col++) {
      const style = row === 0 && header ? border : drawRows ? separators : null;
      const [, , start, end] = cells[row * columns + col].corners;
      if (style) line(start, end, style);
    }
  if (external) {
    const first = cells[0].corners[0];
    const right = cells[columns - 1].corners[1];
    const bottom = cells.at(-1)!.corners[2];
    const left = cells[(rows - 1) * columns].corners[3];
    line(first, right, border);
    line(right, bottom, border);
    line(bottom, left, border);
    line(left, first, border);
  }
  return { id, layer, cells: cells.map((cell) => cell.text), borders };
}
