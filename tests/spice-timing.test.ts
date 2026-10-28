import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceExamples, createReferenceExample } from '../lib/reference-examples';
import { createExample, projectExamples } from '../lib/examples';
import { createTiExample } from '../lib/ti-examples';
import { tiDcdcParts } from '../lib/ti-dcdc';
import { switchingStageFixture } from './fixtures/switching-stage';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';
import { transientOutputStep } from '../lib/spice-timing';

test('output timing retains the requested step for integral ratios despite floating-point rounding', () => {
  for (const durationMs of [10, 50])
    for (const maximumStepUs of [0.2, 0.1]) {
      // Match the Simulation dialog's displayed-unit conversion.
      const stop = durationMs * 0.001,
        step = maximumStepUs * 0.000001;
      assert.equal(transientOutputStep({ stop, step }), step);
    }
  assert.equal(transientOutputStep({ stop: 0.3, step: 0.1 }), 0.1);
});

test('output timing still includes the end for genuinely fractional interval counts', () => {
  for (const [stop, step, intervals] of [
    [0.0100001, 2e-7, 50001],
    [1.0000000001, 0.001, 1001],
  ]) {
    const outputStep = transientOutputStep({ stop, step });
    assert.equal(outputStep, stop / intervals);
    assert.ok(outputStep <= step);
    assert.ok(Math.abs(outputStep * intervals - stop) <= Number.EPSILON * stop);
  }
});

test('output timing stays finite, positive and bounded for short runs and overflowing ratios', () => {
  for (const [stop, step] of [
    [1e-9, 1],
    [Number.MIN_VALUE, 1],
    [Number.MIN_VALUE, Number.MIN_VALUE],
    [Number.MAX_VALUE, Number.MIN_VALUE],
  ]) {
    const outputStep = transientOutputStep({ stop, step });
    assert.ok(Number.isFinite(outputStep) && outputStep > 0);
    assert.ok(outputStep <= Math.min(stop, step));
  }
});

test('curated and vendor decks preserve displayed 10/50 ms timing with renderer/service parity', () => {
  for (const d of [
    createReferenceExample('reference-lm25017-wson8-flybuck').schematic,
    createTiExample(tiDcdcParts[0].id).schematic,
  ]) {
    for (const durationMs of [10, 50])
      for (const maximumStepUs of [0.2, 0.1]) {
        const config = {
          ...defaultTransient(d),
          stop: durationMs * 0.001,
          step: maximumStepUs * 0.000001,
        };
        const deck = buildSpiceDeck(d, config);
        assert.deepEqual(serviceDeck(d, config), deck);
        const timing = /^tran (\S+) (\S+) 0 (\S+)/m.exec(deck.netlist)!;
        assert.equal(Number(timing[1]), config.step);
        assert.equal(Number(timing[2]), config.stop);
        assert.equal(Number(timing[3]), config.step);
      }
    const config = { ...defaultTransient(d), stop: 0.0100001, step: 2e-7 };
    const deck = buildSpiceDeck(d, config);
    assert.deepEqual(serviceDeck(d, config), deck);
    assert.equal(Number(/^tran (\S+)/m.exec(deck.netlist)![1]), config.stop / 50001);
  }
});

test('renderer and service accept 10 ms / 0.5 µs for every supported example', () => {
  const circuits = [
    ...referenceExamples.map((example) => createReferenceExample(example.id).schematic),
    ...projectExamples.map((example) => createExample(example.id).schematic),
    ...tiDcdcParts.map((part) => createTiExample(part.id).schematic),
    switchingStageFixture(),
  ];
  for (const d of circuits) {
    const config = { ...defaultTransient(d), stop: 0.01, step: 0.5e-6 };
    const deck = buildSpiceDeck(d, config);
    assert.equal(deck.stop, config.stop);
    assert.deepEqual(serviceDeck(d, config), deck);
    assert.match(deck.netlist, / 0 5e-7(?: uic)?\n/);
  }
});

test('timing has no duration, step, interval-count, PWM-period or estimated-output limits', () => {
  const circuits = [
    createReferenceExample('reference-lm2596-to220-5-buck').schematic,
    createExample('kicad-rectifier').schematic,
    createExample('kicad-buck').schematic,
    createTiExample(tiDcdcParts[0].id).schematic,
    switchingStageFixture(),
  ];
  for (const d of circuits) {
    for (const patch of [
      { stop: 1, step: 1e-9 },
      { stop: 10, step: 0.002 },
      { stop: 1e-9, step: 1e-13 },
      { stop: 1e-9, step: 1 },
      { stop: Number.MAX_VALUE, step: Number.MIN_VALUE },
    ]) {
      const config = { ...defaultTransient(d), ...patch };
      const deck = buildSpiceDeck(d, config);
      assert.equal(deck.stop, config.stop);
      assert.deepEqual(serviceDeck(d, config), deck);
      const outputStep = Number(/^tran (\S+)/m.exec(deck.netlist)![1]);
      assert.ok(Number.isFinite(outputStep) && outputStep > 0);
    }
  }
});

test('timing requires finite positive solver inputs, with errors in displayed units', () => {
  for (const d of [
    createReferenceExample('reference-lm2596-to220-5-buck').schematic,
    switchingStageFixture(),
  ]) {
    const config = defaultTransient(d);
    for (const compile of [buildSpiceDeck, serviceDeck]) {
      for (const stop of [0, -1, NaN, Infinity, -Infinity])
        assert.throws(() => compile(d, { ...config, stop }), {
          message: 'Duration must be a finite number greater than 0 ms.',
        });
      for (const step of [0, -1, NaN, Infinity, -Infinity])
        assert.throws(() => compile(d, { ...config, step }), {
          message: 'Max. time step must be a finite number greater than 0 µs.',
        });
    }
  }
});
