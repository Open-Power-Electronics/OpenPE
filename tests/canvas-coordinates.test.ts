import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CanvasCoordinates, { createCanvasCoordinates } from '../components/CanvasCoordinates';

test('local origin resets only the relative snapshot while absolute coordinates stay unchanged', () => {
  const coordinates = createCanvasCoordinates();
  let calls = 0;
  const unsubscribe = coordinates.subscribe(() => calls++);
  coordinates.update({ x: 12, y: -7 });
  const absolute = coordinates.getSnapshot();
  assert.deepEqual(coordinates.getRelativeSnapshot(), {
    x: 12,
    y: -7,
    dx: 12,
    dy: -7,
    distance: Math.hypot(12, -7),
  });
  coordinates.resetOrigin();
  assert.equal(
    coordinates.getSnapshot(),
    absolute,
    'Origin reset cannot replace the absolute pointer snapshot.',
  );
  assert.deepEqual(coordinates.getRelativeSnapshot(), { x: 12, y: -7, dx: 0, dy: 0, distance: 0 });
  assert.equal(calls, 2);
  const reset = coordinates.getRelativeSnapshot();
  coordinates.resetOrigin();
  coordinates.update({ x: 12, y: -7 });
  assert.equal(coordinates.getRelativeSnapshot(), reset);
  assert.equal(calls, 2, 'No-op origin resets and pointer updates do not notify.');
  unsubscribe();
  coordinates.update({ x: 9, y: -3 });
  assert.deepEqual(coordinates.getRelativeSnapshot(), { x: 9, y: -3, dx: -3, dy: 4, distance: 5 });
  assert.equal(calls, 2);
});

test('each retained editor owns an independent local origin and copies caller points', () => {
  const first = createCanvasCoordinates(),
    second = createCanvasCoordinates(),
    point = { x: 1, y: 2 };
  first.update(point);
  first.resetOrigin();
  point.x = 99;
  first.update({ x: 4, y: -2 });
  second.update({ x: 4, y: -2 });
  assert.deepEqual(first.getRelativeSnapshot(), { x: 4, y: -2, dx: 3, dy: -4, distance: 5 });
  assert.deepEqual(second.getRelativeSnapshot(), {
    x: 4,
    y: -2,
    dx: 4,
    dy: -2,
    distance: Math.hypot(4, -2),
  });
});

test('default schematic coordinates retain their text while Layout may opt into relative measurements', () => {
  const coordinates = createCanvasCoordinates();
  coordinates.update({ x: 3, y: -4 });
  const render = (relative?: boolean) =>
    renderToStaticMarkup(createElement(CanvasCoordinates, { coordinates, relative })).replace(
      /<[^>]+>/g,
      '',
    );
  assert.equal(render(), 'X 3.00 Y -4.00 mm');
  assert.equal(render(true), 'X 3.00 Y -4.00 mm · dx 3.00 dy -4.00 dist 5.00 mm');
  coordinates.resetOrigin();
  assert.equal(render(), 'X 3.00 Y -4.00 mm');
  assert.equal(render(true), 'X 3.00 Y -4.00 mm · dx 0.00 dy 0.00 dist 0.00 mm');
});
