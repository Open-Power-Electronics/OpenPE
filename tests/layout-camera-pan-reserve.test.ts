import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLayoutCameraApplicator, type LayoutView } from '../components/LayoutCamera';
import { flushLayoutCamera } from '../lib/layout-camera-presentation';

class Style {
  values = new Map<string, { value: string; priority: string }>();
  get length() {
    return this.values.size;
  }
  getPropertyValue(name: string) {
    return this.values.get(name)?.value ?? '';
  }
  getPropertyPriority(name: string) {
    return this.values.get(name)?.priority ?? '';
  }
  setProperty(name: string, value: string, priority = '') {
    this.values.set(name, { value, priority });
  }
  removeProperty(name: string) {
    this.values.delete(name);
  }
}

class Matrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
  readonly is2D = true;
  constructor(value?: string) {
    const values = value
      ? /^matrix\(([^)]+)\)$/.exec(value)?.[1].split(',').map(Number)
      : [1, 0, 0, 1, 0, 0];
    assert.ok(values?.length === 6 && values.every(Number.isFinite));
    [this.a, this.b, this.c, this.d, this.e, this.f] = values;
  }
}

type Write = { node: Node; name: string; value: string | null };
class Node {
  attributes = new Map<string, string>();
  style = new Style();
  dataset: Record<string, string> = {};
  parentElement: Node | null = null;
  nativeOverflow = 'visible';
  bounds = { width: 800, height: 500 };
  children: Node[] = [];
  constructor(readonly log: Write[]) {}
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return name === 'style' ? this.style.length > 0 : this.attributes.has(name);
  }
  setAttribute(name: string, value: string) {
    this.log.push({ node: this, name, value: String(value) });
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string) {
    this.log.push({ node: this, name, value: null });
    this.attributes.delete(name);
  }
  getBoundingClientRect() {
    return this.bounds;
  }
  computedStyleMap() {
    return new Map(
      [
        'transform',
        'translate',
        'rotate',
        'scale',
        'perspective',
        'zoom',
        'overflow-x',
        'overflow-y',
      ].map((name) => [
        name,
        this.style.getPropertyValue(name) ||
          (name === 'zoom' ? '1' : name.startsWith('overflow-') ? this.nativeOverflow : 'none'),
      ]),
    );
  }
  querySelector(_selector?: string): Node | null {
    return null;
  }
  querySelectorAll(_selector?: string): Node[] {
    return this.children;
  }
  matches(selector: string) {
    return (
      selector.includes('data-layout-track-target') && this.hasAttribute('data-layout-track-target')
    );
  }
  closest(_selector: string) {
    return null;
  }
}

function scene() {
  const log: Write[] = [],
    host = new Node(log),
    svg = new Node(log);
  svg.parentElement = host;
  svg.nativeOverflow = 'hidden';
  const frames = [new Node(log), new Node(log), new Node(log)];
  const pattern = new Node(log),
    circle = new Node(log),
    track = new Node(log),
    artwork = new Node(log);
  pattern.attributes.set('data-layout-grid-spacing', '0.5');
  pattern.querySelector = () => circle;
  track.attributes.set('data-layout-track-target', '0.4');
  track.dataset.layoutTrackTarget = '0.4';
  artwork.attributes.set('d', 'M 1 2 L 3 4');
  svg.querySelector = () => pattern;
  svg.querySelectorAll = (selector = '') => {
    if (selector.includes('data-layout-background')) return frames;
    if (selector.includes('data-layout-track-target')) return [track];
    if (selector.includes('vector-effect')) return [track];
    return [];
  };
  const frameValues = () => frames.map((node) => Object.fromEntries(node.attributes));
  const fixedValues = () => [pattern, circle, track, artwork].map((node) => [...node.attributes]);
  return {
    svg: svg as unknown as SVGSVGElement,
    root: svg,
    host,
    frames,
    log,
    frameValues,
    fixedValues,
  };
}

const size = { width: 800, height: 500 };
const initial = { x: 0, y: 0, width: 80 };
const exact = (view: LayoutView, dimensions = size) => ({
  x: String(view.x),
  y: String(view.y),
  width: String(view.width),
  height: String(view.width / (dimensions.width / dimensions.height)),
});
const reserve = (view: LayoutView, dimensions = size) =>
  exact(
    {
      x: view.x - view.width / 2,
      y: view.y - view.width / (dimensions.width / dimensions.height) / 2,
      width: view.width * 2,
    },
    dimensions,
  );
const assertFrames = (current: ReturnType<typeof scene>, values: ReturnType<typeof exact>) =>
  assert.deepEqual(current.frameValues(), [values, values, values]);

function environment(
  run: (clock: {
    next: () => void;
    timers: Map<number, () => void>;
    callbacks: Map<number, FrameRequestCallback>;
  }) => void,
) {
  const names = [
    'getComputedStyle',
    'DOMMatrixReadOnly',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setTimeout',
    'clearTimeout',
  ] as const;
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const pending = new Map<number, FrameRequestCallback>(),
    callbacks = new Map<number, FrameRequestCallback>(),
    timers = new Map<number, () => void>();
  let id = 0;
  const replacements = [
    (node: Node) => ({
      getPropertyValue: (name: string) => node.computedStyleMap().get(name) ?? '',
    }),
    Matrix,
    (callback: FrameRequestCallback) => {
      pending.set(++id, callback);
      callbacks.set(id, callback);
      return id;
    },
    (key: number) => pending.delete(key),
    (callback: () => void, delay: number) => {
      assert.equal(delay, 120);
      timers.set(++id, callback);
      return id;
    },
    (key: number) => timers.delete(key),
  ];
  names.forEach((name, index) =>
    Object.defineProperty(globalThis, name, { configurable: true, value: replacements[index] }),
  );
  try {
    run({
      timers,
      callbacks,
      next() {
        const entry = pending.entries().next().value;
        assert.ok(entry);
        pending.delete(entry[0]);
        entry[1](0);
      },
    });
  } finally {
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

test('translation defers stroke traversal and unchanged zoom scale retains compensation until native replay', () =>
  environment(() => {
    const current = scene();
    const stroke = new Node(current.log);
    stroke.attributes.set('vector-effect', 'non-scaling-stroke');
    stroke.attributes.set('stroke-width', '1.5');
    stroke.attributes.set('stroke-dasharray', '3, 4');
    stroke.attributes.set('stroke-dashoffset', '0.5');
    const query = current.root.querySelectorAll.bind(current.root);
    let scans = 0,
      reads = 0;
    current.root.querySelectorAll = (selector = '') => {
      if (selector.includes('vector-effect')) {
        scans++;
        return [stroke];
      }
      return query(selector);
    };
    const read = stroke.getAttribute.bind(stroke);
    stroke.getAttribute = (name) => {
      reads++;
      return read(name);
    };
    const apply = createLayoutCameraApplicator(current.svg, {
      fixedTargets: true,
      compositor: true,
      frameReserve: true,
    });
    apply(initial, size);
    const pan = apply.beginPan();
    for (let x = 1; x < 20; x++) pan.update(() => apply({ ...initial, x }, size, false));
    assert.equal(scans, 0, 'A pure pan never queries the board for visible strokes.');
    assert.equal(reads, 0);
    apply({ x: 19, y: 0, width: 64 }, size, false);
    assert.equal(scans, 1, 'Zoom after pan captures the current stroke tree once.');
    assert.equal(read('stroke-width'), '1.2');
    assert.equal(read('stroke-dasharray'), '2.4 3.2');
    assert.equal(read('stroke-dashoffset'), '0.4');
    const afterZoom = reads;
    for (let x = 20; x < 30; x++) apply({ x, y: 0, width: 64 }, size, false);
    assert.equal(scans, 1);
    assert.equal(reads, afterZoom, 'Translation at a zoomed scale does no per-stroke work.');
    apply({ x: 29, y: 0, width: 80 }, size, false);
    assert.equal(read('stroke-width'), '1.5');
    pan.release();
    assert.equal(
      read('stroke-dasharray'),
      '3, 4',
      'Native rebase restores exact authored attributes.',
    );
    stroke.attributes.set('stroke-width', '2.5');
    apply({ x: 29, y: 0, width: 64 }, size, false);
    assert.equal(scans, 2, 'The next promotion captures any committed drawing changes.');
    assert.equal(read('stroke-width'), '2');
    apply.dispose();
    assert.equal(read('stroke-width'), '2.5');
  }));

test('unsupported stroke metrics discovered after a pan restore native clipping and remain retryable', () =>
  environment(() => {
    const current = scene();
    const stroke = new Node(current.log);
    stroke.attributes.set('stroke-width', 'calc(1px + 1px)');
    const query = current.root.querySelectorAll.bind(current.root);
    current.root.querySelectorAll = (selector = '') =>
      selector.includes('vector-effect') ? [stroke] : query(selector);
    const apply = createLayoutCameraApplicator(current.svg, { compositor: true });
    apply(initial, size);
    apply({ ...initial, x: 2 }, size, false);
    assert.ok(current.root.style.getPropertyValue('transform'));
    apply({ x: 2, y: 0, width: 64 }, size, false);
    assert.equal(current.root.getAttribute('viewBox'), '2 0 64 40');
    assert.equal(current.root.style.getPropertyValue('transform'), '');
    assert.equal(current.root.style.getPropertyValue('overflow-x'), '');
    assert.equal(current.host.style.getPropertyValue('overflow-x'), '');
    assert.equal(stroke.getAttribute('stroke-width'), 'calc(1px + 1px)');
    stroke.attributes.set('stroke-width', '2');
    apply({ x: 2, y: 0, width: 51.2 }, size, false);
    assert.equal(stroke.getAttribute('stroke-width'), '1.6');
    apply.dispose();
    assert.equal(stroke.getAttribute('stroke-width'), '2');
  }));

test('pan reserve is opt-in and keeps finite frames, grid, artwork and seven-pixel hits unchanged during contained translation', () =>
  environment((clock) => {
    for (const enabled of [false, true]) {
      const current = scene();
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: true,
        fixedTargets: true,
        panFrameReserve: enabled,
      });
      apply(initial, size);
      const fixed = current.fixedValues();
      const pan = apply.beginPan();
      assertFrames(current, enabled ? reserve(initial) : exact(initial));
      current.log.length = 0;
      for (const view of [
        { x: 6.125, y: -4.5, width: 80 },
        { x: -39.5, y: 24.5, width: 80 },
      ]) {
        pan.update(() => apply(view, size, false));
        assertFrames(current, enabled ? reserve(initial) : exact(view));
        const m = new Matrix(current.root.style.getPropertyValue('transform'));
        // Native world coordinates followed by the CSS matrix retain the exact camera.
        assert.equal(m.a, 1);
        assert.equal(m.e, -view.x * 10);
        assert.equal(m.f, -view.y * 10);
      }
      if (enabled)
        assert.equal(current.log.filter((entry) => current.frames.includes(entry.node)).length, 0);
      assert.deepEqual(current.fixedValues(), fixed);
      assert.equal(clock.timers.size, 0);
      pan.release();
      assertFrames(current, exact({ x: -39.5, y: 24.5, width: 80 }));
      apply.dispose();
    }
  }));

test('crossing any reserve edge rebases the exact pose before preparing a new two-viewport reserve', () =>
  environment(() => {
    for (const view of [
      { x: -40.000001, y: 0, width: 80 },
      { x: 40.000001, y: 0, width: 80 },
      { x: 0, y: -25.000001, width: 80 },
      { x: 0, y: 25.000001, width: 80 },
      { x: 10000, y: -10000, width: 80 },
    ]) {
      const current = scene();
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: true,
        panFrameReserve: true,
      });
      apply(initial, size);
      const pan = apply.beginPan();
      pan.update(() => apply({ x: 40, y: 25, width: 80 }, size, false));
      assert.equal(current.root.getAttribute('viewBox'), '0 0 80 50');
      assertFrames(current, reserve(initial));
      current.log.length = 0;
      pan.update(() => apply(view, size, false));
      assert.equal(current.root.getAttribute('viewBox'), `${view.x} ${view.y} 80 50`);
      assert.equal(current.root.hasAttribute('data-layout-camera-view'), false);
      assertFrames(current, reserve(view));
      const nativeWrite = current.log.findIndex(
        (entry) => entry.node === current.root && entry.name === 'viewBox',
      );
      const frameWrite = current.log.findIndex((entry) => current.frames.includes(entry.node));
      assert.ok(nativeWrite >= 0 && frameWrite > nativeWrite);
      pan.release();
      assertFrames(current, exact(view));
      apply.dispose();
    }
  }));

test('flush, release, refresh and disposal restore exact native frames even before a CSS matrix exists', () =>
  environment(() => {
    for (const finish of ['capture', 'release', 'refresh', 'dispose'] as const) {
      const current = scene();
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: true,
        panFrameReserve: true,
      });
      apply(initial, size);
      const pan = apply.beginPan();
      pan.update(() => apply(initial, size, false));
      assertFrames(current, reserve(initial));
      assert.equal(current.root.hasAttribute('data-layout-camera-view'), false);
      if (finish === 'capture') flushLayoutCamera(current.svg);
      else if (finish === 'release') pan.release();
      else if (finish === 'refresh') apply.refreshTracks();
      else apply.dispose();
      assertFrames(current, exact(initial));
      apply.dispose();
    }
  }));

test('drawing replay repairs actual frame attributes and invalidates reserve before a later pan', () =>
  environment(() => {
    const current = scene();
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      panFrameReserve: true,
    });
    apply(initial, size);
    const pan = apply.beginPan();
    current.frames[0].setAttribute('width', '0');
    pan.update(() => apply(initial, size, false));
    assertFrames(current, reserve(initial));
    apply.applyNow(initial, size, false);
    assertFrames(current, exact(initial));
    const view = { x: 3.5, y: -4.25, width: 80 };
    pan.update(() => apply(view, size, false));
    assertFrames(current, exact(view));
    pan.release();
    apply.dispose();
  }));

test('queued latest ordinary navigation and scale-changing pan retain normal idle rebasing and exact frames', () =>
  environment((clock) => {
    for (const latestPan of [false, true]) {
      const current = scene();
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: true,
        frameScheduled: true,
        panFrameReserve: true,
      });
      apply(initial, size);
      const pan = apply.beginPan();
      pan.update(() => apply({ x: 2, y: 3, width: 80 }, size, false));
      const wheel = { x: 3, y: 4, width: 70 };
      if (latestPan) pan.update(() => apply(wheel, size));
      else apply(wheel, size);
      clock.next();
      assertFrames(current, exact(wheel));
      assert.equal(clock.timers.size, 1);
      const idle = clock.timers.values().next().value!;
      clock.timers.clear();
      idle();
      assert.equal(current.root.getAttribute('viewBox'), '3 4 70 43.75');
      assert.equal(current.root.hasAttribute('data-layout-camera-view'), false);
      pan.release();
      apply.dispose();
    }
  }));

test('explicit flush consumes the queued final pan and a resized viewport drops the old reserve', () =>
  environment((clock) => {
    const current = scene();
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameScheduled: true,
      panFrameReserve: true,
    });
    apply(initial, size);
    const pan = apply.beginPan();
    const last = { x: 8.123456789, y: -9.987654321, width: 80 };
    pan.update(() => apply(last, size, false));
    flushLayoutCamera(current.svg);
    assert.equal(current.root.getAttribute('viewBox'), `${last.x} ${last.y} 80 50`);
    assertFrames(current, exact(last));
    const stale = [...clock.callbacks.values()][0];
    const nextPan = apply.beginPan();
    current.root.bounds = { width: 900, height: 600 };
    const resized = { x: 1, y: 2, width: 90 },
      nextSize = { width: 900, height: 600 };
    nextPan.update(() => apply(resized, nextSize));
    stale(0);
    assert.equal(current.root.getAttribute('viewBox'), '1 2 90 60');
    assertFrames(current, exact(resized, nextSize));
    assert.equal(current.root.hasAttribute('data-layout-camera-view'), false);
    pan.release();
    nextPan.release();
    apply.dispose();
  }));

test('foreign ancestor transforms preserve their priority and force exact native frames', () =>
  environment(() => {
    const current = scene();
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      fixedTargets: true,
      panFrameReserve: true,
    });
    apply(initial, size);
    const pan = apply.beginPan();
    pan.update(() => apply({ x: 2, y: 3, width: 80 }, size, false));
    current.host.style.setProperty('transform', 'rotate(3deg)', 'important');
    const view = { x: 7, y: 8, width: 80 };
    pan.update(() => apply(view, size));
    assertFrames(current, exact(view));
    assert.equal(current.root.getAttribute('viewBox'), '7 8 80 50');
    assert.equal(current.root.hasAttribute('data-layout-camera-view'), false);
    assert.equal(current.host.style.getPropertyValue('transform'), 'rotate(3deg)');
    assert.equal(current.host.style.getPropertyPriority('transform'), 'important');
    assert.equal(current.root.style.getPropertyValue('transform'), '');
    pan.release();
    apply.dispose();
  }));

test('visible native overflow, missing compositor and changed live size cannot prepare a reserve', () =>
  environment(() => {
    for (const mode of [
      'visible',
      'one-axis-visible',
      'no-compositor',
      'changed-size',
      'unrepresentable',
    ] as const) {
      const current = scene();
      if (mode === 'visible') current.root.nativeOverflow = 'visible';
      if (mode === 'one-axis-visible')
        current.root.style.setProperty('overflow-x', 'visible', 'important');
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: mode !== 'no-compositor',
        panFrameReserve: true,
      });
      const view = mode === 'unrepresentable' ? { x: 1e308, y: 1e308, width: 80 } : initial;
      apply(view, size);
      if (mode === 'changed-size') current.root.bounds = { width: 900, height: 500 };
      const before = current.frameValues();
      const pan = apply.beginPan();
      assert.deepEqual(current.frameValues(), before);
      assert.equal(current.host.style.getPropertyValue('overflow-x'), '');
      assert.equal(current.host.style.getPropertyValue('overflow-y'), '');
      if (mode === 'one-axis-visible')
        assert.equal(current.root.style.getPropertyPriority('overflow-x'), 'important');
      pan.release();
      apply.dispose();
    }
  }));

test('replacement retires the old reserve before new bounds reads and old queued callbacks cannot touch the next owner', () =>
  environment((clock) => {
    const current = scene();
    const old = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameScheduled: true,
      panFrameReserve: true,
    });
    old(initial, size);
    const pan = old.beginPan();
    const displayed = { x: 3, y: 4, width: 80 };
    pan.update(() => old(displayed, size, false));
    clock.next();
    pan.update(() => old({ x: 10, y: 11, width: 80 }, size, false));
    const stale = [...clock.callbacks.values()];
    current.root.getBoundingClientRect = () => {
      assertFrames(current, exact(displayed));
      return size;
    };
    const next = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      panFrameReserve: true,
    });
    current.root.getBoundingClientRect = () => size;
    const newest = { x: -9, y: -8, width: 100 };
    next(newest, size);
    const snapshot = current.frameValues();
    old.dispose();
    old.flush();
    pan.release();
    pan.update(() => old({ x: -999, y: -999, width: 8 }, size));
    stale.forEach((callback) => callback(0));
    assert.deepEqual(current.frameValues(), snapshot);
    assert.equal(current.root.getAttribute('viewBox'), '-9 -8 100 62.5');
    next.dispose();
  }));

test('retained frame reserve is prepared by the committed binding and survives native flush, idle and pan release', () =>
  environment((clock) => {
    const current = scene();
    let measurements = 0;
    current.root.getBoundingClientRect = () => {
      measurements++;
      return size;
    };
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      fixedTargets: true,
      panFrameReserve: true,
      frameReserve: true,
    });
    apply(initial, size);
    assert.equal(measurements, 1, 'initial preparation reuses the committed viewport measurement');
    assertFrames(current, reserve(initial));
    const fixed = current.fixedValues();
    const pan = apply.beginPan();
    current.log.length = 0;
    const translated = { x: 3, y: -4, width: 80 };
    pan.update(() => apply(translated, size, false));
    assertFrames(current, reserve(initial));
    assert.equal(current.log.filter((entry) => current.frames.includes(entry.node)).length, 0);
    pan.release();
    assert.equal(current.root.getAttribute('viewBox'), '3 -4 80 50');
    assert.equal(current.root.style.getPropertyValue('transform'), '');
    assertFrames(current, reserve(initial));
    assert.deepEqual(current.fixedValues(), fixed);
    const zoomed = { x: 8, y: 2, width: 70 };
    apply(zoomed, size);
    assert.equal(clock.timers.size, 1);
    const idle = clock.timers.values().next().value!;
    clock.timers.clear();
    idle();
    assert.equal(current.root.getAttribute('viewBox'), '8 2 70 43.75');
    assert.equal(current.root.hasAttribute('data-layout-camera-view'), false);
    assertFrames(current, reserve(initial));
    flushLayoutCamera(current.svg);
    assertFrames(current, reserve(initial));
    const control = scene();
    const native = createLayoutCameraApplicator(control.svg, { fixedTargets: true });
    native(zoomed, size);
    assert.deepEqual(current.fixedValues(), control.fixedValues());
    native.dispose();
    apply.dispose();
    assertFrames(current, exact(zoomed));
  }));

test('retained covers stay finite and at most four native/current viewports before any CSS matrix is exposed', () =>
  environment(() => {
    const current = scene();
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameReserve: true,
    });
    let desired = { x: 0, y: 0, width: 2000 };
    const assertCover = () => {
      const frame = current.frames[0];
      const cover = ['x', 'y', 'width', 'height'].map((name) => Number(frame.getAttribute(name)));
      const native = current.root.getAttribute('viewBox')!.split(' ').map(Number);
      assert.ok([...cover, cover[0] + cover[2], cover[1] + cover[3]].every(Number.isFinite));
      for (const view of [native, [desired.x, desired.y, desired.width, desired.width / 1.6]]) {
        assert.ok(cover[0] <= view[0] && cover[1] <= view[1]);
        assert.ok(cover[0] + cover[2] >= view[0] + view[2]);
        assert.ok(cover[1] + cover[3] >= view[1] + view[3]);
        assert.ok(cover[2] <= view[2] * 4 && cover[3] <= view[3] * 4);
      }
    };
    apply(desired, size);
    const setStyle = current.root.style.setProperty.bind(current.root.style);
    current.root.style.setProperty = (name, value, priority) => {
      if (name === 'transform' || name.startsWith('overflow-')) assertCover();
      setStyle(name, value, priority);
    };
    for (const width of [1800, 1400, 1000, 800, 450, 200, 80, 40, 16, 8, 20, 80, 500, 2000]) {
      desired = { x: (2000 - width) / 2, y: (1250 - width / 1.6) / 2, width };
      apply(desired, size);
      assertCover();
      flushLayoutCamera(current.svg);
      assert.equal(
        current.root.getAttribute('viewBox'),
        `${desired.x} ${desired.y} ${width} ${width / 1.6}`,
      );
      assertCover();
    }
    // Disposal restores exact frames rather than retaining a historical extent.
    apply.dispose();
    assertFrames(current, exact(desired));
  }));

test('coverage loss rebases before recentering the retained finite cover', () =>
  environment(() => {
    const current = scene();
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameReserve: true,
    });
    apply(initial, size);
    apply({ x: 40, y: 25, width: 80 }, size, false);
    assertFrames(current, reserve(initial));
    current.log.length = 0;
    const outside = { x: 40.000001, y: 25, width: 80 };
    apply(outside, size, false);
    assert.equal(current.root.getAttribute('viewBox'), `${outside.x} 25 80 50`);
    assert.equal(current.root.style.getPropertyValue('transform'), '');
    assertFrames(current, reserve(outside));
    const nativeWrite = current.log.findIndex(
      (entry) => entry.node === current.root && entry.name === 'viewBox',
    );
    const frameWrite = current.log.findIndex((entry) => current.frames.includes(entry.node));
    assert.ok(nativeWrite >= 0 && frameWrite > nativeWrite);
    apply.dispose();
  }));

test('drawing replays and captures repair actual reserve attributes without changing the native camera or other bindings', () =>
  environment(() => {
    const current = scene();
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      fixedTargets: true,
      frameReserve: true,
    });
    apply(initial, size);
    const fixed = current.fixedValues();
    for (const repair of [
      () => apply.applyNow(initial, size, false),
      () => flushLayoutCamera(current.svg),
    ]) {
      current.frames[0].setAttribute('width', '0');
      current.frames[1].setAttribute('x', '999');
      repair();
      assertFrames(current, reserve(initial));
      assert.equal(current.root.getAttribute('viewBox'), '0 0 80 50');
      assert.deepEqual(current.fixedValues(), fixed);
    }
    current.root.setAttribute('viewBox', '99 99 1 1');
    apply.applyNow(initial, size, false);
    assert.equal(current.root.getAttribute('viewBox'), '0 0 80 50');
    assertFrames(current, reserve(initial));
    apply.refreshTracks();
    assertFrames(current, reserve(initial));
    assert.deepEqual(current.fixedValues(), fixed);
    apply.dispose();
  }));

test('physical resize before apply is noticed by public flush, idle and native drawing replay', () =>
  environment((clock) => {
    for (const finish of ['flush', 'idle', 'replay'] as const) {
      const current = scene();
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: true,
        frameReserve: true,
      });
      apply(initial, size);
      const view = finish === 'idle' ? { x: 1, y: 2, width: 70 } : initial;
      if (finish === 'idle') apply(view, size);
      current.root.bounds = { width: 850, height: 500 };
      if (finish === 'flush') flushLayoutCamera(current.svg);
      else if (finish === 'replay') apply.applyNow(view, size, false);
      else {
        const idle = clock.timers.values().next().value!;
        clock.timers.clear();
        idle();
      }
      assert.equal(
        current.root.getAttribute('viewBox'),
        `${view.x} ${view.y} ${view.width} ${view.width / 1.6}`,
      );
      assertFrames(current, exact(view));
      const resized = { width: 850, height: 500 };
      apply(view, resized);
      assertFrames(current, exact(view, resized));
      assert.equal(current.root.style.getPropertyValue('transform'), '');
      apply.dispose();
    }
  }));

test('retained covers require native clipping and preserve foreign transform and clipping priorities', () =>
  environment(() => {
    for (const change of ['ancestor', 'native-clip', 'transient-clip'] as const) {
      const current = scene();
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: true,
        frameReserve: true,
      });
      apply(initial, size);
      const view = { x: 1, y: 2, width: 70 };
      if (change === 'transient-clip') apply(view, size);
      if (change === 'ancestor')
        current.host.style.setProperty('transform', 'rotate(3deg)', 'important');
      else current.root.style.setProperty('overflow-x', 'visible', 'important');
      flushLayoutCamera(current.svg);
      assertFrames(current, exact(change === 'transient-clip' ? view : initial));
      if (change === 'ancestor') {
        assert.equal(current.host.style.getPropertyValue('transform'), 'rotate(3deg)');
        assert.equal(current.host.style.getPropertyPriority('transform'), 'important');
      } else {
        assert.equal(current.root.style.getPropertyValue('overflow-x'), 'visible');
        assert.equal(current.root.style.getPropertyPriority('overflow-x'), 'important');
      }
      apply.dispose();
    }
  }));

test('retained reserve replacement restores exact presented frames before the successor reads them and cancels stale work', () =>
  environment((clock) => {
    const current = scene();
    const old = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameScheduled: true,
      frameReserve: true,
    });
    old(initial, size);
    const shown = { x: 1, y: 2, width: 70 };
    old(shown, size);
    clock.next();
    const staleIdle = [...clock.timers.values()];
    old({ x: 10, y: 20, width: 60 }, size);
    const staleFrames = [...clock.callbacks.values()];
    let initialRead = true;
    current.root.getBoundingClientRect = () => {
      if (initialRead) assertFrames(current, exact(shown));
      return size;
    };
    // Retiring cleanup may measure the old native cover; the successor's
    // measurement must only happen after old owned presentation is restored.
    const next = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameReserve: true,
    });
    initialRead = false;
    const newest = { x: -8, y: -4, width: 100 };
    next(newest, size);
    const snapshot = current.frameValues();
    old.dispose();
    staleFrames.forEach((callback) => callback(0));
    staleIdle.forEach((callback) => callback());
    assert.deepEqual(current.frameValues(), snapshot);
    assert.equal(current.root.getAttribute('viewBox'), '-8 -4 100 62.5');
    next.dispose();
    assertFrames(current, exact(newest));
  }));

test('retained reserve stays disabled for visible native overflow, missing compositor and unrepresentable extents', () =>
  environment(() => {
    for (const mode of ['visible', 'no-compositor', 'unrepresentable'] as const) {
      const current = scene();
      if (mode === 'visible') current.root.nativeOverflow = 'visible';
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: mode !== 'no-compositor',
        frameReserve: true,
      });
      const view = mode === 'unrepresentable' ? { x: 1e308, y: 1e308, width: 80 } : initial;
      apply(view, size);
      assertFrames(current, exact(view));
      flushLayoutCamera(current.svg);
      assertFrames(current, exact(view));
      apply.dispose();
    }
  }));

test('release, capture and idle measure a verified owned viewport before native writes and reuse that measurement', () =>
  environment((clock) => {
    for (const width of [80, 70])
      for (const finish of ['release', 'capture', 'idle'] as const) {
        const current = scene();
        const reads: { transform: string; native: string | null; writes: number }[] = [];
        current.root.getBoundingClientRect = () => {
          const transform = current.root.style.getPropertyValue('transform');
          reads.push({
            transform,
            native: current.root.getAttribute('viewBox'),
            writes: current.log.length,
          });
          const scale = transform ? new Matrix(transform).a : 1;
          return { width: size.width * scale, height: size.height * scale };
        };
        const apply = createLayoutCameraApplicator(current.svg, {
          compositor: true,
          fixedTargets: true,
          frameReserve: true,
        });
        apply(initial, size);
        const pan = finish === 'release' ? apply.beginPan() : null;
        const view = { x: 3, y: 2, width };
        if (pan) pan.update(() => apply(view, size));
        else apply(view, size);
        assert.ok(current.root.style.getPropertyValue('transform'));
        reads.length = 0;
        current.log.length = 0;
        if (pan) pan.release();
        else if (finish === 'capture') flushLayoutCamera(current.svg);
        else {
          const idle = clock.timers.values().next().value!;
          clock.timers.clear();
          idle();
        }
        assert.equal(reads.length, 1);
        assert.ok(
          reads[0].transform,
          'the physical viewport is read while the owned matrix remains applied',
        );
        assert.equal(reads[0].native, '0 0 80 50');
        assert.equal(reads[0].writes, 0, 'native camera and frame writes follow the measurement');
        assert.equal(current.root.getAttribute('viewBox'), `3 2 ${width} ${width / 1.6}`);
        assert.equal(current.root.style.getPropertyValue('transform'), '');
        assert.equal(current.root.hasAttribute('data-layout-camera-view'), false);
        assertFrames(current, reserve(initial));
        assert.equal(current.fixedValues()[2].find(([name]) => name === 'stroke-width')?.[1], '7');
        apply.dispose();
      }
  }));

test('uncertain scaled rounding and a physical resize retain the exact original settled viewport check', () =>
  environment(() => {
    for (const resized of [false, true]) {
      const current = scene();
      const reads: string[] = [];
      current.root.getBoundingClientRect = () => {
        const transform = current.root.style.getPropertyValue('transform');
        reads.push(transform);
        const scale = transform ? new Matrix(transform).a : 1;
        return {
          width: current.root.bounds.width * scale + (transform && !resized ? 0.00001 : 0),
          height: current.root.bounds.height * scale,
        };
      };
      const apply = createLayoutCameraApplicator(current.svg, {
        compositor: true,
        frameReserve: true,
      });
      apply(initial, size);
      const view = { x: 1, y: 2, width: 70 };
      apply(view, size);
      if (resized) current.root.bounds = { width: 850, height: 500 };
      reads.length = 0;
      flushLayoutCamera(current.svg);
      assert.equal(
        reads.length,
        2,
        'uncertain transformed bounds must not replace the native check',
      );
      assert.ok(reads[0]);
      assert.equal(reads[1], '');
      assert.equal(current.root.getAttribute('viewBox'), '1 2 70 43.75');
      assertFrames(current, resized ? exact(view) : reserve(initial));
      apply.dispose();
    }
  }));

test('a premeasured viewport does not bypass restored native clipping', () =>
  environment(() => {
    const current = scene();
    let reads = 0;
    current.root.getBoundingClientRect = () => {
      reads++;
      const transform = current.root.style.getPropertyValue('transform');
      const scale = transform ? new Matrix(transform).a : 1;
      return { width: size.width * scale, height: size.height * scale };
    };
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameReserve: true,
    });
    apply(initial, size);
    const view = { x: 1, y: 2, width: 70 };
    apply(view, size);
    current.root.nativeOverflow = 'visible';
    reads = 0;
    flushLayoutCamera(current.svg);
    assert.equal(reads, 1);
    assert.equal(current.root.style.getPropertyValue('overflow-x'), '');
    assert.equal(current.root.style.getPropertyValue('overflow-y'), '');
    assertFrames(current, exact(view));
    apply.dispose();
  }));

test('foreign same-value important transforms are never treated as a reusable owned viewport', () =>
  environment(() => {
    const current = scene();
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameReserve: true,
    });
    apply(initial, size);
    const view = { x: 1, y: 2, width: 70 };
    apply(view, size);
    const foreign = current.root.style.getPropertyValue('transform');
    current.root.style.setProperty('transform', foreign, 'important');
    current.root.getBoundingClientRect = () => {
      throw new Error('A foreign transform must not be inverted as an owned scale.');
    };
    flushLayoutCamera(current.svg);
    assert.equal(current.root.style.getPropertyValue('transform'), foreign);
    assert.equal(current.root.style.getPropertyPriority('transform'), 'important');
    assert.equal(current.root.getAttribute('viewBox'), '1 2 70 43.75');
    assertFrames(current, exact(view));
    apply.dispose();
  }));

test('failed pre-native viewport reads block capture without changing the displayed pose and remain retryable', () =>
  environment(() => {
    const current = scene();
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameReserve: true,
    });
    apply(initial, size);
    const view = { x: 3, y: 2, width: 80 };
    apply(view, size);
    const transform = current.root.style.getPropertyValue('transform');
    current.root.getBoundingClientRect = () => {
      throw new Error('viewport unavailable');
    };
    assert.throws(() => flushLayoutCamera(current.svg), /viewport unavailable/);
    assert.equal(current.root.getAttribute('viewBox'), '0 0 80 50');
    assert.equal(current.root.style.getPropertyValue('transform'), transform);
    assertFrames(current, reserve(initial));
    current.root.getBoundingClientRect = () => size;
    flushLayoutCamera(current.svg);
    assert.equal(current.root.getAttribute('viewBox'), '3 2 80 50');
    assert.equal(current.root.style.getPropertyValue('transform'), '');
    assertFrames(current, reserve(initial));
    apply.dispose();
  }));

test('flushing a just-consumed queued pose keeps the native check without measuring its fresh CSS matrix', () =>
  environment((clock) => {
    const current = scene();
    const reads: string[] = [];
    current.root.getBoundingClientRect = () => {
      const transform = current.root.style.getPropertyValue('transform');
      reads.push(transform);
      const scale = transform ? new Matrix(transform).a : 1;
      return { width: size.width * scale, height: size.height * scale };
    };
    const apply = createLayoutCameraApplicator(current.svg, {
      compositor: true,
      frameScheduled: true,
      frameReserve: true,
    });
    apply(initial, size);
    const view = { x: 1, y: 2, width: 70 };
    apply(view, size);
    const stale = [...clock.callbacks.values()];
    reads.length = 0;
    flushLayoutCamera(current.svg);
    assert.deepEqual(
      reads,
      ['', ''],
      'pending presentation is measured only before matrix creation and after native settle',
    );
    assert.equal(current.root.getAttribute('viewBox'), '1 2 70 43.75');
    assert.equal(current.root.style.getPropertyValue('transform'), '');
    assertFrames(current, reserve(initial));
    stale.forEach((callback) => callback(0));
    assert.equal(current.root.getAttribute('viewBox'), '1 2 70 43.75');
    apply.dispose();
  }));
