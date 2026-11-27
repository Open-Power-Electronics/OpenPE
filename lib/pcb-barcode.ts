import { isOwnedProjectNode } from './immutable-project-ownership.mjs';
import { child, val, type SExpr } from './sexpr';

export type PCBBarcode = Readonly<
  {
    id: string;
    layer: 'F.SilkS' | 'B.SilkS' | 'Edge.Cuts' | 'F.Cu' | 'B.Cu';
    x: number;
    y: number;
    rotation: number;
    width: number;
    height: number;
    value: string;
    textHeight: number;
    showText: boolean;
    knockout: boolean;
    marginX: number;
    marginY: number;
  } & ({ kind: 'qr'; ecc: 'L' | 'M' | 'Q' | 'H' } | { kind: 'datamatrix' })
>;

const cached = new WeakMap<SExpr, PCBBarcode>();
const fields = [
  'at',
  'layer',
  'size',
  'text',
  'text_height',
  'type',
  'ecc_level',
  'hide',
  'knockout',
  'margins',
  'locked',
  'uuid',
];

function unsupported(): never {
  throw new Error('KiCad PCB: Unsupported barcode. Use bounded QR or Data Matrix artwork.');
}

function readBarcode(node: SExpr): PCBBarcode {
  const previous = cached.get(node);
  if (previous) return previous;
  const seen = new Set<string>();
  if (node[0] !== 'barcode') return unsupported();
  for (const field of node.slice(1)) {
    if (
      !Array.isArray(field) ||
      typeof field[0] !== 'string' ||
      !fields.includes(field[0]) ||
      seen.has(field[0])
    )
      return unsupported();
    seen.add(field[0]);
    if (field.length !== (field[0] === 'at' ? 4 : ['size', 'margins'].includes(field[0]) ? 3 : 2))
      return unsupported();
  }
  const position = child(node, 'at');
  const size = child(node, 'size');
  const literal = child(node, 'text');
  const value = val(literal);
  const id = val(child(node, 'uuid'));
  const layer = val(child(node, 'layer'));
  const ecc = val(child(node, 'ecc_level'));
  const kind = val(child(node, 'type'));
  const knockout = val(child(node, 'knockout'));
  const margins = child(node, 'margins');
  const numeric = (record: SExpr | undefined, index = 1) => {
    const value = val(record, index);
    return value ? Number(value) : NaN;
  };
  const x = numeric(position);
  const y = numeric(position, 2);
  const rotation = numeric(position, 3);
  const width = numeric(size);
  const height = numeric(size, 2);
  const textHeight = numeric(child(node, 'text_height'));
  const marginX = margins ? numeric(margins) : 0;
  const marginY = margins ? numeric(margins, 2) : 0;
  const hide = val(child(node, 'hide'));
  const locked = val(child(node, 'locked'));
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
    (layer !== 'F.SilkS' &&
      layer !== 'B.SilkS' &&
      layer !== 'Edge.Cuts' &&
      layer !== 'F.Cu' &&
      layer !== 'B.Cu') ||
    (seen.has('knockout') && knockout !== 'no' && knockout !== 'yes') ||
    (seen.has('hide') && hide !== 'yes' && hide !== 'no') ||
    (seen.has('locked') && locked !== 'yes' && locked !== 'no') ||
    ![x, y, rotation, width, height, textHeight, marginX, marginY].every(
      (n) => Number.isFinite(n) && Math.abs(n) <= 100000,
    ) ||
    width < 0.01 ||
    height < 0.01 ||
    textHeight < 0.01 ||
    marginX < 0 ||
    marginY < 0 ||
    typeof literal?.[1] !== 'string' ||
    !literal[1].startsWith('"') ||
    !/^[\x20-\x7e]{1,128}$/.test(value) ||
    /\$\{|[~^_]\{/.test(value)
  )
    return unsupported();
  const placement = {
    id,
    layer,
    x,
    y,
    rotation,
    width,
    height,
    value,
    textHeight,
    showText: hide !== 'yes',
    knockout: knockout === 'yes',
    marginX,
    marginY,
  } as const;
  let barcode: PCBBarcode;
  if (kind === 'qr' && (ecc === 'L' || ecc === 'M' || ecc === 'Q' || ecc === 'H'))
    barcode = { ...placement, kind, ecc };
  else if (kind === 'datamatrix' && !seen.has('ecc_level')) barcode = { ...placement, kind };
  else return unsupported();
  if (isOwnedProjectNode(node)) cached.set(node, Object.freeze(barcode));
  return barcode;
}

export function pcbBarcodes(records?: SExpr[]): PCBBarcode[] {
  if (!records) return [];
  if (records.length > 32) return unsupported();
  return records.map(readBarcode);
}

export function hasPCBPhysicalBarcode(records?: SExpr[]): boolean {
  return pcbBarcodes(records).some(({ layer }) => layer.endsWith('.Cu') || layer === 'Edge.Cuts');
}
