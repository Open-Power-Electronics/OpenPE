import { unitGraphics } from './library';
import { child, children, num, type SExpr } from './sexpr';

/** Local SVG bounds of the symbol body, excluding pins, names and instance fields. */
export function symbolBodyBounds(library: SExpr, unit = 1) {
  const points: { x: number; y: number }[] = [];
  const add = (x: number, y: number) => points.push({ x, y });
  const point = (node: SExpr) => ({ x: num(node), y: -num(node, 2) });
  for (const group of unitGraphics(library, unit)) {
    for (const graphic of group.filter((v): v is SExpr => Array.isArray(v))) {
      if (graphic[0] === 'rectangle') {
        for (const key of ['start', 'end']) points.push(point(child(graphic, key)!));
      } else if (graphic[0] === 'polyline') {
        points.push(...children(child(graphic, 'pts') || [], 'xy').map(point));
      } else if (graphic[0] === 'circle') {
        const c = point(child(graphic, 'center')!),
          r = num(child(graphic, 'radius'));
        add(c.x - r, c.y - r);
        add(c.x + r, c.y + r);
      } else if (graphic[0] === 'arc') {
        const a = point(child(graphic, 'start')!),
          b = point(child(graphic, 'mid')!),
          c = point(child(graphic, 'end')!);
        points.push(a, b, c);
        const det = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
        if (Math.abs(det) < 1e-8) continue;
        const aa = a.x * a.x + a.y * a.y,
          bb = b.x * b.x + b.y * b.y,
          cc = c.x * c.x + c.y * c.y;
        const x = (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / det;
        const y = (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / det;
        const positive = (v: number) => (v + Math.PI * 4) % (Math.PI * 2);
        const start = Math.atan2(a.y - y, a.x - x),
          mid = Math.atan2(b.y - y, b.x - x),
          end = Math.atan2(c.y - y, c.x - x);
        const forward = positive(mid - start) < positive(end - start);
        const span = forward ? positive(end - start) : positive(start - end),
          radius = Math.hypot(a.x - x, a.y - y);
        for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
          if ((forward ? positive(angle - start) : positive(start - angle)) <= span + 1e-8)
            add(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
        }
      }
    }
  }
  if (!points.length) return null; // Pin-only symbols retain their visible pin targets.
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) - x,
    height: Math.max(...points.map((p) => p.y)) - y,
  };
}
