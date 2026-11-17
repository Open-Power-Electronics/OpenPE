import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyLayoutCamera,
  createLayoutCamera,
  createLayoutCameraApplicator,
  layoutZoomWidth,
  zoomLayoutView,
} from '../components/LayoutCamera';
import { flushLayoutCamera } from '../lib/layout-camera-presentation';

class Node {
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  children: Node[] = [];
  queries = 0;
  writes = 0;
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.writes++;
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.writes++;
    this.attributes.delete(name);
  }
  querySelector(_selector?: string): Node | null {
    this.queries++;
    return null;
  }
  querySelectorAll() {
    this.queries++;
    return this.children;
  }
}
function fixture() {
  const svg = new Node();
  const frames = [new Node(), new Node(), new Node()];
  const track = new Node(),
    via = new Node(),
    body = new Node(),
    graphic = new Node();
  track.dataset.layoutTrackTarget = '0.4';
  via.dataset.layoutViaTarget = '0.3';
  body.dataset.layoutBodyBounds = '-1 -2 3 4';
  graphic.dataset.layoutGraphicTarget = '0.2';
  graphic.children = [new Node(), new Node()];
  const tracks = [track];
  svg.querySelectorAll = (selector?: string) => {
    svg.queries++;
    if (selector?.includes('data-layout-background')) return frames;
    if (selector?.includes('data-layout-track-target')) return tracks;
    if (selector?.includes('data-layout-via-target')) return [via];
    if (selector?.includes('data-layout-body-bounds')) return [body];
    if (selector?.includes('data-layout-graphic-target')) return [graphic];
    throw new Error(`Unknown selector ${selector}`);
  };
  const all = [svg, ...frames, track, via, body, graphic, ...graphic.children];
  return {
    svg: svg as unknown as SVGSVGElement,
    root: svg,
    all,
    track,
    tracks,
    via,
    body,
    snapshot: () => all.map((node) => [...node.attributes]),
  };
}

function withAnimationFrames(
  run: (frames: {
    pending: Map<number, FrameRequestCallback>;
    callbacks: Map<number, FrameRequestCallback>;
    next: () => void;
  }) => void,
) {
  const names = ['requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const pending = new Map<number, FrameRequestCallback>();
  const callbacks = new Map<number, FrameRequestCallback>();
  let index = 0;
  Object.defineProperty(globalThis, names[0], {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const id = ++index;
      pending.set(id, callback);
      callbacks.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(globalThis, names[1], {
    configurable: true,
    value: (id: number) => pending.delete(id),
  });
  try {
    run({
      pending,
      callbacks,
      next() {
        const frame = pending.entries().next().value;
        assert.ok(frame, 'An animation frame must be queued.');
        pending.delete(frame[0]);
        frame[1](0);
      },
    });
  } finally {
    names.forEach((name, offset) => {
      const descriptor = descriptors[offset];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

test('scheduled camera presents only the latest copied pose and retains pending hit updates', () => {
  withAnimationFrames((frames) => {
    const current = fixture(),
      reference = fixture();
    const size = { width: 800, height: 500 };
    const initial = { x: 0, y: 0, width: 80 };
    const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    apply(initial, size);
    const original = current.snapshot();
    apply({ x: 1, y: 2, width: 160 }, size);
    const latest = { x: 3.25, y: -4.75, width: 160 };
    apply(latest, size, false);
    latest.x = 900;
    assert.equal(frames.pending.size, 1);
    assert.deepEqual(current.snapshot(), original);
    assert.deepEqual(apply.getPresentedView(), initial);
    frames.next();
    const expected = { x: 3.25, y: -4.75, width: 160 };
    applyLayoutCamera(reference.svg, expected, size);
    assert.deepEqual(current.snapshot(), reference.snapshot());
    assert.deepEqual(apply.getPresentedView(), expected);
    const exposed = apply.getPresentedView()!;
    exposed.x = -999;
    assert.deepEqual(apply.getPresentedView(), expected);
    assert.equal(frames.pending.size, 0);
    apply.dispose();
  });
});

test('camera store stays synchronous while presentation waits and registry flush consumes latest', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const camera = createLayoutCamera({ x: 0, y: 0, width: 80 });
    const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    apply(camera.getSnapshot(), size);
    const stop = camera.subscribe(() => apply(camera.getSnapshot(), size));
    camera.setView({ x: 2, y: -3, width: 120 });
    camera.setView({ x: 8.123456789, y: -9.987654321, width: 160 });
    assert.equal(camera.view.x, 8.123456789);
    assert.equal(current.root.getAttribute('viewBox'), '0 0 80 50');
    flushLayoutCamera(current.svg);
    assert.equal(current.root.getAttribute('viewBox'), '8.123456789 -9.987654321 160 100');
    assert.equal(frames.pending.size, 0);
    stop();
    apply.dispose();
  });
});

test('synchronous drawing replay cancels an older frame without consuming a later scheduled pose', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    apply({ x: 1, y: 2, width: 160 }, size);
    const stale = [...frames.callbacks.values()][0];
    apply.applyNow({ x: 2, y: 3, width: 160 }, size, false);
    assert.equal(frames.pending.size, 0);
    assert.ok(Math.abs(Number(current.track.getAttribute('stroke-width')) - 1.4) < 1e-12);
    assert.equal(current.root.getAttribute('viewBox'), '2 3 160 100');
    apply({ x: 4, y: 5, width: 160 }, size, false);
    stale(0);
    assert.equal(frames.pending.size, 1);
    assert.equal(current.root.getAttribute('viewBox'), '2 3 160 100');
    frames.next();
    assert.equal(current.root.getAttribute('viewBox'), '4 5 160 100');
    apply.dispose();
  });
});

test('viewport changes synchronously replace pending navigation and dispose preserves final pose', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    apply({ x: 1, y: 2, width: 70 }, size);
    apply({ x: 3, y: 4, width: 90 }, { width: 900, height: 600 });
    assert.equal(frames.pending.size, 0);
    assert.equal(current.root.getAttribute('viewBox'), '3 4 90 60');
    apply({ x: 7, y: -8, width: 150 }, { width: 900, height: 600 });
    apply.dispose();
    assert.equal(frames.pending.size, 0);
    assert.equal(current.root.getAttribute('viewBox'), '7 -8 150 100');
    const disposed = current.snapshot();
    for (const callback of frames.callbacks.values()) callback(0);
    apply({ x: -999, y: -999, width: 8 }, size);
    apply.applyNow({ x: -999, y: -999, width: 8 }, size);
    assert.deepEqual(current.snapshot(), disposed);
  });
});

test('replacement lease rejects old pending draws, dispose and callbacks after the new native pose', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const old = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    old({ x: 0, y: 0, width: 80 }, size);
    old({ x: 1, y: 2, width: 70 }, size);
    const oldFrame = [...frames.callbacks.values()][0];
    const next = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    next({ x: 3, y: 4, width: 100 }, size);
    const nextNative = current.snapshot();
    old.dispose();
    oldFrame(0);
    old.flush();
    old.refreshTracks();
    old.applyNow({ x: -99, y: -99, width: 8 }, size);
    assert.deepEqual(current.snapshot(), nextNative);
    assert.deepEqual(next.getPresentedView(), { x: 3, y: 4, width: 100 });
    assert.equal(old.getPresentedView(), null);
    next({ x: 7, y: 8, width: 120 }, size);
    oldFrame(0);
    assert.equal(frames.pending.size, 1);
    assert.deepEqual(current.snapshot(), nextNative);
    flushLayoutCamera(current.svg);
    assert.equal(current.root.getAttribute('viewBox'), '7 8 120 75');
    assert.equal(frames.pending.size, 0);
    next.dispose();
  });
});

test('track refresh replaces only track references and width metadata without other target queries', () => {
  const current = fixture();
  const size = { width: 800, height: 500 };
  const apply = createLayoutCameraApplicator(current.svg);
  apply({ x: 2, y: 3, width: 160 }, size);
  const newTrack = new Node();
  newTrack.dataset.layoutTrackTarget = '0.2';
  current.tracks.push(newTrack);
  current.track.dataset.layoutTrackTarget = '4';
  const originalQueries = current.root.queries;
  const originalNonTrackWrites = current.all
    .filter((node) => node !== current.track)
    .map((node) => node.writes);
  apply.refreshTracks();
  assert.equal(current.root.queries - originalQueries, 1);
  assert.deepEqual(
    current.all.filter((node) => node !== current.track).map((node) => node.writes),
    originalNonTrackWrites,
  );
  assert.equal(current.track.getAttribute('stroke-width'), '4');
  assert.ok(Math.abs(Number(newTrack.getAttribute('stroke-width')) - 1.4) < 1e-12);
  const originalWrites = current.track.writes;
  current.tracks.splice(0, 1);
  apply.refreshTracks();
  apply({ x: 4, y: 5, width: 240 }, size);
  assert.equal(current.track.writes, originalWrites, 'Removed targets are no longer retained.');
  assert.ok(Math.abs(Number(newTrack.getAttribute('stroke-width')) - 2.1) < 1e-12);
  assert.equal(current.root.getAttribute('viewBox'), '4 5 240 150');
  apply.dispose();
});

test('track refresh consumes the latest pending pose and applies its scale to newly committed nodes', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    apply({ x: 1, y: 2, width: 160 }, size);
    apply({ x: 7.123456789, y: -8.987654321, width: 160 }, size, false);
    const replacement = new Node();
    replacement.dataset.layoutTrackTarget = '0.3';
    current.tracks.splice(0, 1, replacement);
    apply.refreshTracks();
    assert.equal(frames.pending.size, 0);
    assert.equal(current.root.getAttribute('viewBox'), '7.123456789 -8.987654321 160 100');
    assert.ok(Math.abs(Number(replacement.getAttribute('stroke-width')) - 1.4) < 1e-12);
    const refreshed = replacement.writes;
    for (const callback of frames.callbacks.values()) callback(0);
    assert.equal(replacement.writes, refreshed);
    apply.dispose();
  });
});

test('track refresh before the first camera draw binds the replacement tree for initial native padding', () => {
  const current = fixture();
  const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
  const replacement = new Node();
  replacement.dataset.layoutTrackTarget = '3';
  current.tracks.splice(0, 1, replacement);
  apply.refreshTracks();
  assert.equal(replacement.writes, 0);
  apply({ x: 1, y: 2, width: 80 }, { width: 800, height: 500 });
  assert.equal(replacement.getAttribute('stroke-width'), '3');
  assert.equal(current.root.getAttribute('viewBox'), '1 2 80 50');
  apply.dispose();
});

test('pan update scopes preserve synchronous state and release consumes the exact pending final pose', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const camera = createLayoutCamera({ x: 0, y: 0, width: 80 });
    const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    apply(camera.getSnapshot(), size);
    const stop = camera.subscribe(() => apply(camera.getSnapshot(), size, false));
    const pan = apply.beginPan();
    pan.update(() => camera.setView({ x: 3.123456789, y: -4.987654321, width: 80 }));
    assert.equal(camera.view.x, 3.123456789);
    assert.equal(current.root.getAttribute('viewBox'), '0 0 80 50');
    assert.equal(frames.pending.size, 1);
    pan.release();
    assert.equal(frames.pending.size, 0);
    assert.equal(current.root.getAttribute('viewBox'), '3.123456789 -4.987654321 80 50');
    let obsoleteUpdates = 0;
    pan.update(() => obsoleteUpdates++);
    assert.equal(obsoleteUpdates, 0);
    stop();
    apply.dispose();
  });
});

test('a newer pan lease rejects old update scopes and release without consuming its pending pose', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    const old = apply.beginPan();
    old.update(() => apply({ x: 1, y: 2, width: 80 }, size));
    const next = apply.beginPan();
    assert.equal(current.root.getAttribute('viewBox'), '1 2 80 50');
    next.update(() => apply({ x: 5, y: 6, width: 80 }, size));
    let obsoleteUpdates = 0;
    old.update(() => obsoleteUpdates++);
    old.release();
    assert.equal(obsoleteUpdates, 0);
    assert.equal(frames.pending.size, 1);
    assert.equal(current.root.getAttribute('viewBox'), '1 2 80 50');
    frames.next();
    assert.equal(current.root.getAttribute('viewBox'), '5 6 80 50');
    next.release();
    apply.dispose();
  });
});

test('owner retirement makes old pan callbacks inert before the new camera draws', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const old = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    old({ x: 0, y: 0, width: 80 }, size);
    const pan = old.beginPan();
    pan.update(() => old({ x: 1, y: 2, width: 80 }, size));
    const next = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    next({ x: 5, y: 6, width: 90 }, size);
    const rendered = current.snapshot();
    pan.update(() => next({ x: -999, y: -999, width: 8 }, size));
    pan.release();
    for (const callback of frames.callbacks.values()) callback(0);
    assert.deepEqual(current.snapshot(), rendered);
    next.dispose();
  });
});

test('a failed synchronous pan update leaves the lease releasable and later draws retryable', () => {
  withAnimationFrames((frames) => {
    const current = fixture();
    const size = { width: 800, height: 500 };
    const apply = createLayoutCameraApplicator(current.svg, { frameScheduled: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    const pan = apply.beginPan();
    assert.throws(
      () =>
        pan.update(() => {
          apply({ x: 1, y: 2, width: 80 }, size);
          throw new Error('Rejected update');
        }),
      /Rejected update/,
    );
    apply({ x: 3, y: 4, width: 70 }, size);
    frames.next();
    assert.equal(current.root.getAttribute('viewBox'), '3 4 70 43.75');
    pan.release();
    apply.dispose();
  });
});

test('camera preserves synchronous snapshot/getters and suppresses exact no-op notifications', () => {
  const camera = createLayoutCamera({ x: 1, y: 2, width: 40 });
  const original = camera.getSnapshot();
  let calls = 0;
  const stop = camera.subscribe(() => calls++);
  camera.setView({ ...original });
  assert.equal(calls, 0);
  assert.equal(camera.getSnapshot(), original);
  camera.setView((previous) => ({ ...previous, x: 3 }));
  assert.equal(camera.view.x, 3);
  assert.equal(calls, 1);
  stop();
  camera.setView((previous) => ({ ...previous, width: 60 }));
  assert.equal(camera.view.width, 60);
  assert.equal(calls, 1);
});

test('bound camera updates equal the full exact target path without per-frame DOM queries', () => {
  const cached = fixture(),
    complete = fixture();
  const apply = createLayoutCameraApplicator(cached.svg);
  const queries = cached.root.queries;
  for (let index = 0; index < 60; index++) {
    const view = { x: index / 7, y: -index / 3, width: 8 + index * 30.3 };
    const size = { width: 843.5, height: 527.25 };
    apply(view, size);
    applyLayoutCamera(complete.svg, view, size);
    assert.deepEqual(cached.snapshot(), complete.snapshot());
  }
  assert.equal(cached.root.queries, queries);
  assert.equal(cached.all.at(-3)!.queries, 1, 'Nested graphic targets are captured only once.');
  const hits = [cached.track.writes, cached.via.writes, cached.body.writes];
  apply({ x: 900, y: -800, width: 150 }, { width: 843.5, height: 527.25 }, false);
  assert.deepEqual([cached.track.writes, cached.via.writes, cached.body.writes], hits);
  assert.equal(cached.root.getAttribute('viewBox'), `900 -800 150 ${150 / (843.5 / 527.25)}`);
  assert.equal(cached.root.queries, queries);
});

test('a geometry rebind captures changed metadata and newly committed targets', () => {
  const current = fixture();
  const size = { width: 800, height: 500 },
    view = { x: 1, y: 2, width: 80 };
  createLayoutCameraApplicator(current.svg)(view, size);
  current.track.dataset.layoutTrackTarget = '4';
  current.body.dataset.layoutBodyBounds = '-5 -6 7 8';
  createLayoutCameraApplicator(current.svg)(view, size);
  assert.equal(current.track.getAttribute('stroke-width'), '4');
  assert.equal(current.body.getAttribute('x'), '-5.2');
  assert.equal(current.body.getAttribute('height'), '14.4');
});

test('zoom keeps pointer and centre anchors through both width clamps', () => {
  const ratio = 843.5 / 527.25;
  for (const width of [8, 8.2, 140.7, 1999, 2000]) {
    const previous = { x: -39.26, y: 71.38, width };
    for (const factor of [1 / 1.12, 1.12, 0.01, 1000]) {
      const at = { x: previous.x + width * 0.17, y: previous.y + (width / ratio) * 0.82 };
      const next = zoomLayoutView(previous, factor, ratio, at);
      assert.equal(next.width, layoutZoomWidth(width, factor));
      assert.ok(Math.abs((at.x - next.x) / next.width - 0.17) < 1e-12);
      assert.ok(Math.abs((at.y - next.y) / (next.width / ratio) - 0.82) < 1e-12);
      const centred = zoomLayoutView(previous, factor, ratio);
      assert.ok(Math.abs(centred.x + centred.width / 2 - (previous.x + width / 2)) < 1e-10);
      assert.ok(
        Math.abs(centred.y + centred.width / ratio / 2 - (previous.y + width / ratio / 2)) < 1e-10,
      );
    }
  }
});

test('zoom at a width limit retains the exact camera pose and does not notify', () => {
  for (const [width, factor] of [
    [8, 1 / 1.12],
    [2000, 1.12],
  ]) {
    const camera = createLayoutCamera({ x: 123.456789123, y: -76.543219876, width });
    const original = camera.getSnapshot();
    let notifications = 0;
    camera.subscribe(() => notifications++);
    camera.setView((view) => zoomLayoutView(view, factor, 1.49, { x: -99.13, y: 249.73 }));
    assert.equal(camera.getSnapshot(), original);
    assert.equal(notifications, 0);
  }
});

test('bound camera keeps grid density current through zoom, pan and commit replay', () => {
  const current = fixture();
  const pattern = new Node(),
    circle = new Node();
  pattern.setAttribute('data-layout-grid-spacing', '0.5');
  current.root.querySelector = (selector) => {
    current.root.queries++;
    assert.equal(selector, '[data-layout-grid-pattern]');
    return pattern;
  };
  pattern.querySelector = (selector) => {
    pattern.queries++;
    assert.equal(selector, 'circle');
    return circle;
  };
  const apply = createLayoutCameraApplicator(current.svg);
  const queries = current.root.queries;
  const size = { width: 800, height: 600 };
  apply({ x: 0, y: 0, width: 128 }, size);
  assert.equal(pattern.getAttribute('width'), '1');
  apply({ x: 0, y: 0, width: 800 }, size);
  assert.equal(pattern.getAttribute('width'), '8');
  const writes = pattern.writes + circle.writes;
  apply({ x: -160, y: 90, width: 800 }, size, false);
  assert.equal(pattern.writes + circle.writes, writes);
  // A concurrent editor commit can replay old pattern props without a scale change.
  pattern.setAttribute('width', '0.5');
  circle.setAttribute('r', '0.04');
  apply({ x: -160, y: 90, width: 800 }, size, false);
  assert.equal(pattern.getAttribute('width'), '8');
  assert.equal(circle.getAttribute('r'), '0.5');
  assert.equal(current.root.queries, queries);
  assert.equal(pattern.queries, 1);
});
