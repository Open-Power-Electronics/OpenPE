import { child, num, val, type SExpr } from './sexpr';

type Reject = () => never;

function pngGeometry(data: string, reject: Reject) {
  if (!data || data.length > 1_000_000 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    return reject();
  const bytes = atob(data);
  if (bytes.length < 45 || !bytes.startsWith('\x89PNG\r\n\x1a\n')) return reject();
  const uint32 = (i: number) =>
    bytes.charCodeAt(i) * 0x1000000 +
    bytes.charCodeAt(i + 1) * 0x10000 +
    bytes.charCodeAt(i + 2) * 0x100 +
    bytes.charCodeAt(i + 3);
  if (uint32(8) !== 13 || bytes.slice(12, 16) !== 'IHDR') return reject();
  const width = uint32(16);
  const height = uint32(20);
  if (!width || !height || width > 4096 || height > 4096) return reject();
  let widthPPI = 300;
  let imageData = false;
  let density = false;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = uint32(offset);
    const kind = bytes.slice(offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > bytes.length) return reject();
    if (kind === 'IEND' && !length && end === bytes.length && imageData)
      return { width, height, widthPPI };
    if (kind === 'IDAT') imageData ||= length > 0;
    if (kind === 'pHYs') {
      if (density || imageData || length !== 9 || bytes.charCodeAt(offset + 16) > 1)
        return reject();
      density = true;
      const ppi = Math.round(uint32(offset + 8) * 0.0254);
      if (bytes.charCodeAt(offset + 16) === 1 && ppi > 1) widthPPI = ppi;
    }
    offset = end;
  }
  return reject();
}

/** KiCad places embedded artwork by its centre and native image density. */
export function readKiCadEmbeddedPng(node: SExpr, reject: Reject) {
  const at = child(node, 'at');
  const scaleRecord = child(node, 'scale');
  const data = child(node, 'data');
  if (
    at?.length !== 3 ||
    !val(at) ||
    !val(at, 2) ||
    (scaleRecord && (scaleRecord.length !== 2 || !val(scaleRecord))) ||
    !data ||
    !data.slice(1).every((value) => typeof value === 'string')
  )
    return reject();
  const x = num(at);
  const y = num(at, 2);
  const scale = scaleRecord ? num(scaleRecord) : 1;
  if (![x, y, scale].every(Number.isFinite) || scale <= 0) return reject();
  const encoded = data
    .slice(1)
    .map((_, i) => val(data, i + 1))
    .join('');
  const png = pngGeometry(encoded, reject);
  const mmPerPixel = (scale * 25.4) / png.widthPPI;
  const width = png.width * mmPerPixel;
  const height = png.height * mmPerPixel;
  if (
    width < 0.000001 ||
    height < 0.000001 ||
    Math.abs(x) + width / 2 > 100000 ||
    Math.abs(y) + height / 2 > 100000
  )
    return reject();
  return {
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
    pixels: png.width * png.height,
    href: `data:image/png;base64,${encoded}`,
  };
}
