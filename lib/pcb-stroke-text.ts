import type { Point } from './circuit';
import type { BoardText } from './pcb';
import glyphs from './manufacturing-font.json';

/** Lay out the bundled KiCad stroke glyphs in board millimetres. */
export function pcbStrokeText(
  text: BoardText,
  origin: Point,
): { paths: Point[][]; width: number } | { unsupported: string } {
  if (/\$\{|[~^_]\{/.test(text.value)) return { unsupported: 'unresolved or formatted text' };
  const lines: string[][] = [];
  for (const line of text.value.split('\n')) {
    const encoded: string[] = [];
    for (const char of line) {
      const code = char.codePointAt(0)!;
      const glyph = glyphs[code - 32];
      if (!glyph || glyph === glyphs[0x7f - 32])
        return { unsupported: `text character U+${code.toString(16).toUpperCase()}` };
      encoded.push(glyph);
    }
    lines.push(encoded);
  }
  const angle = (-text.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const mirror = text.justify?.includes('mirror') ? -1 : 1;
  const spacing = 1.25 * text.size.y;
  const top = text.justify?.includes('top')
    ? text.size.y
    : text.justify?.includes('bottom')
      ? -(lines.length - 1) * spacing
      : text.size.y / 2 - ((lines.length - 1) * spacing) / 2;
  const advance = (glyph: string) =>
    ((glyph.charCodeAt(1) - glyph.charCodeAt(0)) * text.size.x) / 21;
  const paths: Point[][] = [];
  for (const [index, line] of lines.entries()) {
    const lineWidth = line.reduce((width, glyph) => width + advance(glyph), 0);
    let cursor = text.justify?.includes('left')
      ? 0
      : text.justify?.includes('right')
        ? -lineWidth
        : -lineWidth / 2;
    for (const glyph of line) {
      let path: Point[] = [];
      const left = glyph.charCodeAt(0);
      for (let i = 2; i < glyph.length; i += 2) {
        if (glyph.slice(i, i + 2) === ' R') {
          if (path.length > 1) paths.push(path);
          path = [];
          continue;
        }
        const y = ((glyph.charCodeAt(i + 1) - 82 - 8) * text.size.y) / 21;
        const x =
          (cursor + ((glyph.charCodeAt(i) - left) * text.size.x) / 21 - (text.italic ? y / 8 : 0)) *
          mirror;
        const yy = y + top + index * spacing;
        path.push({ x: origin.x + x * cos - yy * sin, y: origin.y + x * sin + yy * cos });
      }
      if (path.length > 1) paths.push(path);
      cursor += advance(glyph);
    }
  }
  return {
    paths,
    width: text.thickness || Math.min(text.size.x, text.size.y) / (text.bold ? 5 : 8),
  };
}
