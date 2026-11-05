import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ModelSketchCoordinates, {
  createModelSketchCoordinates,
} from '../components/ModelSketchCoordinates';

test('sketch readouts retain the exact preview point and label the active workplane axes', () => {
  const coordinates = createModelSketchCoordinates();
  const render = () => renderToStaticMarkup(createElement(ModelSketchCoordinates, { coordinates }));
  assert.equal(render(), '');
  coordinates.update({ plane: 'XY', cursor: null });
  assert.equal(render(), 'X — Y — mm');
  for (const [plane, expected] of [
    ['XY', 'X 1.50 Y -2.00 mm'],
    ['XZ', 'X 1.50 Z -2.00 mm'],
    ['YZ', 'Y 1.50 Z -2.00 mm'],
  ] as const) {
    coordinates.update({ plane, cursor: { x: 1.5, y: -2 } });
    assert.equal(render(), expected);
  }
  coordinates.update(null);
  assert.equal(render(), '', 'Leaving drawing removes the live sketch readout.');
});

test('retained projects own independent sketch readouts and suppress unchanged pointer notifications', () => {
  const first = createModelSketchCoordinates();
  const second = createModelSketchCoordinates();
  let notifications = 0;
  const unsubscribe = first.subscribe(() => notifications++);
  const pointer = { plane: 'XY' as const, cursor: { x: 2, y: 3.5 } };
  first.update(pointer);
  const snapshot = first.getSnapshot();
  pointer.cursor.x = 100;
  assert.deepEqual(snapshot, { plane: 'XY', cursor: { x: 2, y: 3.5 } });
  assert.equal(second.getSnapshot(), null);
  first.update({ plane: 'XY', cursor: { x: 2, y: 3.5 } });
  assert.equal(first.getSnapshot(), snapshot);
  assert.equal(notifications, 1);
  first.update({ plane: 'XZ', cursor: { x: 2, y: 3.5 } });
  assert.equal(notifications, 2, 'Changing workplane axes must refresh even at the same point.');
  first.update(null);
  first.update(null);
  assert.equal(notifications, 3);
  unsubscribe();
  first.update(pointer);
  assert.equal(notifications, 3);
});
