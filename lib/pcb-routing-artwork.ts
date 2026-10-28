import type { Point } from './circuit';
import type { BoardLine, BoardText, PCB } from './pcb';
import { isOwnedProjectNode } from './immutable-project';

/** The three strokes used by OpenPE's bounded dimension representation.
 * Derive local strokes before transforming footprint artwork into board space.
 * Captions and native arrow/extension styles are outside this helper.
 */
export function pcbDimensionStrokes(g: BoardLine): BoardLine[] {
  if (g.kind !== 'dimension' || !g.dimension) return [];
  const dx = g.end.x - g.start.x,
    dy = g.end.y - g.start.y,
    length = Math.hypot(dx, dy) || 1,
    height = g.dimension.height ?? 0,
    offset = { x: (-dy / length) * height, y: (dx / length) * height },
    a = { x: g.start.x + offset.x, y: g.start.y + offset.y },
    b = { x: g.end.x + offset.x, y: g.end.y + offset.y };
  return [g.start, a, b].map((start, i) => ({
    id: g.id,
    start: { ...start },
    end: { ...[a, b, g.end][i] },
    width: g.width,
    layer: g.layer,
  }));
}

/** Font-independent conservative copper envelopes, only for private collision checks.
 * Original artwork, networks and project content remain unchanged.
 */
function textEnvelope(g: BoardLine, text: BoardText, at: Point): BoardLine[] {
  if (text.hidden || !text.value) return [];
  const lines = text.value.split('\n');
  const width = Math.max(...lines.map((line) => Array.from(line).length)) * text.size.x * 2;
  const height = lines.length * text.size.y * 1.5;
  const radius = Math.hypot(width, height) + text.thickness / 2;
  return [
    {
      id: g.id,
      kind: 'circle',
      start: at,
      end: { x: at.x + radius, y: at.y },
      width: g.width,
      layer: g.layer,
      fill: true,
    },
  ];
}
function artwork(graphics: BoardLine[]): BoardLine[] {
  return graphics.flatMap((g) => {
    if (!g.layer.endsWith('.Cu')) return [g];
    if (g.kind === 'text' && g.text) return textEnvelope(g, g.text, g.start);
    if (g.kind !== 'dimension' || !g.dimension) return [g];
    return pcbDimensionStrokes(g).concat(textEnvelope(g, g.dimension.caption, g.dimension.caption));
  });
}
export function preparePCBArtworkObstacles(board: PCB): PCB {
  return {
    ...board,
    graphics: artwork(board.graphics),
    footprints: board.footprints.map((footprint) => {
      const graphics = artwork(footprint.graphics);
      // Keep the exact immutable pose/pads available to private contour caches.
      // Mutable callers still receive the original independent wrapper.
      return isOwnedProjectNode(footprint) &&
        graphics.length === footprint.graphics.length &&
        graphics.every((graphic, index) => graphic === footprint.graphics[index])
        ? footprint
        : { ...footprint, graphics };
    }),
  };
}
