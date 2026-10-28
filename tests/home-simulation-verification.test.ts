import test from 'node:test';
import assert from 'node:assert/strict';
import {
  homeSimulationDurationFor,
  voltageWindow,
  verifyHomeOutput,
} from '../scripts/home-simulation-verification';
import { referenceExamples } from '../lib/reference-catalog';

test('Home verification uses 5 ms for LM27761 and 10 ms for the other eight profiles', () => {
  assert.equal(referenceExamples.length, 9);
  for (const entry of referenceExamples)
    assert.equal(
      homeSimulationDurationFor(entry.id),
      entry.modelId === 'reference-lm27761' ? 0.005 : 0.01,
    );
  const time = [0, 0.001, 0.003, 0.0035, 0.004, 0.0045, 0.005];
  const values = [-3.3, 0, -3.3, -3.31, -3.3, -3.29, -3.3];
  assert.ok(verifyHomeOutput(time, values, [-3.4, -3.2], 0.005).ripplePercent < 1);
  assert.throws(() => verifyHomeOutput(time, values, [-3.4, -3.2]), /complete.*10 ms/);
  assert.throws(
    () => verifyHomeOutput(time.slice(0, -1), values.slice(0, -1), [-3.4, -3.2], 0.005),
    /complete.*5 ms/,
  );
});

test('voltage verification weights irregular samples by time and clips window edges', () => {
  const window = voltageWindow([0, 0.1, 0.2, 1], [0, 0.1, 0.2, 1], 0.05, 0.9);
  assert.ok(Math.abs(window.mean - 0.475) < 1e-12);
  assert.ok(Math.abs(window.peakToPeak - 0.85) < 1e-12);
});

test('10 ms voltage verification accepts negative rails and rejects late startup drift', () => {
  const time = [0, 0.008, 0.0085, 0.009, 0.0095, 0.01];
  assert.ok(
    verifyHomeOutput(time, [-3.3, -3.3, -3.31, -3.3, -3.29, -3.3], [-3.4, -3.2]).ripplePercent < 1,
  );
  assert.throws(
    () => verifyHomeOutput(time, [0, 5, 5.04, 5.08, 5.12, 5.16], [4.8, 5.3]),
    /drift exceeds/,
  );
  assert.throws(() => verifyHomeOutput(time, [5, 5, 5.3, 5, 4.7, 5], [4.8, 5.3]), /ripple exceeds/);
});

test('incomplete, nonfinite and unordered solver samples cannot pass voltage verification', () => {
  assert.throws(() => verifyHomeOutput([0, 0.009], [5, 5], [4.8, 5.3]), /complete/);
  assert.throws(() => voltageWindow([0, 0.01], [5, NaN], 0.008, 0.01), /finite/);
  assert.throws(
    () => voltageWindow([0, 0.01, 0.009, 0.01], [5, 5, 5, 5], 0.008, 0.01),
    /strictly increasing/,
  );
});

test('additional derivative startup checks measure their actual final window without changing Home duration', () => {
  const time = [0, 0.008, 0.009, 0.01, 0.018, 0.019, 0.02];
  const values = [0, 4, 5, 6, 5, 5, 5];
  assert.equal(verifyHomeOutput(time, values, [4.8, 5.2], 0.02).mean, 5);
  assert.throws(() => verifyHomeOutput(time, values, [4.8, 5.2]), /complete.*10 ms/);
});
