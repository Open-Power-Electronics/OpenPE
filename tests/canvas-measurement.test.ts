import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCanvasMeasurement,
  measurementDistance,
  measurementAngles,
  measurementTicks,
  canvasScaleLength,
} from '../lib/canvas-measurement';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MeasurementReadout, MeasurementDrawing } from '../components/CanvasMeasurement';

test('measurement uses signed native-axis differences and Euclidean millimetre distance', () => {
  assert.deepEqual(measurementDistance({ x: 1, y: 2, z: 3 }, { x: 4, y: 6, z: 15 }), {
    x: 3,
    y: 4,
    z: 12,
    distance: 13,
  });
  assert.equal(measurementDistance({ x: 1, y: 2, z: 0 }, { x: 4, y: 6, z: 0 }).distance, 5);
});

test('two picks fix one result, hover cannot change it, and the next pick starts a new measurement', () => {
  const measurement = createCanvasMeasurement();
  measurement.place({ x: 1, y: 2, z: 0 });
  measurement.move({ x: 4, y: 6, z: 0 });
  assert.equal(measurement.getSnapshot().complete, false);
  measurement.confirm();
  const completed = measurement.getSnapshot();
  assert.equal(completed.complete, true);
  measurement.move({ x: 100, y: 100, z: 0 });
  assert.equal(measurement.getSnapshot(), completed);
  measurement.place({ x: 8, y: 9, z: 10 });
  assert.deepEqual(measurement.getSnapshot(), {
    start: { x: 8, y: 9, z: 10 },
    end: { x: 8, y: 9, z: 10 },
    complete: false,
    hover: null,
  });
  measurement.place({ x: 8, y: 9, z: 11 });
  assert.equal(measurement.getSnapshot().complete, true);
  measurement.clear();
  assert.deepEqual(measurement.getSnapshot(), {
    start: null,
    end: null,
    complete: false,
    hover: null,
  });
});

test('missing or nonfinite picks cannot fix an older valid preview', () => {
  const measurement = createCanvasMeasurement();
  measurement.place({ x: NaN, y: 0, z: 0 });
  assert.equal(measurement.getSnapshot().start, null);
  measurement.place({ x: 1, y: 2, z: 3 });
  measurement.move({ x: 4, y: 6, z: 3 });
  measurement.place(null);
  measurement.confirm();
  assert.equal(measurement.getSnapshot().end, null);
  assert.equal(measurement.getSnapshot().complete, false);
  measurement.move({ x: Infinity, y: 0, z: 0 });
  assert.equal(measurement.getSnapshot().end, null);
  measurement.place({ x: 1, y: 2, z: 3 });
  assert.equal(measurement.getSnapshot().complete, false, 'Coincident points remain unfinished.');
  measurement.clear();
  measurement.place({ x: 1e308, y: 0, z: 0 });
  measurement.move({ x: -1e308, y: 0, z: 0 });
  assert.equal(
    measurement.getSnapshot().end,
    null,
    'Finite coordinates cannot produce an infinite readout.',
  );
});

test('measurement snapshots copy picked geometry and remain isolated between editors', () => {
  const first = createCanvasMeasurement();
  const second = createCanvasMeasurement();
  const point = { x: 1, y: 2, z: 3, estimated: true as const };
  let notifications = 0;
  const unsubscribe = first.subscribe(() => notifications++);
  first.place(point);
  point.x = 99;
  assert.equal(first.getSnapshot().start?.x, 1);
  assert.equal(first.getSnapshot().start?.estimated, true);
  assert.equal(second.getSnapshot().start, null);
  const snapshot = first.getSnapshot();
  first.move({ x: 1, y: 2, z: 3, estimated: true });
  assert.equal(first.getSnapshot(), snapshot);
  assert.equal(notifications, 1);
  unsubscribe();
  first.clear();
  assert.equal(notifications, 1);
});

test('snap previews appear before the first pick without changing a fixed result', () => {
  const measurement = createCanvasMeasurement();
  measurement.move({ x: 1.23, y: 4.56, z: 0, snapped: true });
  assert.equal(measurement.getSnapshot().start, null);
  assert.equal(measurement.getSnapshot().hover?.x, 1.23);
  measurement.place({ x: 1.23, y: 4.56, z: 0, snapped: true });
  measurement.place({ x: 6.23, y: 4.56, z: 0, snapped: true });
  const end = measurement.getSnapshot().end;
  measurement.move({ x: 10, y: 20, z: 0, snapped: true });
  assert.equal(measurement.getSnapshot().end, end);
  assert.equal(measurement.getSnapshot().hover?.x, 10);
  const markup = renderToStaticMarkup(createElement(MeasurementReadout, { measurement }));
  assert.equal(
    markup.replace(/<[^>]*>/g, ''),
    '5.000 mmΔX 5.000 mm · ΔY 0.000 mm · Angle 0.000°',
    'Distance, signed deltas and angle are visible without hovering.',
  );
  assert.match(markup, /title="ΔX 5.000/);
  measurement.clear();
  assert.equal(measurement.getSnapshot().hover, null);
});

test('angles follow signed native axes and distinguish spatial elevation from XY bearing', () => {
  const origin = { x: 0, y: 0, z: 0 };
  for (const [x, y, expected] of [
    [1, 0, 0],
    [0, 1, 90],
    [-1, 1, 135],
    [-1, -1, -135],
    [1, -1, -45],
  ])
    assert.equal(measurementAngles(origin, { x, y, z: 0 }).angle, expected);
  assert.deepEqual(measurementAngles(origin, { x: 0, y: 0, z: -5 }), {
    angle: null,
    elevation: -90,
  });
  assert.deepEqual(measurementAngles(origin, origin), { angle: null, elevation: null });
  const measurement = createCanvasMeasurement();
  measurement.place(origin);
  measurement.place({ x: -3, y: 4, z: 5 });
  const markup = renderToStaticMarkup(
    createElement(MeasurementReadout, { measurement, spatial: true }),
  );
  const visible = markup.replace(/<[^>]*>/g, '');
  assert.match(visible, /ΔX -3.000 mm · ΔY 4.000 mm · ΔZ 5.000 mm/);
  assert.match(visible, /XY angle 126.870° · Elevation 45.000°/);
});

test('unnumbered ruler graduations share the lower-left scale and remain bounded', () => {
  const fine = measurementTicks(10, 0.02);
  const coarse = measurementTicks(10, 0.2);
  assert.equal(fine[1].distance, 2);
  assert.equal(fine.length, 6, 'One interval per scale-bar length, without minor subdivisions.');
  assert.equal(
    coarse.length,
    1,
    'Distances shorter than the scale bar have no intermediate ticks.',
  );
  assert.equal(fine[1].distance, canvasScaleLength(0.02));
  assert.equal(measurementTicks(40, 0.2)[1].distance, canvasScaleLength(0.2));
  for (const unitsPerPixel of [0.008, 0.01, 0.0199, 0.02, 0.1, 0.2, 1, 2]) {
    const scaleLength =
      [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((n) => n / unitsPerPixel <= 100).at(-1) ??
      0.1;
    assert.equal(canvasScaleLength(unitsPerPixel), scaleLength);
    const ticks = measurementTicks(scaleLength, unitsPerPixel);
    assert.equal(ticks.length, 2);
    assert.equal(ticks[1].distance, scaleLength);
  }
  assert.equal(fine.at(-1)!.fraction, 1);
  assert.ok(measurementTicks(1e6, 1e8).length <= 201);
  for (const distance of [0, NaN, Infinity, -1])
    assert.deepEqual(measurementTicks(distance, 100), []);
  assert.deepEqual(measurementTicks(10, 0), []);
  assert.deepEqual(measurementTicks(10, Infinity), []);
  const measurement = createCanvasMeasurement();
  measurement.place({ x: 10, y: 2, z: 0 });
  measurement.place({ x: 0, y: 2, z: 0 });
  const markup = renderToStaticMarkup(
    createElement(MeasurementDrawing, { measurement, scale: 0.02 }),
  );
  assert.match(markup, /data-measurement-ticks/);
  assert.match(markup, /<path d="M/);
  assert.doesNotMatch(markup, /<text/);
  assert.doesNotMatch(markup, /NaN|Infinity/);
});
