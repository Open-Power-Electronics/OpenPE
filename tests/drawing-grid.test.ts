import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLayoutGridApplicator, layoutGridMetrics } from '../lib/drawing-grid';
import { captureLayoutPNG } from '../lib/drawing-export';
import { captureAnnotationImage } from '../lib/annotation-screenshot';
import { registerLayoutCameraFlush } from '../lib/layout-camera-presentation';

class Element {
  attributes = new Map<string, string>();
  children: Element[] = [];
  queries = 0;
  writes = 0;
  style = {
    values: new Map<string, string>(),
    setProperty(name: string, value: string) {
      this.values.set(name, value);
    },
  };
  constructor(
    readonly tagName: string,
    attributes: Record<string, string> = {},
  ) {
    this.attributes = new Map(Object.entries(attributes));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.writes++;
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  append(node: Element) {
    this.children.push(node);
  }
  querySelector(selector: string): Element | null {
    this.queries++;
    if (selector === '[data-layout-grid-pattern]')
      return (
        this.children.find((child) => child.attributes.has('data-layout-grid-pattern')) ?? null
      );
    if (selector === 'circle')
      return this.children.find((child) => child.tagName === 'circle') ?? null;
    throw new Error(`Unexpected selector ${selector}`);
  }
  querySelectorAll(selector: string): Element[] {
    this.queries++;
    const descendants = this.children.flatMap((child) => [child, ...child.descendants()]);
    if (selector === '*') return descendants;
    if (selector.includes('data-layout-background'))
      return descendants.filter(
        (child) =>
          child.attributes.has('data-layout-background') ||
          child.attributes.has('data-layout-grid'),
      );
    if (selector.includes('data-annotation-overlay')) return [];
    throw new Error(`Unexpected selector ${selector}`);
  }
  descendants(): Element[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  cloneNode(): Element {
    const copy = new Element(this.tagName, Object.fromEntries(this.attributes));
    copy.style.values = new Map(this.style.values);
    copy.children = this.children.map((child) => child.cloneNode());
    return copy;
  }
}

function fixture(spacing = 0.5) {
  const root = new Element('svg'),
    pattern = new Element('pattern', {
      'data-layout-grid-pattern': '',
      'data-layout-grid-spacing': String(spacing),
    }),
    circle = new Element('circle'),
    background = new Element('rect', { 'data-layout-background': '' }),
    grid = new Element('rect', { 'data-layout-grid': '' });
  pattern.children = [circle];
  root.children = [pattern, background, grid];
  return { root, pattern, circle, background, grid, svg: root as unknown as SVGSVGElement };
}

test('display grids retain the smallest power-of-two snap multiple at least six pixels apart', () => {
  for (const selectedSpacing of [0.1, 0.2, 0.25, 0.5, 1]) {
    for (const unitsPerPixel of [0.001, 0.01, 0.03, 1 / 6, 0.5, 1, 4, 10]) {
      const metrics = layoutGridMetrics(selectedSpacing, unitsPerPixel);
      const multiple = metrics.spacing / selectedSpacing;
      assert.equal(Number.isInteger(Math.log2(multiple)), true);
      assert.ok(metrics.spacing / unitsPerPixel >= 6);
      if (multiple > 1) {
        assert.ok(metrics.spacing / 2 / unitsPerPixel < 6, 'No eligible grid interval is skipped.');
        assert.ok(metrics.radius / unitsPerPixel >= 0.5);
      } else {
        assert.equal(metrics.radius, Math.min(0.14, selectedSpacing * 0.08));
      }
      for (const viewport of [
        { width: 800, height: 600 },
        { width: 3840, height: 2160 },
      ]) {
        const columns = Math.ceil((viewport.width * unitsPerPixel) / metrics.spacing) + 1;
        const rows = Math.ceil((viewport.height * unitsPerPixel) / metrics.spacing) + 1;
        assert.ok(columns * rows <= (viewport.width / 6 + 2) * (viewport.height / 6 + 2));
      }
    }
  }
});

test('normal grid scale keeps its original dot radius and exact threshold interval', () => {
  assert.deepEqual(layoutGridMetrics(0.5, 1 / 12), { spacing: 0.5, radius: 0.04 });
  assert.deepEqual(layoutGridMetrics(0.5, 1 / 12 + 1e-12), {
    spacing: 1,
    radius: (1 / 12 + 1e-12) / 2,
  });
  for (const value of [0, -1, Infinity, NaN]) {
    assert.throws(() => layoutGridMetrics(value, 1), RangeError);
    assert.throws(() => layoutGridMetrics(1, value), RangeError);
  }
});

test('bound pattern keeps the zero origin, skips pan writes and repairs same-scale commit replay', () => {
  const { svg, root, pattern, circle } = fixture(0.25);
  const apply = createLayoutGridApplicator(svg);
  assert.equal(root.queries, 1);
  assert.equal(pattern.queries, 1);
  apply(1);
  assert.equal(pattern.getAttribute('width'), '8');
  assert.equal(pattern.getAttribute('height'), '8');
  assert.equal(Number(pattern.getAttribute('x')) + Number(circle.getAttribute('cx')), 0);
  assert.equal(Number(pattern.getAttribute('y')) + Number(circle.getAttribute('cy')), 0);
  assert.equal(circle.getAttribute('r'), '0.5');
  const writes = pattern.writes + circle.writes;
  for (let pan = 0; pan < 100; pan++) apply(1);
  assert.equal(pattern.writes + circle.writes, writes);
  assert.equal(root.queries, 1);
  assert.equal(pattern.queries, 1);
  pattern.setAttribute('width', '0.25');
  circle.setAttribute('cx', '0.125');
  apply(1);
  assert.equal(pattern.getAttribute('width'), '8');
  assert.equal(circle.getAttribute('cx'), '4');
  assert.equal(pattern.getAttribute('data-layout-grid-spacing'), '0.25');
});

test('patterns without grid metadata remain unchanged', () => {
  const root = new Element('svg');
  createLayoutGridApplicator(root as unknown as SVGSVGElement)(1);
  assert.equal(root.writes, 0);
  const { svg, pattern, circle } = fixture();
  pattern.removeAttribute('data-layout-grid-spacing');
  createLayoutGridApplicator(svg)(1);
  assert.equal(pattern.writes + circle.writes, 0);
});

test('Layout PNG and annotation clones recompute dots from their own bounded output scale', async () => {
  const { svg, root, pattern, circle, background, grid } = fixture();
  root.setAttribute('viewBox', '-900 -800 2000 1000');
  for (const frame of [background, grid])
    ['x', 'y', 'width', 'height'].forEach((name, index) =>
      frame.setAttribute(name, String([-1900, -1300, 4000, 2000][index])),
    );
  createLayoutGridApplicator(svg)(2);
  const source = [root, pattern, circle, background, grid].map((node) => [...node.attributes]);
  root.style.setProperty('outline-offset', '3px');
  root.style.setProperty('transform', 'matrix(1.12,0,0,1.12,25,-10)');
  root.style.setProperty('transform-origin', '0 0');
  root.style.setProperty('will-change', 'transform');
  root.setAttribute('data-layout-camera-view', '-900 -800 2000 1000');
  let cameraFlushes = 0;
  const unregisterCamera = registerLayoutCameraFlush(svg, () => {
    cameraFlushes++;
    for (const property of ['transform', 'transform-origin', 'will-change'])
      root.style.values.delete(property);
    root.removeAttribute('data-layout-camera-view');
  });
  const serialized: Element[] = [];
  let failRasterization = false;
  const globals = ['document', 'getComputedStyle', 'XMLSerializer', 'Image'] as const;
  const original = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/png;base64,test',
  });
  const replacements = {
    document: {
      createElement: () => canvas(),
      createElementNS: (_namespace: string, name: string) => new Element(name),
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    XMLSerializer: class {
      serializeToString(copy: Element) {
        serialized.push(copy);
        return '<svg/>';
      }
    },
    Image: class {
      onload?: () => void;
      onerror?: () => void;
      set src(_value: string) {
        queueMicrotask(() => (failRasterization ? this.onerror?.() : this.onload?.()));
      }
    },
  };
  try {
    for (const name of globals)
      Object.defineProperty(globalThis, name, { configurable: true, value: replacements[name] });
    const close = await captureLayoutPNG(svg, { minX: 0, minY: 0, maxX: 20, maxY: 10 });
    const far = await captureLayoutPNG(svg, { minX: 0, minY: 0, maxX: 1000, maxY: 400 });
    assert.equal(
      cameraFlushes,
      2,
      'Programmatic PNG captures flush the exact camera before cloning.',
    );
    for (const clone of serialized) {
      assert.equal(clone.getAttribute('data-layout-camera-view'), null);
      assert.equal(clone.style.values.has('transform'), false);
      assert.equal(clone.style.values.has('transform-origin'), false);
      assert.equal(clone.style.values.has('will-change'), false);
      assert.equal(
        clone.style.values.get('outline-offset'),
        '3px',
        'Unrelated root styles survive export.',
      );
    }
    assert.deepEqual([close.width, close.height], [400, 200]);
    assert.deepEqual([far.width, far.height], [4096, 1639]);
    const closePattern = serialized[0].querySelector('[data-layout-grid-pattern]')!;
    const farPattern = serialized[1].querySelector('[data-layout-grid-pattern]')!;
    assert.equal(closePattern.getAttribute('width'), '0.5');
    assert.equal(closePattern.querySelector('circle')!.getAttribute('r'), '0.04');
    assert.equal(farPattern.getAttribute('width'), '2');
    assert.equal(
      farPattern.querySelector('circle')!.getAttribute('r'),
      String((1000 / 4096) * 0.5),
    );
    // The annotation path is tested up to its serialized SVG, with no actual
    // browser rasterizer or invented PNG bytes required by the DOM stub.
    failRasterization = true;
    await assert.rejects(
      captureAnnotationImage(svg, [], { x: 5, y: 6, width: 8, height: 2 }),
      /Could not capture the drawing/,
    );
    await assert.rejects(
      captureAnnotationImage(svg, [], { x: 5, y: 6, width: 984, height: 384 }),
      /Could not capture the drawing/,
    );
    assert.equal(
      cameraFlushes,
      4,
      'Annotation captures with explicit bounds also flush before cloning.',
    );
    assert.equal(serialized[2].getAttribute('viewBox'), '-3 -2 24 18');
    assert.equal(serialized[2].getAttribute('width'), '288');
    assert.equal(serialized[2].getAttribute('height'), '216');
    assert.equal(serialized[3].getAttribute('viewBox'), '-3 -2 1000 400');
    assert.equal(serialized[3].getAttribute('width'), '1600');
    assert.equal(serialized[3].getAttribute('height'), '640');
    for (const copy of serialized.slice(2))
      for (const frame of copy.querySelectorAll('[data-layout-background], [data-layout-grid]'))
        assert.deepEqual(
          ['x', 'y', 'width', 'height'].map((name) => frame.getAttribute(name)),
          ['-900', '-800', '2000', '1000'],
          'A crop beyond the native viewport must not expose the retained reserve frames.',
        );
    const closeAnnotation = serialized[2].querySelector('[data-layout-grid-pattern]')!;
    const farAnnotation = serialized[3].querySelector('[data-layout-grid-pattern]')!;
    assert.equal(closeAnnotation.getAttribute('width'), '0.5');
    assert.equal(closeAnnotation.querySelector('circle')!.getAttribute('r'), '0.04');
    assert.equal(farAnnotation.getAttribute('width'), '4');
    assert.equal(farAnnotation.querySelector('circle')!.getAttribute('r'), '0.3125');
    assert.deepEqual(
      [root, pattern, circle, background, grid].map((node) => [...node.attributes]),
      source,
    );
    const schematic = fixture();
    schematic.root.setAttribute('viewBox', '0 0 100 75');
    schematic.pattern.removeAttribute('data-layout-grid-pattern');
    for (const frame of [schematic.background, schematic.grid]) {
      frame.removeAttribute('data-layout-background');
      frame.removeAttribute('data-layout-grid');
      for (const [name, value] of Object.entries({ x: 9, y: 10, width: 11, height: 12 }))
        frame.setAttribute(name, String(value));
    }
    await assert.rejects(
      captureAnnotationImage(schematic.svg, [], { x: 5, y: 6, width: 8, height: 2 }),
      /Could not capture the drawing/,
    );
    for (const frame of serialized[4].children
      .filter((node) => node.tagName === 'rect')
      .slice(0, 2))
      assert.deepEqual(
        ['x', 'y', 'width', 'height'].map((name) => frame.getAttribute(name)),
        ['9', '10', '11', '12'],
        'Schematic frames retain their original capture semantics.',
      );
  } finally {
    unregisterCamera();
    globals.forEach((name, index) => {
      if (original[index]) Object.defineProperty(globalThis, name, original[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
