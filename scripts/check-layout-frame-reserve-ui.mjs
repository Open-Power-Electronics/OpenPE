import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp from 'sharp';

// Opt-in isolated browser correctness. This is not an interaction benchmark.
const bundle = await build({
  stdin: {
    contents: `import { createLayoutCameraApplicator } from './components/LayoutCamera';
      import { captureLayoutPNG } from './lib/drawing-export';
      import { captureAnnotationImage } from './lib/annotation-screenshot';
      Object.assign(window,{bindCamera:createLayoutCameraApplicator,captureLayoutPNG,captureAnnotationImage});`,
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
// Compare the existing compositor, the finite reserve, and a pure native SVG.
const reports = [];
const label = process.argv[2] ?? 'current';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const evidencePrefix = `test-results/layout-frame-reserve-${label}`;
await mkdir('test-results', { recursive: true });
try {
  for (const dpr of [1, 2]) {
    const report = { dpr, cases: [] };
    reports.push(report);
    const context = await browser.newContext({
      viewport: { width: 930, height: 650 },
      deviceScaleFactor: dpr,
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setContent(`<style>body{margin:0;background:#eee;--canvas:#fff;--grid-dot:#999}
        .host{position:absolute;left:31.25px;top:40.5px;width:800px;height:500px}
        svg{display:block;width:100%;height:100%;overflow:hidden}</style>
        <div class="host" id="reference"></div><div class="host" id="candidate"></div>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(() => {
        const markup = (id) => `<svg xmlns="http://www.w3.org/2000/svg">
          <defs><pattern id="${id}-grid" data-layout-grid-pattern data-layout-grid-spacing=".5" patternUnits="userSpaceOnUse"><circle fill="#aaa"/></pattern></defs>
          <rect data-layout-background fill="white"/>
          <rect data-layout-grid fill="url(#${id}-grid)" pointer-events="none"/>
          <g data-layout-drawing><g data-selection-id="track">
          <line data-layout-track-target=".4" data-hit="track" x1="1" y1="4" x2="40" y2="20" stroke="transparent" stroke-width=".4"/>
          <line x1="1" y1="4" x2="40" y2="20" stroke="red" stroke-width=".4"/></g>
          <line x1="-40" y1="0" x2="140" y2="50" stroke="#086" stroke-width=".3"/>
          <line x1="25" y1="35" x2="40" y2="35" stroke="blue" stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>
          <text x="30" y="43" font-size="2">Retained vector captions</text></g>
          <rect data-layout-interaction-surface fill="transparent" pointer-events="none"/></svg>`;
        const referenceHost = document.querySelector('#reference');
        const candidateHost = document.querySelector('#candidate');
        referenceHost.innerHTML = markup('reference');
        candidateHost.innerHTML = markup('candidate');
        const reference = referenceHost.querySelector('svg');
        const candidate = candidateHost.querySelector('svg');
        const nativeHost = document.createElement('div');
        nativeHost.className = 'host';
        nativeHost.innerHTML = markup('native');
        document.body.append(nativeHost);
        const native = nativeHost.querySelector('svg');
        const nativeCamera = window.bindCamera(native, { fixedTargets: true });
        // Hold only the camera idle callback to inspect actual transient pixels.
        // Production timing and the desktop benchmark remain unchanged.
        const nativeTimeout = window.setTimeout;
        const nativeClear = window.clearTimeout;
        let nextTimer = -1;
        const idle = new Map();
        window.setTimeout = (callback, delay, ...args) => {
          if (delay !== 120) return nativeTimeout(callback, delay, ...args);
          const id = nextTimer--;
          idle.set(id, () => callback(...args));
          return id;
        };
        window.clearTimeout = (id) => idle.delete(id) || nativeClear(id);
        const size = { width: 800, height: 500 };
        const plain = window.bindCamera(reference, { fixedTargets: true, compositor: true });
        const retained = window.bindCamera(candidate, {
          fixedTargets: true,
          compositor: true,
          frameReserve: true,
        });
        const frames = () =>
          [
            ...candidate.querySelectorAll(
              '[data-layout-background],[data-layout-grid],[data-layout-interaction-surface]',
            ),
          ].map((n) => ['x', 'y', 'width', 'height'].map((k) => Number(n.getAttribute(k))));
        const show = (which) => {
          referenceHost.style.visibility = which === 'reference' ? 'visible' : 'hidden';
          candidateHost.style.visibility = which === 'candidate' ? 'visible' : 'hidden';
          nativeHost.style.visibility = which === 'native' ? 'visible' : 'hidden';
        };
        const check = (value, message) => {
          if (!value) throw new Error(message);
        };
        window.fixture = {
          reference,
          candidate,
          plain,
          retained,
          frames,
          show,
          size,
          check,
          advance(view, flush = false) {
            nativeCamera(view, size);
            plain(view, size);
            retained(view, size);
            if (flush) {
              plain.flush();
              retained.flush();
            }
            const a = reference.getScreenCTM(),
              b = candidate.getScreenCTM();
            check(
              ['a', 'b', 'c', 'd', 'e', 'f'].every((k) => Math.abs(a[k] - b[k]) < 0.0002),
              'World coordinate matrix changed.',
            );
            check(
              frames().every((f) => f[2] <= view.width * 4 && f[3] <= (view.width / 1.6) * 4),
              'Reserve exceeds four viewport dimensions.',
            );
            const edgePoints = [
              [30.25, 140.5],
              [832.25, 140.5],
              [130.25, 39.5],
              [130.25, 541.5],
            ];
            show('reference');
            const expectedEdges = edgePoints.map(([x, y]) =>
              reference.contains(document.elementFromPoint(x, y)),
            );
            show('candidate');
            edgePoints.forEach(([x, y], i) =>
              check(
                candidate.contains(document.elementFromPoint(x, y)) === expectedEdges[i],
                `Frame reserve changed native edge hit at ${x},${y}`,
              ),
            );
            for (const [x, y] of [
              [28.25, 140.5],
              [834.25, 140.5],
              [130.25, 37.5],
              [130.25, 543.5],
            ])
              check(
                !candidate.contains(document.elementFromPoint(x, y)),
                'Reserve intercepted a point outside the host.',
              );
            return {
              frames: frames(),
              nativeBox: candidate.getAttribute('viewBox'),
              transient: candidate.hasAttribute('data-layout-camera-view'),
              viewport: candidateHost.getBoundingClientRect().toJSON(),
            };
          },
          runIdle() {
            const callbacks = [...idle.values()];
            idle.clear();
            callbacks.forEach((f) => f());
          },
          dispose() {
            plain.dispose();
            retained.dispose();
            window.setTimeout = nativeTimeout;
            window.clearTimeout = nativeClear;
          },
        };
      });
      const poses = [
        { label: 'initial', view: { x: 0, y: 0, width: 80 }, flush: true },
        { label: 'pan', view: { x: 1.5, y: 2.1, width: 80 } },
        { label: 'zoom-in', view: { x: 4, y: 3, width: 80 / 1.12 } },
        { label: 'zoom-out', view: { x: -3, y: -2, width: 85 } },
        { label: 'idle', view: { x: -3, y: -2, width: 85 }, idle: true },
        { label: 'crossing', view: { x: 55, y: -65, width: 85 }, flush: true },
        { label: 'deep-zoom', view: { x: 28, y: 18, width: 8 }, flush: true },
        { label: 'wide-view', view: { x: -600, y: -400, width: 2000 }, flush: true },
      ];
      const cases = report.cases;
      const comparePixels = async (label, state) => {
        const shots = [];
        for (const which of ['reference', 'candidate', 'native']) {
          await page.evaluate((which) => window.fixture.show(which), which);
          shots.push(
            await page.screenshot({
              path: `${evidencePrefix}-${dpr}-${label}-${which}.png`,
            }),
          );
        }
        const pixels = await Promise.all(
          shots.map((shot) => sharp(shot).ensureAlpha().raw().toBuffer()),
        );
        assert.equal(pixels[0].length, pixels[1].length);
        let changed = 0,
          maximum = 0,
          excessPixels = 0,
          nativeEdgeImprovementPixels = 0;
        for (let i = 0; i < pixels[0].length; i += 4) {
          let difference = 0;
          for (let c = 0; c < 4; c++)
            difference = Math.max(difference, Math.abs(pixels[0][i + c] - pixels[1][i + c]));
          if (difference) changed++;
          if (pixels[0][i + 3] !== pixels[1][i + 3]) excessPixels++;
          if (difference > 1) {
            const x = (i / 4) % (930 * dpr),
              y = Math.floor(i / 4 / (930 * dpr));
            const { left, right, top, bottom } = state.viewport;
            const bounds = [
              Math.floor(left * dpr),
              Math.ceil(right * dpr) - 1,
              Math.floor(top * dpr),
              Math.ceil(bottom * dpr) - 1,
            ];
            const edge =
              x >= bounds[0] &&
              x <= bounds[1] &&
              y >= bounds[2] &&
              y <= bounds[3] &&
              (x === bounds[0] || x === bounds[1] || y === bounds[2] || y === bounds[3]);
            const errors = [0, 1, 2].map((c) => [
              Math.abs(pixels[0][i + c] - pixels[2][i + c]),
              Math.abs(pixels[1][i + c] - pixels[2][i + c]),
            ]);
            const improvesNative =
              errors.every(([oldError, newError]) => newError <= 1 && newError <= oldError) &&
              errors.some(([oldError, newError]) => newError < oldError);
            // At a fractional clip edge the old camera can attenuate twice.
            // A change beyond one 8-bit rounding step must be confined to that
            // single pixel boundary and move toward pure native, within its
            // one-step raster tolerance in every channel.
            if (state.transient && edge && difference <= 3 && improvesNative)
              nativeEdgeImprovementPixels++;
            else excessPixels++;
          }
          maximum = Math.max(maximum, difference);
        }
        const compareNative = (left) => {
          let changed = 0,
            max = 0,
            edgeChanged = 0,
            edgeMax = 0,
            interiorMax = 0;
          let minX = Infinity,
            minY = Infinity,
            maxX = -1,
            maxY = -1;
          for (let i = 0; i < pixels[left].length; i += 4) {
            let diff = 0;
            for (let c = 0; c < 4; c++)
              diff = Math.max(diff, Math.abs(pixels[left][i + c] - pixels[2][i + c]));
            const x = (i / 4) % (930 * dpr),
              y = Math.floor(i / 4 / (930 * dpr));
            const edge = x < 32 * dpr || x > 830 * dpr || y < 42 * dpr || y > 539 * dpr;
            if (diff) {
              changed++;
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
              minY = Math.min(minY, y);
              maxY = Math.max(maxY, y);
            }
            max = Math.max(max, diff);
            if (edge) {
              if (diff) edgeChanged++;
              edgeMax = Math.max(edgeMax, diff);
            } else interiorMax = Math.max(interiorMax, diff);
          }
          return {
            changed,
            max,
            edgeChanged,
            edgeMax,
            interiorMax,
            bounds: [minX, minY, maxX, maxY],
          };
        };
        cases.push({
          label,
          state,
          changedPixels: changed,
          maximumChannelDifference: maximum,
          excessPixels,
          nativeEdgeImprovementPixels,
          originalCompositorVsNative: compareNative(0),
          reserveVsNative: compareNative(1),
        });
        // Preserve every raster difference. One 8-bit rounding step is allowed;
        // larger transient edge changes must improve toward pure native SVG.
        assert.ok(
          excessPixels === 0,
          `DPR ${dpr} ${label}: frame reserve changed rendered pixels (${changed}, max ${maximum})`,
        );
      };
      for (const { label, view, flush, idle } of poses) {
        const state = await page.evaluate(
          ({ view, flush, idle }) => {
            const f = window.fixture;
            const state = f.advance(view, flush);
            if (idle) {
              f.runIdle();
              f.check(
                !f.candidate.hasAttribute('data-layout-camera-view'),
                'Idle did not restore native camera.',
              );
            }
            return {
              ...state,
              frames: f.frames(),
              nativeBox: f.candidate.getAttribute('viewBox'),
              transient: f.candidate.hasAttribute('data-layout-camera-view'),
            };
          },
          { view, flush, idle },
        );
        await comparePixels(label, state);
      }
      const captures = await page.evaluate(async () => {
        const f = window.fixture;
        const view = { x: 0, y: 0, width: 80 };
        f.advance(view, true);
        const before = JSON.stringify(f.frames());
        const bounds = { x: -4, y: -3, width: 9, height: 8 };
        f.show('reference');
        const a = await window.captureAnnotationImage(f.reference, ['track'], bounds);
        const pa = await window.captureLayoutPNG(f.reference, {
          minX: -10,
          minY: -10,
          maxX: 90,
          maxY: 60,
        });
        f.show('candidate');
        const b = await window.captureAnnotationImage(f.candidate, ['track'], bounds);
        const pb = await window.captureLayoutPNG(f.candidate, {
          minX: -10,
          minY: -10,
          maxX: 90,
          maxY: 60,
        });
        f.check(
          a.dataUrl === b.dataUrl,
          'Edge annotation exposed reserve grid pixels outside native viewport.',
        );
        f.check(pa.dataUrl === pb.dataUrl, 'PNG export differs from native camera.');
        f.check(before === JSON.stringify(f.frames()), 'Capture mutated live reserved frames.');
        f.check(
          f.frames().every((frame) => frame[2] > view.width),
          'Capture unexpectedly discarded prepared reserve.',
        );
        return {
          annotation: 'identical',
          png: 'identical',
          liveReserve: 'preserved',
        };
      });
      report.captures = captures;
      // A synchronous capture/pick can run after CSS resize but before the
      // editor's ResizeObserver supplies a new size to the camera binding.
      const resized = await page.evaluate(() => {
        const f = window.fixture;
        document.querySelectorAll('.host').forEach((host) => (host.style.width = '850px'));
        f.plain.flush();
        f.retained.flush();
        return {
          frames: f.frames(),
          nativeBox: f.candidate.getAttribute('viewBox'),
          viewport: f.candidate.parentElement.getBoundingClientRect().toJSON(),
        };
      });
      await comparePixels('resize-before-size-commit', resized);
      report.dispose = await page.evaluate(() => {
        const f = window.fixture;
        f.dispose();
        f.check(
          f.frames().every((frame) => frame[2] === 80),
          'Dispose retained expanded frames.',
        );
        return 'exact';
      });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log(JSON.stringify(reports));
} catch (error) {
  reports.push({ failure: error.stack ?? String(error) });
  throw error;
} finally {
  try {
    await writeFile(`${evidencePrefix}-ui.json`, JSON.stringify(reports, null, 2));
  } finally {
    await browser.close();
  }
}
