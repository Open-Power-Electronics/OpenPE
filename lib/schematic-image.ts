import { child, children, num, val, type SExpr } from './sexpr';
import { isOwnedProjectNode } from './immutable-project-ownership.mjs';

type SchematicImage = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
  href: string;
};
const cachedImages = new WeakMap<SExpr, SchematicImage>();
const invalidImage = (): never => {
  throw new Error(
    'Unsupported schematic image. Use bounded embedded PNG artwork. The original file was not modified.',
  );
};

function pngGeometry(data: string) {
  if (!data || data.length > 1_000_000 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    return invalidImage();
  const bytes = atob(data);
  if (bytes.length < 45 || !bytes.startsWith('\x89PNG\r\n\x1a\n')) return invalidImage();
  const uint32 = (i: number) =>
    bytes.charCodeAt(i) * 0x1000000 +
    bytes.charCodeAt(i + 1) * 0x10000 +
    bytes.charCodeAt(i + 2) * 0x100 +
    bytes.charCodeAt(i + 3);
  if (uint32(8) !== 13 || bytes.slice(12, 16) !== 'IHDR') return invalidImage();
  const width = uint32(16),
    height = uint32(20);
  if (!width || !height || width > 4096 || height > 4096) return invalidImage();
  let widthPPI = 300;
  let imageData = false;
  let density = false;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = uint32(offset);
    const kind = bytes.slice(offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > bytes.length) return invalidImage();
    if (kind === 'IEND' && !length && end === bytes.length && imageData)
      return { width, height, widthPPI };
    if (kind === 'IDAT') imageData ||= length > 0;
    if (kind === 'pHYs') {
      if (density || imageData || length !== 9 || bytes.charCodeAt(offset + 16) > 1)
        return invalidImage();
      density = true;
      const ppi = Math.round(uint32(offset + 8) * 0.0254);
      if (bytes.charCodeAt(offset + 16) === 1 && ppi > 1) widthPPI = ppi;
    }
    offset = end;
  }
  return invalidImage();
}

function readImage(node: SExpr): SchematicImage {
  const cached = cachedImages.get(node);
  if (cached) return cached;
  const at = child(node, 'at'),
    scaleRecord = child(node, 'scale');
  const uuid = child(node, 'uuid'),
    data = child(node, 'data');
  if (
    node.length !== (scaleRecord ? 5 : 4) ||
    at?.length !== 3 ||
    !val(at) ||
    !val(at, 2) ||
    uuid?.length !== 2 ||
    !data ||
    (scaleRecord && (scaleRecord.length !== 2 || !val(scaleRecord))) ||
    !data.slice(1).every((value) => typeof value === 'string')
  )
    return invalidImage();
  const id = val(uuid);
  const x = num(at),
    y = num(at, 2),
    scale = scaleRecord ? num(scaleRecord) : 1;
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
    ![x, y, scale].every(Number.isFinite) ||
    scale <= 0
  )
    return invalidImage();
  const encoded = data
    .slice(1)
    .map((_, i) => val(data, i + 1))
    .join('');
  const png = pngGeometry(encoded);
  const mmPerPixel = (scale * 25.4) / png.widthPPI;
  const width = png.width * mmPerPixel,
    height = png.height * mmPerPixel;
  if (
    width < 0.000001 ||
    height < 0.000001 ||
    Math.abs(x) + width / 2 > 100000 ||
    Math.abs(y) + height / 2 > 100000
  )
    return invalidImage();
  const image = {
    id,
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
    pixels: png.width * png.height,
    href: `data:image/png;base64,${encoded}`,
  };
  if (isOwnedProjectNode(node)) cachedImages.set(node, Object.freeze(image));
  return image;
}

export function schematicImages(original?: SExpr) {
  const records = children(original ?? [], 'image');
  if (records.length > 16) return invalidImage();
  const images = records.map(readImage);
  if (images.reduce((pixels, image) => pixels + image.pixels, 0) > 16_000_000)
    return invalidImage();
  return images;
}

export const schematicImageCorners = (original?: SExpr) =>
  schematicImages(original).flatMap(({ x, y, width, height }) => [
    { x, y },
    { x: x + width, y: y + height },
  ]);
