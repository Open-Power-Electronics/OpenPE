import { child, children, num, val, type SExpr } from './sexpr';

// Imported free text stays in original, so Source, recovery and exports retain
// every byte of its semantic content. It is not an electrical net label.
function readNote(node: SExpr, geometry: string[]) {
  const effects = child(node, 'effects') || [];
  const font = child(effects, 'font') || [];
  const at = child(node, 'at');
  const size = child(font, 'size');
  const thickness = child(font, 'thickness');
  const color = child(font, 'color');
  const justify = child(effects, 'justify')?.slice(1) || [];
  const known = (n: SExpr, keys: string[]) =>
    n.slice(1).every((v) => !Array.isArray(v) || keys.includes(String(v[0])));
  if (
    !known(node, ['at', ...geometry, 'effects', 'uuid', 'exclude_from_sim']) ||
    !known(effects, ['font', 'justify', 'href']) ||
    !known(font, ['size', 'thickness', 'color', 'bold', 'italic']) ||
    children(font, 'thickness').length > 1 ||
    (thickness !== undefined &&
      (thickness.length !== 2 ||
        !val(thickness) ||
        !Number.isFinite(num(thickness)) ||
        num(thickness) < 0 ||
        num(thickness) > 1000)) ||
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
    ...(thickness ? { thickness: num(thickness) } : {}),
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
}

export function schematicTexts(original?: SExpr) {
  return children(original ?? [], 'text').map((node) => readNote(node, []));
}

/** Retain text boxes as native notes, with Source as their editing boundary. */
export function schematicTextBoxes(original?: SExpr) {
  return children(original ?? [], 'text_box').map((node) => {
    const note = readNote(node, ['size', 'margins', 'stroke', 'fill']);
    const size = child(node, 'size');
    const stroke = child(node, 'stroke');
    const fill = child(node, 'fill');
    const marginsRecord = child(node, 'margins');
    const width = num(size),
      height = num(size, 2);
    const lineWidth = num(child(stroke ?? [], 'width'));
    const lineType = val(child(stroke ?? [], 'type'));
    // KiCad's explicit legacy default for a schematic text box without margins.
    const margin = Number((lineWidth / 2).toFixed(6)) + Number((note.size * 0.75).toFixed(6));
    const margins = marginsRecord?.slice(1).map(Number) ?? [margin, margin, margin, margin];
    const [left, top, right, bottom] = margins;
    if (
      size?.length !== 3 ||
      ![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 100000) ||
      Math.abs(note.x + width) > 100000 ||
      Math.abs(note.y + height) > 100000 ||
      stroke?.length !== 3 ||
      child(stroke, 'width')?.length !== 2 ||
      child(stroke, 'type')?.length !== 2 ||
      !Number.isFinite(lineWidth) ||
      lineWidth < 0 ||
      lineWidth > 100 ||
      !['default', 'solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'].includes(lineType) ||
      (fill &&
        (fill.length !== 2 ||
          child(fill, 'type')?.length !== 2 ||
          val(child(fill, 'type')) !== 'none')) ||
      margins.length !== 4 ||
      !margins.every((n) => Number.isFinite(n) && n >= 0) ||
      left + right >= width ||
      top + bottom >= height
    )
      throw new Error(
        'Unsupported schematic text box. Use finite unfilled rectangular notes. The original file was not modified.',
      );
    return { ...note, width, height, left, top, right, bottom, lineWidth, lineType };
  });
}

export const schematicNoteBoxCorners = (original?: SExpr) =>
  schematicTextBoxes(original).flatMap(({ x, y, width, height }) => [
    { x, y },
    { x: x + width, y: y + height },
  ]);

/** Non-electrical native outlines are retained and displayed with the Notes layer.
 * They are read-only on canvas; Source remains their editing boundary. */
export function schematicPolylines(original?: SExpr) {
  return (original ?? [])
    .filter(
      (node): node is SExpr =>
        Array.isArray(node) && (node[0] === 'polyline' || node[0] === 'rectangle'),
    )
    .map((node) => {
      const rectangle = node[0] === 'rectangle';
      const pts = child(node, 'pts'),
        stroke = child(node, 'stroke'),
        start = child(node, 'start'),
        end = child(node, 'end');
      const vertices = rectangle ? [start ?? [], end ?? []] : children(pts || [], 'xy');
      const points = vertices.map((p) => ({ x: num(p), y: num(p, 2) }));
      const id = val(child(node, 'uuid')),
        width = num(child(stroke || [], 'width'));
      const type = val(child(stroke || [], 'type'));
      const known = (n: SExpr, keys: string[]) =>
        n.slice(1).every((v) => Array.isArray(v) && keys.includes(String(v[0])));
      const fill = child(node, 'fill');
      if (
        !known(node, [...(rectangle ? ['start', 'end'] : ['pts']), 'stroke', 'fill', 'uuid']) ||
        !stroke ||
        (fill &&
          (fill.length !== 2 ||
            !child(fill, 'type') ||
            child(fill, 'type')!.length !== 2 ||
            val(child(fill, 'type')) !== 'none')) ||
        (rectangle
          ? points[0].x === points[1].x || points[0].y === points[1].y
          : !pts || !known(pts, ['xy'])) ||
        !known(stroke, ['width', 'type']) ||
        points.length < 2 ||
        points.length > 4096 ||
        vertices.some(
          (p) => p.length !== 3 || typeof p[1] !== 'string' || typeof p[2] !== 'string',
        ) ||
        points.some((p) => ![p.x, p.y].every((v) => Number.isFinite(v) && Math.abs(v) <= 100000)) ||
        !Number.isFinite(width) ||
        width < 0 ||
        width > 100 ||
        !['default', 'solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'].includes(type) ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      )
        throw new Error(
          `Unsupported schematic ${node[0]}. Use finite unfilled native outlines. The original file was not modified.`,
        );
      if (rectangle) {
        const [a, b] = points;
        return { id, points: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a], width, type };
      }
      return { id, points, width, type };
    });
}
