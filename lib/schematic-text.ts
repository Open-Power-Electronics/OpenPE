import { child, children, num, val, type SExpr } from './sexpr';

// Imported free text stays in original, so Source, recovery and exports retain
// every byte of its semantic content. It is not an electrical net label.
export function schematicTexts(original?: SExpr) {
  return children(original || [], 'text').map((node) => {
    const effects = child(node, 'effects') || [];
    const font = child(effects, 'font') || [];
    const at = child(node, 'at');
    const size = child(font, 'size');
    const color = child(font, 'color');
    const justify = child(effects, 'justify')?.slice(1) || [];
    const known = (n: SExpr, keys: string[]) =>
      n.slice(1).every((v) => !Array.isArray(v) || keys.includes(String(v[0])));
    if (
      !known(node, ['at', 'effects', 'uuid', 'exclude_from_sim']) ||
      !known(effects, ['font', 'justify', 'href']) ||
      !known(font, ['size', 'color', 'bold', 'italic']) ||
      children(effects, 'href').length > 1 ||
      (child(effects, 'href') &&
        (child(effects, 'href')!.length !== 2 ||
          !/^https?:\/\/[^\s\x00-\x1f]{1,2040}$/.test(val(child(effects, 'href'))))) ||
      children(font, 'color').length > 1 ||
      (color &&
        (color.length !== 5 ||
          color
            .slice(1)
            .some(
              (value, i) =>
                typeof value !== 'string' ||
                !Number.isFinite(Number(value)) ||
                Number(value) < 0 ||
                Number(value) > (i === 3 ? 1 : 255),
            ))) ||
      font.slice(1).some((v) => !Array.isArray(v) && !['bold', 'italic'].includes(String(v))) ||
      effects.slice(1).some((v) => !Array.isArray(v)) ||
      justify.some((v) => !['left', 'right', 'top', 'bottom'].includes(String(v))) ||
      (justify.includes('left') && justify.includes('right')) ||
      (justify.includes('top') && justify.includes('bottom')) ||
      !at ||
      !size ||
      num(at, 3) !== 0 ||
      num(size) !== num(size, 2) ||
      ![num(at), num(at, 2), num(size)].every(Number.isFinite) ||
      Math.abs(num(at)) > 100000 ||
      Math.abs(num(at, 2)) > 100000 ||
      num(size) <= 0 ||
      num(size) > 1000 ||
      val(node).length > 4096 ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(val(child(node, 'uuid')))
    )
      throw new Error(
        'Unsupported schematic text. Use horizontal, plain text with equal font dimensions in KiCad. The original file was not modified.',
      );
    return {
      id: val(child(node, 'uuid')),
      text: val(node),
      x: num(at),
      y: num(at, 2),
      size: num(size),
      ...(font.includes('bold') || val(child(font, 'bold')) === 'yes' ? { bold: true } : {}),
      ...(font.includes('italic') || val(child(font, 'italic')) === 'yes' ? { italic: true } : {}),
      ...(child(effects, 'href') ? { href: val(child(effects, 'href')) } : {}),
      ...(color ? { color: color.slice(1).map(Number) as [number, number, number, number] } : {}),
      anchor: justify.includes('left')
        ? ('start' as const)
        : justify.includes('right')
          ? ('end' as const)
          : ('middle' as const),
      vertical: justify.includes('top') ? 'top' : justify.includes('bottom') ? 'bottom' : 'middle',
    };
  });
}

/** Non-electrical native outlines are retained and displayed with the Notes layer.
 * They are read-only on canvas; Source remains their editing boundary. */
export function schematicPolylines(original?: SExpr) {
  return children(original || [], 'polyline').map((node) => {
    const pts = child(node, 'pts'),
      stroke = child(node, 'stroke');
    const points = children(pts || [], 'xy').map((p) => ({ x: num(p), y: num(p, 2) }));
    const id = val(child(node, 'uuid')),
      width = num(child(stroke || [], 'width'));
    const type = val(child(stroke || [], 'type'));
    const known = (n: SExpr, keys: string[]) =>
      n.slice(1).every((v) => Array.isArray(v) && keys.includes(String(v[0])));
    const fill = child(node, 'fill');
    if (
      !known(node, ['pts', 'stroke', 'fill', 'uuid']) ||
      !pts ||
      !stroke ||
      (fill &&
        (fill.length !== 2 ||
          !child(fill, 'type') ||
          child(fill, 'type')!.length !== 2 ||
          val(child(fill, 'type')) !== 'none')) ||
      !known(pts, ['xy']) ||
      !known(stroke, ['width', 'type']) ||
      points.length < 2 ||
      points.length > 4096 ||
      children(pts, 'xy').some((p) => p.length !== 3) ||
      points.some((p) => ![p.x, p.y].every((v) => Number.isFinite(v) && Math.abs(v) <= 100000)) ||
      !Number.isFinite(width) ||
      width < 0 ||
      width > 100 ||
      !['default', 'solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'].includes(type) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    )
      throw new Error(
        'Unsupported schematic polyline. Use finite unfilled native outlines. The original file was not modified.',
      );
    return { id, points, width, type };
  });
}
