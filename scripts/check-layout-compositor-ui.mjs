import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolated SVG presentation correctness, not a desktop latency measurement.
const bundle = await build({
  stdin: {
    contents: `import{createLayoutCameraApplicator,createLayoutCamera,zoomLayoutView,rebaseLayoutCameraPoint}from'./components/LayoutCamera';
      import{flushLayoutCamera}from'./lib/layout-camera-presentation';
      import{captureLayoutPNG}from'./lib/drawing-export';
      import{annotationSelectionBounds,captureAnnotationImage}from'./lib/annotation-screenshot';
      Object.assign(window,{bindCamera:(svg,options)=>createLayoutCameraApplicator(svg,{...options,panFrameReserve:options?.compositor===true}),flushCamera:flushLayoutCamera,
        createLayoutCamera,zoomLayoutView,rebaseLayoutCameraPoint,
        captureLayoutPNG,annotationSelectionBounds,captureAnnotationImage});`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<style>body{margin:0;--canvas:#fff;--grid-dot:#bbb}
    .fixture{position:absolute;left:30px;top:40px;width:800px;height:500px}
    .fixture svg{width:100%;height:100%;display:block}</style>
    <div class="fixture" id="native"></div><div class="fixture" id="compositor"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const styleReads = (run) => {
      const original = window.getComputedStyle;
      const typedBefore = typedReads;
      let reads = 0;
      window.getComputedStyle = function (...args) {
        reads++;
        return original.apply(window, args);
      };
      try {
        run();
        // Both fresh resolved style and Typed OM satisfy the same guard.
        // Native replay must avoid both; other paths must perform a real read.
        return reads + typedReads - typedBefore;
      } finally {
        window.getComputedStyle = original;
      }
    };
    const markup = (id) => `<svg xmlns="http://www.w3.org/2000/svg" style="opacity:.95">
      <defs><pattern id="${id}-grid" data-layout-grid-pattern data-layout-grid-spacing=".5" patternUnits="userSpaceOnUse"><circle fill="#aaa"/></pattern></defs>
      <rect data-layout-background fill="white"/>
      <rect data-layout-grid fill="url(#${id}-grid)" pointer-events="none"/>
      <g data-layout-drawing><g data-selection-id="track">
      <line data-layout-track-target=".4" data-hit="track" x1="25" y1="20" x2="40" y2="20" stroke="transparent" stroke-width=".4"/>
      <line x1="25" y1="20" x2="40" y2="20" stroke="red" stroke-width=".4"/></g>
      <rect data-layout-body-bounds="45 12 60 20" data-hit="body" fill="transparent" pointer-events="all"/>
      <circle cx="35" cy="28" data-layout-via-target=".3" r=".3" fill="transparent"/>
      <line data-hit="airwire" x1="25" y1="35" x2="40" y2="35" stroke="blue" stroke-width="2" stroke-dasharray="4 3" stroke-dashoffset="1" vector-effect="non-scaling-stroke"/>
      <text x="30" y="43" font-size="2">Retained vector captions</text></g>
      <rect data-layout-interaction-surface fill="transparent" pointer-events="none"/></svg>`;
    const nativeHost = document.getElementById('native'),
      host = document.getElementById('compositor');
    nativeHost.innerHTML = markup('native');
    host.innerHTML = markup('compositor');
    const a = nativeHost.querySelector('svg'),
      b = host.querySelector('svg');
    const nativeComputedStyleMap = b.computedStyleMap;
    let typedReads = 0;
    check(
      typeof nativeComputedStyleMap === 'function',
      'The pinned browser must exercise native Typed OM.',
    );
    const typedReader = function () {
      typedReads++;
      return nativeComputedStyleMap.call(this);
    };
    Object.defineProperty(b, 'computedStyleMap', { configurable: true, value: typedReader });
    let reference = window.bindCamera(a, { fixedTargets: true });
    let apply = window.bindCamera(b, { fixedTargets: true, compositor: true });
    const size = { width: 800, height: 500 };
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    const matrixError = () => {
      const left = a.getScreenCTM(),
        right = b.getScreenCTM();
      return Math.max(...keys.map((key) => Math.abs(left[key] - right[key])));
    };
    let maximumMatrixError = 0,
      hitSamples = 0;
    const compare = (view, flushHits = false) => {
      reference(view, size);
      apply(view, size);
      if (flushHits) window.flushCamera(b);
      maximumMatrixError = Math.max(maximumMatrixError, matrixError());
      check(matrixError() < 0.0002, 'Transient world CTM differs from the native camera.');
      const points = [];
      for (const y of flushHits ? [20, 35] : [35])
        for (const x of [27, 32, 37])
          for (const offset of [-4, -3.55, -3.45, -1.05, -0.95, 0, 0.95, 1.05, 3.45, 3.55, 4]) {
            const screen = new DOMPoint(x, y).matrixTransform(a.getScreenCTM());
            points.push({ x: screen.x, y: screen.y + offset });
          }
      const pick = ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-hit') ?? null;
      host.style.visibility = 'hidden';
      nativeHost.style.visibility = 'visible';
      const expected = points.map(pick);
      nativeHost.style.visibility = 'hidden';
      host.style.visibility = 'visible';
      const actual = points.map(pick);
      check(
        actual.every((hit, index) => hit === expected[index]),
        'Visible non-scaling strokes or flushed hit padding differ from native camera.',
      );
      hitSamples += points.length;
    };
    const poses = [
      { x: 0, y: 0, width: 80 },
      { x: 2.3, y: -1.7, width: 80 },
      { x: 7.8, y: 3.1, width: 80 / 1.12 },
      { x: 15, y: 5, width: 60 },
      { x: 8.2, y: -3.4, width: 71.5 },
      { x: -2.5, y: 1.9, width: 80 },
    ];
    for (const pose of poses) compare(pose);
    check(typedReads > 0, 'Transient camera did not use computed Typed OM transforms.');
    check(
      b.hasAttribute('data-layout-camera-view'),
      'Camera motion did not enter compositor presentation.',
    );
    const current = poses.at(-1),
      box = `${current.x} ${current.y} ${current.width} ${current.width / 1.6}`;
    await new Promise((resolve) => setTimeout(resolve, 150));
    check(
      !b.hasAttribute('data-layout-camera-view') && b.getAttribute('viewBox') === box,
      'Idle camera did not rebase its exact latest native pose.',
    );
    check(
      b.style.opacity === '0.95' && !b.style.transform && !host.style.overflow,
      'Idle camera overwrote unrelated styles or retained owned transforms.',
    );
    const background = b.querySelector('[data-layout-background]');
    const gridPattern = b.querySelector('[data-layout-grid-pattern]');
    background.setAttribute('x', '-999');
    gridPattern.setAttribute('width', '.5');
    const nativeReplayStyleReads = styleReads(() => apply(current, size, false));
    check(
      nativeReplayStyleReads === 0 &&
        background.getAttribute('x') === String(current.x) &&
        gridPattern.getAttribute('width') === '1' &&
        b.getAttribute('viewBox') === box,
      'Settled native replay read CSS or failed to repair frame/grid props.',
    );
    b.setAttribute('viewBox', '0 0 80 50');
    check(
      styleReads(() => apply(current, size, false)) > 0 && b.getAttribute('viewBox') === box,
      'A stale native viewBox bypassed the complete camera guard or stayed stale.',
    );
    b.style.setProperty('transform', 'rotate(3deg)', 'important');
    const foreignBefore = b.getScreenCTM();
    check(
      styleReads(() => apply(current, size, false)) === 0 &&
        b.style.transform === 'rotate(3deg)' &&
        b.style.getPropertyPriority('transform') === 'important',
      'Native replay overwrote a foreign important transform.',
    );
    const foreignAfter = b.getScreenCTM();
    check(
      keys.every((key) => foreignAfter[key] === foreignBefore[key]),
      'Native replay changed foreign-transformed coordinates.',
    );
    b.style.removeProperty('transform');
    const pendingPose = { x: 1, y: 2, width: 72 };
    reference(pendingPose, size);
    apply(pendingPose, size);
    check(
      styleReads(() => apply(pendingPose, size, false)) > 0 &&
        b.hasAttribute('data-layout-camera-view'),
      'An unsettled compositor pose bypassed the complete guard.',
    );
    window.flushCamera(b);

    compare({ x: 3.2, y: 2.8, width: 70 }, true);
    window.flushCamera(b);
    check(
      !b.hasAttribute('data-layout-camera-view') && matrixError() < 0.0002,
      'Immediate picking flush changed the camera.',
    );
    const replayPose = { x: 1, y: 2, width: 73 };
    compare(replayPose);
    b.setAttribute('viewBox', '0 0 80 50');
    window.flushCamera(b);
    apply(replayPose, size);
    check(
      matrixError() < 0.0002 && b.getAttribute('viewBox') === '1 2 73 45.625',
      'A committed stale native viewport replaced the latest camera.',
    );
    b.setAttribute('viewBox', '0 0 80 50');
    apply(replayPose, size);
    check(
      matrixError() < 0.0002 && b.getAttribute('viewBox') === '1 2 73 45.625',
      'A settled stale React viewBox was retained by the native camera cache.',
    );
    compare({ x: -1.4, y: 1.2, width: 75 });
    nativeHost.style.visibility = 'visible';
    const bounds = { minX: 20, minY: 10, maxX: 65, maxY: 45 };
    const nativePNG = await window.captureLayoutPNG(a, bounds);
    const compositorPNG = await window.captureLayoutPNG(b, bounds);
    check(
      nativePNG.dataUrl === compositorPNG.dataUrl,
      'PNG export differs after transient camera motion.',
    );
    check(
      !b.hasAttribute('data-layout-camera-view') && !b.style.transform,
      'Programmatic PNG capture left a transient transform.',
    );
    compare({ x: 4, y: 3, width: 72 });
    nativeHost.style.visibility = 'visible';
    const nativeBounds = window.annotationSelectionBounds(a, ['track']);
    const compositorBounds = window.annotationSelectionBounds(b, ['track']);
    check(
      Object.keys(nativeBounds).every(
        (key) => Math.abs(nativeBounds[key] - compositorBounds[key]) < 0.0002,
      ),
      'Annotation world selection bounds differ after camera motion.',
    );
    const annotationBounds = { x: 20, y: 10, width: 45, height: 35 };
    compare({ x: 6, y: 2, width: 68 });
    nativeHost.style.visibility = 'visible';
    const nativeAnnotation = await window.captureAnnotationImage(a, ['track'], annotationBounds);
    const compositorAnnotation = await window.captureAnnotationImage(
      b,
      ['track'],
      annotationBounds,
    );
    check(
      nativeAnnotation.dataUrl === compositorAnnotation.dataUrl,
      'Annotation PNG double-applied the camera.',
    );

    compare({ x: 2, y: 3, width: 70 });
    window.flushCamera(b);
    host.style.width = '810px';
    check(
      styleReads(() => apply({ x: 2, y: 3, width: 70 }, { width: 810, height: 500 }, false)) > 0,
      'Changed viewport dimensions entered the settled native replay path.',
    );
    apply({ x: 2, y: 3, width: 70 }, { width: 810, height: 500 });
    check(
      !b.hasAttribute('data-layout-camera-view'),
      'Resize did not use exact native camera updates.',
    );
    apply.dispose();
    reference.dispose();
    host.style.removeProperty('width');
    b.innerHTML = markup('replacement').match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
    b.setAttribute('viewBox', '2 3 70 43.75');
    apply = window.bindCamera(b, { fixedTargets: true, compositor: true });
    check(
      styleReads(() => apply({ x: 2, y: 3, width: 70 }, size, false)) > 0,
      'A new binding trusted matching DOM attributes before establishing its private native pose.',
    );
    apply({ x: 2, y: 3, width: 70 }, size);
    check(
      !b.hasAttribute('data-layout-camera-view'),
      'First drawing application used a transient camera.',
    );
    apply({ x: 3, y: 4, width: 60 }, size);
    apply.dispose();
    const disposed = b.outerHTML;
    await new Promise((resolve) => setTimeout(resolve, 150));
    check(
      b.outerHTML === disposed,
      'Disposed camera retained a timer or changed replaced drawing.',
    );

    for (const transform of ['scale(1.1,.8)', 'skewX(12deg)', 'rotate(4deg)']) {
      host.style.transform = transform;
      const transformed = window.bindCamera(b, { fixedTargets: true, compositor: true });
      transformed({ x: 5, y: 4, width: 80 }, size);
      transformed({ x: 7, y: 3, width: 70 }, size);
      check(
        !b.hasAttribute('data-layout-camera-view') && !b.style.transform,
        'Transformed ancestor did not retain the native camera path.',
      );
      transformed.dispose();
    }
    host.style.removeProperty('transform');
    apply = window.bindCamera(b, { fixedTargets: true, compositor: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    apply({ x: 1, y: 2, width: 70 }, size);
    const foreignTransform = b.style.transform;
    b.style.setProperty('transform', foreignTransform, 'important');
    b.style.opacity = '.7';
    apply({ x: 2, y: 3, width: 65 }, size);
    apply.dispose();
    check(
      b.style.getPropertyPriority('transform') === 'important' &&
        b.style.transform === foreignTransform &&
        b.style.opacity === '0.7',
      'Disposal overwrote an externally owned style or priority.',
    );
    b.style.removeProperty('transform');
    b.style.opacity = '.95';
    b.id = 'compositor-svg';
    const override = document.createElement('style');
    override.textContent = '#compositor-svg{transform:none!important}';
    document.head.append(override);
    apply = window.bindCamera(b, { fixedTargets: true, compositor: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    apply({ x: 3, y: 4, width: 70 }, size);
    check(
      !b.hasAttribute('data-layout-camera-view') && b.getAttribute('viewBox') === '3 4 70 43.75',
      'A stylesheet-important transform override bypassed native fallback.',
    );
    apply.dispose();
    override.remove();
    let fallbackThrows = 0;
    for (const method of [
      undefined,
      function () {
        fallbackThrows++;
        throw new Error('Typed OM unavailable');
      },
    ]) {
      Object.defineProperty(b, 'computedStyleMap', { configurable: true, value: method });
      apply = window.bindCamera(b, { fixedTargets: true, compositor: true });
      apply({ x: 0, y: 0, width: 80 }, size);
      apply({ x: 3, y: 4, width: 70 }, size);
      const m = b.getScreenCTM(),
        frame = host.getBoundingClientRect(),
        scale = size.width / 70;
      check(
        Math.abs(m.a - scale) < 0.0002 &&
          Math.abs(m.d - scale) < 0.0002 &&
          Math.abs(m.e - (frame.left - 3 * scale)) < 0.0002 &&
          Math.abs(m.f - (frame.top - 4 * scale)) < 0.0002,
        'Missing or throwing Typed OM changed the fallback world transform.',
      );
      check(
        b.hasAttribute('data-layout-camera-view'),
        'Resolved fallback lost valid compositor motion.',
      );
      apply.dispose();
    }
    check(fallbackThrows > 0, 'The throwing Typed OM fallback was not exercised.');
    Object.defineProperty(b, 'computedStyleMap', { configurable: true, value: typedReader });
    apply = window.bindCamera(b, { fixedTargets: true, compositor: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    apply({ x: 1, y: 2, width: 70 }, size);
    b.style.setProperty('transform', 'rotate(3deg)', 'important');
    apply({ x: 2, y: 1, width: 65 }, size);
    check(
      b.style.transform === 'rotate(3deg)' &&
        b.style.getPropertyPriority('transform') === 'important' &&
        !b.hasAttribute('data-layout-camera-view'),
      'An external root transform was overwritten or composed as an owned camera.',
    );
    apply.dispose();
    b.style.removeProperty('transform');
    apply = window.bindCamera(b, { fixedTargets: true, compositor: true });
    apply({ x: 0, y: 0, width: 80 }, size);
    for (const pose of [
      { x: 0, y: 0, width: 8 },
      { x: 0, y: 0, width: 2000 },
      { x: 10000, y: -10000, width: 80 },
    ]) {
      apply(pose, size);
      check(
        !b.hasAttribute('data-layout-camera-view') &&
          b.getAttribute('viewBox').startsWith(`${pose.x} ${pose.y} ${pose.width} `),
        'Extreme accepted camera poses were clamped or allocated unbounded raster transforms.',
      );
    }
    apply.dispose();
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let coalescedInputs = 0;
    for (const outer of ['', 'matrix(.9,.23,-.34,1.15,0,0)']) {
      nativeHost.style.transform = outer;
      host.style.transform = outer;
      reference = window.bindCamera(a, { fixedTargets: true });
      apply = window.bindCamera(b, {
        fixedTargets: true,
        compositor: true,
        frameScheduled: true,
      });
      const camera = window.createLayoutCamera({ x: 0, y: 0, width: 80 });
      reference(camera.getSnapshot(), size);
      apply(camera.getSnapshot(), size);
      const before = b.outerHTML;
      const presented = apply.getPresentedView();
      const mappedPoint = (screen) => {
        const point = screen.matrixTransform(b.getScreenCTM().inverse());
        return window.rebaseLayoutCameraPoint(
          point,
          apply.getPresentedView(),
          camera.getSnapshot(),
        );
      };
      let styleReadsBeforeFrame = 0;
      for (const [x, y, factor] of [
        [240, 210, 1 / 1.12],
        [290, 245, 1 / 1.12],
        [205, 270, 1.12],
      ]) {
        const screen = new DOMPoint(x, y);
        const expected = screen.matrixTransform(a.getScreenCTM().inverse());
        const anchor = mappedPoint(screen);
        check(
          Math.hypot(anchor.x - expected.x, anchor.y - expected.y) < 0.0002,
          'Queued wheel motion used the previous displayed camera as its latest anchor.',
        );
        camera.setView((view) => window.zoomLayoutView(view, factor, 1.6, anchor));
        reference(camera.getSnapshot(), size);
        styleReadsBeforeFrame += styleReads(() => apply(camera.getSnapshot(), size));
        coalescedInputs++;
      }
      camera.setView((view) => ({ ...view, x: view.x + 3.123456789, y: view.y - 2.987654321 }));
      reference(camera.getSnapshot(), size);
      styleReadsBeforeFrame += styleReads(() => apply(camera.getSnapshot(), size, false));
      const screen = new DOMPoint(320, 260);
      const expected = screen.matrixTransform(a.getScreenCTM().inverse());
      const panPoint = mappedPoint(screen);
      check(
        Math.hypot(panPoint.x - expected.x, panPoint.y - expected.y) < 0.0002,
        'Queued zoom followed by pan changed its logical world point.',
      );
      coalescedInputs++;
      check(
        styleReadsBeforeFrame === 0 &&
          b.outerHTML === before &&
          JSON.stringify(apply.getPresentedView()) === JSON.stringify(presented),
        'Navigation performed camera DOM work before the scheduled frame.',
      );
      await nextFrame();
      maximumMatrixError = Math.max(maximumMatrixError, matrixError());
      check(matrixError() < 0.0002, 'The scheduled frame did not present the latest exact pose.');
      window.flushCamera(b);
      check(
        !b.hasAttribute('data-layout-camera-view') &&
          b.getAttribute('viewBox') === a.getAttribute('viewBox') &&
          b.querySelector('[data-layout-track-target]').getAttribute('stroke-width') ===
            a.querySelector('[data-layout-track-target]').getAttribute('stroke-width'),
        'Zoom then pan lost its final pose or pending hit-width update.',
      );
      apply.dispose();
      reference.dispose();
    }
    nativeHost.style.removeProperty('transform');
    host.style.removeProperty('transform');
    nativeHost.style.visibility = 'visible';
    reference = window.bindCamera(a, { fixedTargets: true });
    apply = window.bindCamera(b, { fixedTargets: true, compositor: true, frameScheduled: true });
    reference({ x: 0, y: 0, width: 80 }, size);
    apply({ x: 0, y: 0, width: 80 }, size);
    const queuedCapture = { x: 4.123456789, y: -3.987654321, width: 73.456789 };
    reference(queuedCapture, size);
    apply(queuedCapture, size);
    const pendingNativePNG = await window.captureLayoutPNG(a, bounds);
    const pendingCameraPNG = await window.captureLayoutPNG(b, bounds);
    check(
      pendingNativePNG.dataUrl === pendingCameraPNG.dataUrl &&
        b.getAttribute('viewBox') === a.getAttribute('viewBox') &&
        !b.style.transform,
      'Capture did not consume the pending camera before native cloning.',
    );
    apply({ x: 3, y: 3, width: 90 }, size);
    const queuedPick = { x: 4, y: 3, width: 90 };
    reference(queuedPick, size);
    apply(queuedPick, size, false);
    window.flushCamera(b);
    const hitPoint = new DOMPoint(32, 20).matrixTransform(a.getScreenCTM());
    const pickOffsets = [-3.55, -3.45, 3.45, 3.55];
    const pickMargin = (offset) =>
      document.elementFromPoint(hitPoint.x, hitPoint.y + offset)?.getAttribute('data-hit') ?? null;
    host.style.visibility = 'hidden';
    const expectedMargin = pickOffsets.map(pickMargin);
    nativeHost.style.visibility = 'hidden';
    host.style.visibility = 'visible';
    const actualMargin = pickOffsets.map(pickMargin);
    check(
      expectedMargin[1] === 'track' &&
        expectedMargin[2] === 'track' &&
        expectedMargin[0] !== 'track' &&
        expectedMargin[3] !== 'track' &&
        actualMargin.every((hit, index) => hit === expectedMargin[index]),
      'Immediate zoom/pan picking did not restore the exact seven-pixel track target.',
    );
    nativeHost.style.visibility = 'visible';
    const queuedAnnotation = { x: 5, y: 6, width: 72 };
    reference(queuedAnnotation, size);
    apply(queuedAnnotation, size);
    const pendingNativeBounds = window.annotationSelectionBounds(a, ['track']);
    const pendingCameraBounds = window.annotationSelectionBounds(b, ['track']);
    check(
      Object.keys(pendingNativeBounds).every(
        (key) => Math.abs(pendingNativeBounds[key] - pendingCameraBounds[key]) < 0.0002,
      ) && b.getAttribute('viewBox') === a.getAttribute('viewBox'),
      'Selection capture observed the previous frame instead of the latest camera.',
    );
    apply({ x: 7, y: 8, width: 70 }, size);
    b.style.setProperty('transform', 'rotate(3deg)', 'important');
    window.flushCamera(b);
    check(
      b.getAttribute('viewBox') === '7 8 70 43.75' &&
        b.style.transform === 'rotate(3deg)' &&
        b.style.getPropertyPriority('transform') === 'important',
      'Scheduled flushing overwrote a foreign important transform.',
    );
    b.style.removeProperty('transform');
    apply({ x: 8, y: 9, width: 65 }, size);
    host.style.transform = 'skewX(12deg)';
    window.flushCamera(b);
    check(
      b.getAttribute('viewBox') === '8 9 65 40.625' &&
        !b.style.transform &&
        !b.hasAttribute('data-layout-camera-view'),
      'An ancestor transformed before the pending frame bypassed native fallback.',
    );
    host.style.removeProperty('transform');
    apply({ x: 9, y: 10, width: 60 }, size);
    host.style.width = '810px';
    apply({ x: 10, y: 11, width: 81 }, { width: 810, height: 500 });
    check(
      b.getAttribute('viewBox') === '10 11 81 50' && !b.style.transform,
      'Resize retained an obsolete pending frame or deferred its native pose.',
    );
    apply({ x: 11.123456789, y: 12.987654321, width: 90 }, { width: 810, height: 500 });
    apply.dispose();
    const scheduledDisposed = b.outerHTML;
    await nextFrame();
    check(
      b.outerHTML === scheduledDisposed &&
        b.getAttribute('viewBox').startsWith('11.123456789 12.987654321 90 ') &&
        Math.abs(Number(b.getAttribute('viewBox').split(' ')[3]) - 500 / 9) < 1e-12 &&
        !b.style.willChange,
      'Scheduled disposal lost its latest pose or retained a frame/promotion.',
    );
    reference.dispose();
    host.style.removeProperty('width');
    const predecessor = window.bindCamera(b, {
      fixedTargets: true,
      compositor: true,
      frameScheduled: true,
    });
    predecessor({ x: 0, y: 0, width: 80 }, size);
    predecessor.applyNow({ x: 1, y: 2, width: 70 }, size);
    check(b.style.transform, 'The owner handoff must retire an active compositor pose.');
    const nativeRequestFrame = window.requestAnimationFrame;
    let obsoleteFrame;
    window.requestAnimationFrame = function (callback) {
      obsoleteFrame = callback;
      return nativeRequestFrame.call(window, callback);
    };
    try {
      predecessor({ x: -100, y: -100, width: 8 }, size);
    } finally {
      window.requestAnimationFrame = nativeRequestFrame;
    }
    const successor = window.bindCamera(b, {
      fixedTargets: true,
      compositor: true,
      frameScheduled: true,
    });
    successor({ x: 5, y: 6, width: 90 }, size);
    const successorNative = b.outerHTML;
    predecessor.dispose();
    predecessor.flush();
    obsoleteFrame(0);
    check(
      b.outerHTML === successorNative &&
        b.getAttribute('viewBox') === '5 6 90 56.25' &&
        successor.getPresentedView().width === 90 &&
        !predecessor.getPresentedView(),
      'An obsolete camera changed the replacement native pose or its promotion.',
    );
    successor({ x: 6, y: 7, width: 80 }, size);
    obsoleteFrame(0);
    check(b.outerHTML === successorNative, 'An obsolete frame consumed the successor queue.');
    await nextFrame();
    check(
      b.hasAttribute('data-layout-camera-view') && b.style.willChange === 'transform',
      'The new owner captured old CSS or lost its compositor promotion.',
    );
    predecessor.dispose();
    const successorTransient = b.outerHTML;
    obsoleteFrame(0);
    check(b.outerHTML === successorTransient, 'Obsolete cleanup removed successor-owned CSS.');
    window.flushCamera(b);
    check(
      b.getAttribute('viewBox') === '6 7 80 50' && !b.style.transform,
      'The replacement camera registry did not retain the newest owner.',
    );
    successor.dispose();
    check(!b.style.willChange, 'The successor retained its predecessor promotion baseline.');
    apply = window.bindCamera(b, {
      fixedTargets: true,
      compositor: true,
      frameScheduled: true,
    });
    apply({ x: 0, y: 0, width: 80 }, size);
    const oldTrack = b.querySelector('[data-layout-track-target]');
    const trackOwner = oldTrack.parentElement;
    const makeTrack = (y, width) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      for (const [name, value] of Object.entries({
        'data-layout-track-target': width,
        'data-hit': 'refreshed-track',
        x1: 25,
        x2: 40,
        y1: y,
        y2: y,
        stroke: 'transparent',
        'stroke-width': width,
      }))
        node.setAttribute(name, String(value));
      return node;
    };
    const replacementTrack = makeTrack(20, 0.4);
    const appendedTrack = makeTrack(24, 0.3);
    oldTrack.replaceWith(replacementTrack);
    trackOwner.append(appendedTrack);
    const bodyBeforeRefresh = b.querySelector('[data-layout-body-bounds]').outerHTML;
    const patternBeforeRefresh = b.querySelector('[data-layout-grid-pattern]').outerHTML;
    const originalBoundsReader = b.getBoundingClientRect;
    const originalQueryAll = b.querySelectorAll;
    let refreshBoundsReads = 0;
    const refreshQueries = [];
    Object.defineProperty(b, 'getBoundingClientRect', {
      configurable: true,
      value() {
        refreshBoundsReads++;
        return originalBoundsReader.call(this);
      },
    });
    Object.defineProperty(b, 'querySelectorAll', {
      configurable: true,
      value(selector) {
        refreshQueries.push(selector);
        return originalQueryAll.call(this, selector);
      },
    });
    try {
      apply.refreshTracks();
    } finally {
      delete b.getBoundingClientRect;
      delete b.querySelectorAll;
    }
    check(
      refreshBoundsReads === 0 &&
        refreshQueries.length === 1 &&
        refreshQueries[0] === '[data-layout-track-target]' &&
        b.querySelector('[data-layout-body-bounds]').outerHTML === bodyBeforeRefresh &&
        b.querySelector('[data-layout-grid-pattern]').outerHTML === patternBeforeRefresh &&
        b.style.willChange === 'transform',
      'Track refresh rebuilt unrelated camera targets or reread the SVG viewport.',
    );
    for (const track of [replacementTrack, appendedTrack])
      check(
        track.getAttribute('stroke-width') === '7' &&
          track.getAttribute('vector-effect') === 'non-scaling-stroke',
        'A newly committed track did not receive fixed hit padding.',
      );
    const marginPoint = new DOMPoint(32, 24).matrixTransform(b.getScreenCTM());
    nativeHost.style.visibility = 'hidden';
    const trackRefreshHits = [-3.55, -3.45, 3.45, 3.55].map(
      (offset) =>
        document.elementFromPoint(marginPoint.x, marginPoint.y + offset) === appendedTrack,
    );
    check(
      JSON.stringify(trackRefreshHits) === JSON.stringify([false, true, true, false]),
      'New track hit nodes lost their exact seven-pixel margin.',
    );
    const removedTrack = oldTrack.outerHTML;
    apply.applyNow({ x: 1, y: 2, width: 70 }, size);
    const airwire = b.querySelector('[data-hit="airwire"]');
    airwire.setAttribute('stroke-width', '9');
    apply.refreshTracks();
    check(
      airwire.getAttribute('stroke-width') === '9',
      'Track refresh overwrote an externally changed visible stroke.',
    );
    apply({ x: 3, y: 4, width: 64 }, size);
    apply({ x: 5, y: 6, width: 64 }, size, false);
    trackOwner.prepend(appendedTrack);
    replacementTrack.dataset.layoutTrackTarget = '4';
    apply.refreshTracks();
    check(
      b.getAttribute('viewBox') === '5 6 64 40' &&
        !b.style.transform &&
        oldTrack.outerHTML === removedTrack &&
        airwire.getAttribute('stroke-width') === '9',
      'Refresh lost a pending pose, retained removed targets or overwrote foreign stroke metrics.',
    );
    let bodyRefreshSamples = 0;
    for (const transform of ['skewX(12deg)', '']) {
      host.style.transform = transform;
      nativeHost.style.transform = transform;
      reference = window.bindCamera(a, { fixedTargets: true, compositor: true });
      reference({ x: 5, y: 6, width: 64 }, size);
      apply.refreshTracks();
      const expectedBody = a.querySelector('[data-layout-body-bounds]');
      const actualBody = b.querySelector('[data-layout-body-bounds]');
      check(
        [
          'data-layout-fixed-body',
          'x',
          'y',
          'width',
          'height',
          'stroke',
          'stroke-width',
          'stroke-linejoin',
          'vector-effect',
        ].every((name) => actualBody.getAttribute(name) === expectedBody.getAttribute(name)),
        'A refreshed fixed/dynamic body mode differs from a fresh native camera binding.',
      );
      const edge = new DOMPoint(45, 16).matrixTransform(a.getScreenCTM());
      const offsets = [-12, -8.5, -8.15, -7, -4, -2, 0, 2];
      const hits = (target) =>
        offsets.map((offset) => document.elementFromPoint(edge.x + offset, edge.y) === target);
      host.style.visibility = 'hidden';
      nativeHost.style.visibility = 'visible';
      const expectedHits = hits(expectedBody);
      nativeHost.style.visibility = 'hidden';
      host.style.visibility = 'visible';
      const actualHits = hits(actualBody);
      check(
        expectedHits.some(Boolean) &&
          expectedHits.some((hit) => !hit) &&
          actualHits.every((hit, index) => hit === expectedHits[index]),
        'Track refresh retained stale body hit margins through an ancestor transform change.',
      );
      bodyRefreshSamples += offsets.length;
      check(
        replacementTrack.getAttribute('stroke-width') === (transform ? '4' : '7') &&
          Math.abs(Number(appendedTrack.getAttribute('stroke-width')) - (transform ? 0.56 : 7)) <
            1e-12 &&
          appendedTrack.hasAttribute('vector-effect') === !transform &&
          !b.style.transform,
        'Track refresh did not synchronize native dynamic/fixed padding on mode changes.',
      );
      reference.dispose();
    }
    host.style.removeProperty('transform');
    nativeHost.style.removeProperty('transform');
    apply.dispose();
    const nativeTimeout = window.setTimeout,
      nativeClearTimeout = window.clearTimeout;
    const idleTimers = new Map();
    let idleId = -1,
      heldPanCases = 0;
    window.setTimeout = function (callback, delay, ...args) {
      if (delay === 120) {
        const id = idleId--;
        idleTimers.set(id, () => callback(...args));
        return id;
      }
      return nativeTimeout.call(window, callback, delay, ...args);
    };
    window.clearTimeout = function (id) {
      if (!idleTimers.delete(id)) nativeClearTimeout.call(window, id);
    };
    const finishIdle = () => {
      check(idleTimers.size === 1, 'An ordinary camera update must retain its 120 ms idle timer.');
      const [id, callback] = idleTimers.entries().next().value;
      idleTimers.delete(id);
      callback();
      check(!b.style.transform, 'The ordinary idle timer did not perform a native rebase.');
    };
    try {
      for (const frameScheduled of [false, true]) {
        apply = window.bindCamera(b, { fixedTargets: true, compositor: true, frameScheduled });
        const camera = window.createLayoutCamera({ x: 0, y: 0, width: 80 });
        apply(camera.getSnapshot(), size);
        const stop = camera.subscribe(() => apply(camera.getSnapshot(), size));
        const pan = apply.beginPan();
        check(
          idleTimers.size === 0 && !b.style.transform,
          'Pointer down alone changed camera timing.',
        );
        pan.update(() => camera.setView({ x: 1, y: 2, width: 80 }));
        await nextFrame();
        check(
          b.style.transform && idleTimers.size === 0,
          'A pure held pan retained an idle rebase.',
        );
        heldPanCases++;

        pan.update(() => camera.setView({ x: 2, y: 3, width: 80 }));
        camera.setView({ x: 3, y: 4, width: 80 });
        await nextFrame();
        finishIdle();
        check(
          b.getAttribute('viewBox') === '3 4 80 50',
          'Pan then normal did not retain the latest source.',
        );
        heldPanCases++;

        camera.setView({ x: 4, y: 5, width: 80 });
        pan.update(() => camera.setView({ x: 5, y: 6, width: 80 }));
        await nextFrame();
        check(
          b.style.transform && idleTimers.size === 0,
          'Normal then pure pan failed to hold the latest source.',
        );
        heldPanCases++;

        camera.setView({ x: 5, y: 6, width: 70 });
        pan.update(() => camera.setView({ x: 6, y: 7, width: 70 }));
        await nextFrame();
        finishIdle();
        check(
          b.getAttribute('viewBox') === '6 7 70 43.75',
          'A held lease suppressed zoom idle rebasing.',
        );
        heldPanCases++;

        pan.update(() => camera.setView({ x: 7, y: 8, width: 70 }));
        await nextFrame();
        apply.applyNow(camera.getSnapshot(), size, false);
        finishIdle();
        heldPanCases++;

        pan.update(() => camera.setView({ x: 8.123456789, y: -9.987654321, width: 70 }));
        pan.release();
        check(
          b.getAttribute('viewBox') === '8.123456789 -9.987654321 70 43.75' &&
            !b.style.transform &&
            idleTimers.size === 0,
          'Pan release did not consume and flush its exact pending pose.',
        );
        const nextPan = apply.beginPan();
        nextPan.update(() => camera.setView({ x: 9, y: 10, width: 70 }));
        window.flushCamera(b);
        check(
          !b.style.transform && idleTimers.size === 0,
          'Explicit capture flush retained a held transform.',
        );
        nextPan.update(() => camera.setView({ x: 10, y: 11, width: 70 }));
        await nextFrame();
        check(
          b.style.transform && idleTimers.size === 0,
          'A held pointer could not resume after an explicit flush.',
        );
        heldPanCases++;

        const previous = apply;
        apply = window.bindCamera(b, { fixedTargets: true, compositor: true, frameScheduled });
        apply({ x: 20, y: 21, width: 80 }, size);
        const successorView = b.outerHTML;
        let obsoleteUpdate = false;
        nextPan.update(() => {
          obsoleteUpdate = true;
          apply({ x: -999, y: -999, width: 8 }, size);
        });
        nextPan.release();
        previous.dispose();
        check(
          !obsoleteUpdate && b.outerHTML === successorView,
          'An obsolete pan lease touched a new camera owner.',
        );
        stop();
        const replacementPan = apply.beginPan();
        replacementPan.update(() => apply({ x: 21, y: 22, width: 80 }, size));
        await nextFrame();
        check(
          b.style.transform && idleTimers.size === 0,
          'The replacement owner did not accept a new pan lease.',
        );
        apply.dispose();
        check(
          !b.style.transform && idleTimers.size === 0,
          'Disposal retained a held pan or timer.',
        );
        heldPanCases++;
      }
    } finally {
      apply.dispose();
      window.setTimeout = nativeTimeout;
      window.clearTimeout = nativeClearTimeout;
    }
    // Exercise the production opt-in's actual SVG clipping, CTM and capture
    // lifecycle, in addition to the shared compositor checks above.
    // Earlier mutation cases intentionally changed only one fixture's strokes
    // and hit nodes. Begin this independent pixel comparison with equal inputs.
    reference.dispose();
    a.innerHTML = markup('reserve-native').match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
    b.innerHTML = markup('reserve-owned').match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
    apply = window.bindCamera(b, { fixedTargets: true, compositor: true });
    reference = window.bindCamera(a, { fixedTargets: true });
    const initialReserveView = { x: 0, y: 0, width: 80 };
    apply(initialReserveView, size);
    reference(initialReserveView, size);
    const frameNodes = [
      ...b.querySelectorAll(
        '[data-layout-background], [data-layout-grid], [data-layout-interaction-surface]',
      ),
    ];
    check(frameNodes.length === 3, 'The pan reserve omitted a viewport frame.');
    const frameValues = () =>
      frameNodes.map((node) =>
        ['x', 'y', 'width', 'height'].map((name) => Number(node.getAttribute(name))),
      );
    const exactFrames = (view) =>
      frameValues().every((values) =>
        values.every(
          (value, index) =>
            Math.abs(value - [view.x, view.y, view.width, view.width / 1.6][index]) < 1e-9,
        ),
      );
    const reservePan = apply.beginPan();
    const reservedFrames = frameValues();
    check(
      reservedFrames.every((values) =>
        values.every((value, index) => value === [-40, -25, 160, 100][index]),
      ),
      'A held pan did not prepare the finite two-viewport reserve.',
    );
    const reservePattern = b.querySelector('[data-layout-grid-pattern]').outerHTML;
    reservePan.update(() => apply({ x: 1, y: 2, width: 80 }, size, false));
    await nextFrame();
    reference({ x: 1, y: 2, width: 80 }, size);
    check(
      JSON.stringify(frameValues()) === JSON.stringify(reservedFrames),
      'An interior pan rewrote its reserved viewport frames.',
    );
    check(matrixError() < 0.0002, 'Reserved frames changed the visible world mapping.');
    check(
      b.querySelector('[data-layout-grid-pattern]').outerHTML === reservePattern,
      'A reserved pan changed world grid metrics.',
    );
    const trackPoint = new DOMPoint(30, 20).matrixTransform(b.getScreenCTM());
    const trackHit = document.elementFromPoint(trackPoint.x, trackPoint.y);
    check(
      b.contains(trackHit) &&
        trackHit.closest('[data-selection-id]')?.dataset.selectionId === 'track',
      'Reserved frames displaced a real track hit.',
    );
    const hostBounds = host.getBoundingClientRect();
    check(
      !b.contains(document.elementFromPoint(hostBounds.left - 1, hostBounds.top + 100)),
      'Reserved frame overflow intercepted input outside the clipped host.',
    );
    const crossed = { x: 50, y: -60, width: 80 };
    reservePan.update(() => apply(crossed, size, false));
    await nextFrame();
    reference(crossed, size);
    check(
      b.getAttribute('viewBox') === '50 -60 80 50' && !b.style.transform,
      'A pan crossed its reserve before performing an exact native rebase.',
    );
    check(
      frameValues().every((values) =>
        values.every((value, index) => value === [10, -85, 160, 100][index]),
      ),
      'Reserve crossing did not recenter bounded frames.',
    );
    check(matrixError() < 0.0002, 'Reserve crossing changed native world coordinates.');
    const reservePNG = await window.captureLayoutPNG(b, { minX: 0, minY: 0, maxX: 80, maxY: 50 });
    nativeHost.style.visibility = 'visible';
    const nativeReservePNG = await window.captureLayoutPNG(a, {
      minX: 0,
      minY: 0,
      maxX: 80,
      maxY: 50,
    });
    check(exactFrames(crossed), 'PNG capture retained expanded viewport frames.');
    check(
      reservePNG.dataUrl === nativeReservePNG.dataUrl,
      'PNG capture changed exported pixels: ' +
        JSON.stringify({
          pixelsEqual: reservePNG.dataUrl === nativeReservePNG.dataUrl,
          framesExact: exactFrames(crossed),
          frames: frameValues(),
          nativeStyle: a.getAttribute('style'),
          actualStyle: b.getAttribute('style'),
          nativeBox: a.getAttribute('viewBox'),
          actualBox: b.getAttribute('viewBox'),
        }),
    );
    const reserveAnnotation = await window.captureAnnotationImage(b, ['track'], annotationBounds);
    const nativeReserveAnnotation = await window.captureAnnotationImage(
      a,
      ['track'],
      annotationBounds,
    );
    check(exactFrames(crossed), 'Annotation capture retained expanded viewport frames.');
    check(
      reserveAnnotation.dataUrl === nativeReserveAnnotation.dataUrl,
      'Annotation capture changed pixels for identical native inputs.',
    );
    reservePan.release();
    const jitterPan = apply.beginPan();
    check(
      !exactFrames(crossed) && !b.style.transform,
      'The no-motion reserve case did not remain on its native camera.',
    );
    jitterPan.release();
    check(
      exactFrames(crossed) && !b.style.transform,
      'Releasing a no-motion pan retained expanded viewport frames.',
    );
    apply.dispose();
    reference.dispose();
    return {
      poses: poses.length,
      hitSamples,
      maximumMatrixError,
      png: 'equal',
      annotations: 'equal',
      lifecycle: 'passed',
      typedReads,
      typedFallbacks: 2,
      nativeReplayStyleReads,
      coalescedInputs,
      queuedPickSamples: pickOffsets.length,
      ownerHandoff: 'passed',
      trackRefresh: 'passed',
      refreshBoundsReads,
      bodyRefreshSamples,
      heldPanCases,
      panReserve: 'coverage, CTM, hit clipping, grid, crossing, PNG, annotation and jitter passed',
    };
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
