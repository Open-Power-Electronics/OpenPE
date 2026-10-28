import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flushLayoutCamera, registerLayoutCameraFlush } from '../lib/layout-camera-presentation';
import { captureLayoutPNG } from '../lib/drawing-export';
import { annotationSelectionBounds, captureAnnotationImage } from '../lib/annotation-screenshot';
import { captureAgentPresentation } from '../context/agent-presentation';

const svg = () => ({}) as SVGSVGElement;

test('camera capture flushes remain scoped to their exact mounted SVG', () => {
  const first = svg(),
    second = svg();
  const calls: string[] = [];
  const stopFirst = registerLayoutCameraFlush(first, () => calls.push('first'));
  const stopSecond = registerLayoutCameraFlush(second, () => calls.push('second'));
  flushLayoutCamera(null);
  flushLayoutCamera(svg());
  flushLayoutCamera(second);
  flushLayoutCamera(first);
  assert.deepEqual(calls, ['second', 'first']);
  stopFirst();
  stopSecond();
  flushLayoutCamera(first);
  flushLayoutCamera(second);
  assert.deepEqual(calls, ['second', 'first']);
});

test('cleanup of an obsolete camera binding cannot unregister a replacement with the same callback', () => {
  const target = svg();
  let calls = 0;
  const flush = () => calls++;
  const stopFirst = registerLayoutCameraFlush(target, flush);
  const stopCurrent = registerLayoutCameraFlush(target, flush);
  stopFirst();
  flushLayoutCamera(target);
  assert.equal(calls, 1);
  stopCurrent();
  stopFirst();
  flushLayoutCamera(target);
  assert.equal(calls, 1);
});

test('a new lease retires its predecessor before claiming camera ownership', () => {
  const target = svg();
  const calls: string[] = [];
  const first = registerLayoutCameraFlush(
    target,
    () => calls.push('first'),
    () => {
      assert.equal(first.isCurrent(), true);
      calls.push('retired');
    },
  );
  const second = registerLayoutCameraFlush(target, () => calls.push('second'));
  assert.deepEqual(calls, ['retired']);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  first();
  flushLayoutCamera(target);
  assert.deepEqual(calls, ['retired', 'second']);
  second();
  assert.equal(second.isCurrent(), false);
});

test('a failed camera flush remains retryable and blocks capture before DOM reads', async () => {
  const target = svg();
  let calls = 0;
  const stop = registerLayoutCameraFlush(target, () => {
    calls++;
    throw new Error('Exact camera unavailable');
  });
  try {
    assert.throws(() => annotationSelectionBounds(target, ['part']), /Exact camera unavailable/);
    await assert.rejects(
      captureLayoutPNG(target, { minX: 0, minY: 0, maxX: 20, maxY: 10 }),
      /Exact camera unavailable/,
    );
    await assert.rejects(
      captureAnnotationImage(target, ['part'], { x: 0, y: 0, width: 20, height: 10 }),
      /Exact camera unavailable/,
    );
    assert.equal(calls, 3);
  } finally {
    stop();
  }
});

test('explicit Agent observation rebases visible drawing geometry and leaves hidden projects untouched', () => {
  let flushed = false,
    hidden = false,
    flushes = 0;
  let viewBox = '-10 -20 200 150';
  const bounds = { left: 10, top: 20, right: 810, bottom: 620, width: 800, height: 600 };
  const target = {
    parentElement: null,
    clientWidth: 800,
    clientHeight: 600,
    closest: () => (hidden ? {} : null),
    getClientRects: () => [bounds],
    getBoundingClientRect: () => {
      assert.equal(flushed, true, 'No presentation bounds are cached before the native rebase.');
      return bounds;
    },
    getAttribute: (name: string) => (name === 'viewBox' ? viewBox : 'PCB layout editor'),
  } as unknown as SVGSVGElement;
  const root = {
    querySelectorAll: (selector: string) => (selector.startsWith('.canvas-wrap') ? [target] : []),
  } as unknown as HTMLElement;
  const globals = [
    'document',
    'NodeFilter',
    'getComputedStyle',
    'innerWidth',
    'innerHeight',
  ] as const;
  const original = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const replacements = {
    document: { createTreeWalker: () => ({ nextNode: () => false }) },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ visibility: 'visible' }),
    innerWidth: 1200,
    innerHeight: 900,
  };
  const stop = registerLayoutCameraFlush(target, () => {
    flushed = true;
    flushes++;
    viewBox = '3 4 100 75';
  });
  try {
    for (const name of globals)
      Object.defineProperty(globalThis, name, { configurable: true, value: replacements[name] });
    assert.deepEqual(captureAgentPresentation(root).drawings, [
      {
        label: 'PCB layout editor',
        viewBox: '3 4 100 75',
        width: 800,
        height: 600,
      },
    ]);
    assert.equal(flushes, 1);
    hidden = true;
    assert.deepEqual(captureAgentPresentation(root).drawings, []);
    assert.equal(flushes, 1);
  } finally {
    stop();
    globals.forEach((name, index) => {
      if (original[index]) Object.defineProperty(globalThis, name, original[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
