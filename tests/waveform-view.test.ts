import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changeWaveformView,
  initialWaveformHistory,
  navigateWaveformView,
  panWaveformAxis,
  parseWaveformNumber,
  validWaveformAxis,
  validWaveformTime,
  waveformSampleWindow,
  waveformTicks,
  zoomWaveformAxis,
} from '../plugins/spice-simulation/domain/waveform-view';

test('axis inputs accept engineering values without evaluating expressions', () => {
  assert.equal(parseWaveformNumber('100us', 's'), 0.0001);
  assert.equal(parseWaveformNumber('-2.5mV', 'V'), -0.0025);
  assert.equal(parseWaveformNumber('1M', 'V'), 1e6);
  assert.equal(parseWaveformNumber('1m', 'V'), 0.001);
  assert.equal(parseWaveformNumber('1e-3 s', 's'), 0.001);
  for (const value of ['', '1+2', 'Infinity', '1V extra', '1A', 'process.exit()'])
    assert.ok(Number.isNaN(parseWaveformNumber(value, 'V')));
  for (const axis of [
    { min: 2, max: 1 },
    { min: 0, max: Infinity },
    { min: 1, max: 1 },
    { min: 0, max: 1, step: 0 },
    { min: 0, max: 1, step: 1e-9 },
    { min: 0, max: 1, step: 2 },
  ])
    assert.equal(validWaveformAxis(axis), false);
});
test('visible sample bounds respect nonuniform solver time and reject empty/subsample views', () => {
  const time = [0, 0.0001, 0.00011, 0.002, 0.01];
  assert.deepEqual(waveformSampleWindow(time, { min: 0.0001, max: 0.002 }), [1, 3]);
  assert.equal(validWaveformTime(time, { min: 0.0001, max: 0.002 }), true);
  assert.equal(validWaveformTime(time, { min: 0.00012, max: 0.001 }), false);
  assert.equal(validWaveformTime(time, { min: -1, max: 0.002 }), false);
  assert.equal(validWaveformTime(time, { min: 0, max: 0.011 }), false);
});
test('ticks cover signed limits and remain bounded', () => {
  assert.deepEqual(
    waveformTicks({ min: -0.3, max: 0.3, step: 0.1 }),
    [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3],
  );
  assert.ok(waveformTicks({ min: 0, max: 1, step: 1e-30 }).length <= 101);
});

test('button zoom preserves centres, clamps time bounds and resets explicit ticks', () => {
  const bounds = { min: 0, max: 10 };
  assert.deepEqual(zoomWaveformAxis({ ...bounds, step: 2 }, 0.5, bounds), {
    min: 2.5,
    max: 7.5,
  });
  assert.deepEqual(zoomWaveformAxis({ min: 2.5, max: 7.5 }, 2, bounds), bounds);
  assert.deepEqual(zoomWaveformAxis({ min: 0, max: 2 }, 2, bounds), { min: 0, max: 4 });
  assert.deepEqual(zoomWaveformAxis({ min: 8, max: 10 }, 2, bounds), { min: 6, max: 10 });
  assert.deepEqual(zoomWaveformAxis(bounds, 2, bounds), bounds);
  assert.deepEqual(zoomWaveformAxis({ min: 0.0025, max: 0.0075 }, 2, { min: 0, max: 0.01 }), {
    min: 0,
    max: 0.01,
  });
  assert.deepEqual(zoomWaveformAxis({ min: -0.5, max: 0.5, step: 0.1 }, 2), {
    min: -1,
    max: 1,
  });
  // A live full-duration view can extend past the samples computed so far.
  assert.deepEqual(zoomWaveformAxis(bounds, 0.5, { min: 0, max: 1 }), { min: 0, max: 1 });
  for (const factor of [0, -1, NaN, Infinity, Number.MIN_VALUE])
    assert.equal(zoomWaveformAxis(bounds, factor), null);
  assert.equal(zoomWaveformAxis({ min: 1, max: 1 }, 2), null);
  assert.equal(zoomWaveformAxis(bounds, 2, { min: 1, max: 0 }), null);
  assert.equal(zoomWaveformAxis({ min: -1e308, max: 1e308 }, 2), null);
});

test('panning retains scale and ticks, clamps recorded time and rejects invalid translations', () => {
  const axis = { min: 2, max: 6, step: 1 };
  const bounds = { min: 0, max: 10 };
  assert.deepEqual(panWaveformAxis(axis, 1, bounds), { min: 3, max: 7, step: 1 });
  assert.deepEqual(panWaveformAxis(axis, -10, bounds), { min: 0, max: 4, step: 1 });
  assert.deepEqual(panWaveformAxis(axis, 10, bounds), { min: 6, max: 10, step: 1 });
  assert.deepEqual(panWaveformAxis(axis, -10), { min: -8, max: -4, step: 1 });
  assert.deepEqual(panWaveformAxis(bounds, 5, bounds), bounds);
  for (const delta of [NaN, Infinity, -Infinity])
    assert.equal(panWaveformAxis(axis, delta, bounds), null);
  assert.equal(panWaveformAxis(axis, 0, { min: 0, max: 1 }), null);
  assert.equal(panWaveformAxis(axis, 0, { min: 1, max: 0 }), null);
  assert.equal(panWaveformAxis(axis, 1e308), null);
});
test('view history restores time and per-trace scales, bounds memory and clears abandoned redo', () => {
  let history = initialWaveformHistory();
  const full = history.present;
  history = changeWaveformView(history, {
    ...full,
    time: { min: 0.001, max: 0.002 },
    values: { i: { min: -1, max: 2, step: 0.5 } },
  });
  const zoom = history.present;
  assert.deepEqual(navigateWaveformView(history, 'back').present, full);
  assert.deepEqual(
    navigateWaveformView(navigateWaveformView(history, 'back'), 'forward').present,
    zoom,
  );
  history = changeWaveformView(navigateWaveformView(history, 'back'), { ...full, range: 'tail' });
  assert.equal(history.future.length, 0);
  for (let i = 1; i < 100; i++)
    history = changeWaveformView(history, { ...full, time: { min: 0, max: i } });
  assert.equal(history.past.length, 64);
});
