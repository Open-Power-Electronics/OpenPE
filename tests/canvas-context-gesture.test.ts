import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasContextGesture } from '../lib/canvas-context-gesture';

test('only a stationary completed right press opens commands and retains its original hit', () => {
  const gesture = createCanvasContextGesture<string>();
  const identity = {};
  const start = { id: 1, button: 2, x: 20, y: 30, identity, target: 'component' };
  for (const button of [0, 1]) {
    gesture.start({ ...start, button });
    assert.equal(gesture.finish({ ...start, button }), null);
  }
  gesture.start(start);
  gesture.move(1, 21, 31);
  assert.deepEqual(gesture.finish({ ...start, x: 21, y: 31, target: 'capturing canvas' }), {
    ...start,
    x: 21,
    y: 31,
  });
  assert.equal(gesture.finish(start), null, 'A completed press cannot open twice.');
});

test('right camera drags, cancelled presses, other pointers and changed documents never open commands', () => {
  const gesture = createCanvasContextGesture<string>();
  const start = { id: 1, button: 2, x: 20, y: 30, identity: {}, target: 'canvas' };
  gesture.start(start);
  gesture.move(1, 40, 30);
  gesture.move(1, 20, 30);
  assert.equal(
    gesture.finish(start),
    null,
    'Dragging back to the start is still a camera gesture.',
  );
  gesture.start(start);
  assert.equal(
    gesture.finish({ ...start, x: 40 }),
    null,
    'Release displacement is checked without a move event.',
  );
  gesture.start(start);
  gesture.cancel();
  assert.equal(gesture.finish(start), null);
  gesture.start(start);
  assert.equal(gesture.finish({ ...start, id: 2 }), null);
  gesture.start(start);
  assert.equal(gesture.finish({ ...start, identity: {} }), null);
  gesture.start(start);
  gesture.start({ ...start, button: 0 });
  assert.equal(gesture.finish(start), null);
});
