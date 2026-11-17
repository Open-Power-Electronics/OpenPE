import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebaseLayoutCameraPoint, type LayoutView } from '../components/LayoutCamera';

type Point = { x: number; y: number };
type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

// Independently model the root viewport followed by its outer CSS transform.
function toScreen(point: Point, view: LayoutView, pixels: number, css: Affine): Point {
  const x = ((point.x - view.x) * pixels) / view.width;
  const y = ((point.y - view.y) * pixels) / view.width;
  return { x: css.a * x + css.c * y + css.e, y: css.b * x + css.d * y + css.f };
}
function fromScreen(point: Point, view: LayoutView, pixels: number, css: Affine): Point {
  const x = point.x - css.e,
    y = point.y - css.f,
    determinant = css.a * css.d - css.b * css.c;
  return {
    x: view.x + (((css.d * x - css.c * y) / determinant) * view.width) / pixels,
    y: view.y + (((css.a * y - css.b * x) / determinant) * view.width) / pixels,
  };
}
function close(actual: Point, expected: Point) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `${actual.y} != ${expected.y}`);
}

test('rebasing a pan point matches the new inverse CTM under outer CSS affine transforms', () => {
  const transforms: Affine[] = [
    { a: 1, b: 0, c: 0, d: 1, e: 124.5, f: 47.25 },
    { a: 1.25, b: 0, c: 0, d: 0.8, e: -30.3, f: 80.4 },
    { a: Math.cos(0.4), b: Math.sin(0.4), c: -Math.sin(0.4), d: Math.cos(0.4), e: 50, f: 65 },
    { a: 0.9, b: 0.23, c: -0.34, d: 1.15, e: 260.75, f: -91.5 },
    { a: -0.8, b: 0.2, c: 0.1, d: 1.2, e: 700, f: 20 },
  ];
  const before = { x: 29.1, y: 20.06121649324234, width: 141.8 };
  const after = { ...before, x: -8.7, y: 37.21 };
  for (const css of transforms)
    for (const pixels of [688.6666870117188, 843.5])
      for (const world of [
        { x: 99.75, y: 54.125 },
        { x: -900.5, y: 1900.25 },
      ]) {
        const screen = toScreen(world, before, pixels, css);
        close(
          rebaseLayoutCameraPoint(fromScreen(screen, before, pixels, css), before, after),
          fromScreen(screen, after, pixels, css),
        );
      }
});

test('rebasing includes the accepted width ratio, including the zoom limits', () => {
  const before = { x: 12.25, y: -60.2, width: 130 };
  const css = { a: 1.1, b: 0.35, c: -0.2, d: 0.7, e: 250, f: 73.5 };
  const screen = { x: 382.125, y: 523.75 };
  const mapped = fromScreen(screen, before, 843.5, css);
  for (const width of [8, 23.125, 130, 2000]) {
    const after = { x: -71.4, y: 108.1, width };
    close(rebaseLayoutCameraPoint(mapped, before, after), fromScreen(screen, after, 843.5, css));
  }
});

test('unchanged camera preserves the mapped point exactly', () => {
  const view = { x: 1.2, y: -4.7, width: 130 };
  const point = { x: 0.1, y: -0.2 };
  assert.equal(rebaseLayoutCameraPoint(point, view, { ...view }), point);
});
