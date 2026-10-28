import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Compare the actual Chromium SVG hit boundary, including the original
// pointer-events=all implicit one-world-unit stroke, against the camera path.
const bundle = await build({
  stdin: {
    contents: `import {applyLayoutCamera,createLayoutCameraApplicator} from './components/LayoutCamera';
      window.applyCamera=applyLayoutCamera;window.bindCamera=createLayoutCameraApplicator;`,
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  await page.setContent(`<style>body{margin:0}.fixture{position:absolute;left:100px;top:80px;width:800px;height:500px}.fixture svg{width:800px;height:500px}</style>
    <div class="fixture" id="old"></div><div class="fixture" id="next"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(() => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg"><rect data-layout-background fill="white"/>
      <g data-selection-id="track"><line data-layout-track-target="0.4" x1="16" y1="20" x2="34" y2="29" stroke="transparent" stroke-width="0.4"/>
      <line x1="16" y1="20" x2="34" y2="29" stroke="red" stroke-width="0.4" stroke-linecap="round"/></g>
      <rect data-footprint-body="body" data-layout-body-bounds="40 15 50 20" fill="transparent" pointer-events="all"/>
      <circle data-layout-via-target="0.3" cx="60" cy="30" fill="transparent"/></svg>`;
    const old = document.getElementById('old'),
      next = document.getElementById('next');
    old.innerHTML = next.innerHTML = markup;
    const a = old.querySelector('svg'),
      b = next.querySelector('svg');
    const apply = window.bindCamera(b, { fixedTargets: true });
    const hit = (element, p) => {
      const target = document.elementFromPoint(p.x, p.y);
      return (
        target?.closest('[data-selection-id]')?.getAttribute('data-selection-id') ||
        target?.getAttribute('data-footprint-body') ||
        null
      );
    };
    const results = [];
    for (const width of [16, 40, 80, 160, 320]) {
      const view = { x: width === 16 ? 36 : 8, y: width === 16 ? 12 : 7, width },
        size = { width: 800, height: 500 };
      window.applyCamera(a, view, size);
      apply(view, size);
      const scale = width / 800,
        samples = [];
      // Off-boundary samples keep IEEE rounding ties separate from an actual
      // changed hit region; +/-0.04 screen pixels must agree on either side.
      const margin = 0.5 + 2 * scale,
        lo = { x: 40 - margin, y: 15 - margin },
        hi = { x: 50 + margin, y: 20 + margin };
      for (const edge of [lo.x, hi.x])
        for (let i = 0; i <= 30; i++)
          for (const offset of [-0.4, -0.04, 0.04, 0.4])
            samples.push({
              x: edge + offset * scale,
              y: lo.y + ((hi.y - lo.y) * (i + 0.371)) / 31,
            });
      for (const edge of [lo.y, hi.y])
        for (let i = 0; i <= 30; i++)
          for (const offset of [-0.4, -0.04, 0.04, 0.4])
            samples.push({
              x: lo.x + ((hi.x - lo.x) * (i + 0.371)) / 31,
              y: edge + offset * scale,
            });
      const length = Math.hypot(18, 9),
        nx = -9 / length,
        ny = 18 / length,
        half = Math.max(0.4, 7 * scale) / 2;
      for (let i = -1; i <= 31; i++)
        for (const sign of [-1, 1])
          for (const offset of [-0.4, -0.04, 0.04, 0.4]) {
            const t = (i + 0.371) / 31;
            samples.push({
              x: 16 + 18 * t + nx * (half + offset * scale) * sign,
              y: 20 + 9 * t + ny * (half + offset * scale) * sign,
            });
          }
      const screen = samples
        .map((p) => new DOMPoint(p.x, p.y).matrixTransform(a.getScreenCTM()))
        .filter((p) => p.x > 101 && p.x < 899 && p.y > 81 && p.y < 579);
      next.style.visibility = 'hidden';
      old.style.visibility = 'visible';
      const expected = screen.map((p) => hit(a, p));
      old.style.visibility = 'hidden';
      next.style.visibility = 'visible';
      const observed = screen.map((p) => hit(b, p));
      results.push({
        width,
        samples: screen.length,
        differences: observed.flatMap((value, i) =>
          value !== expected[i]
            ? [{ ...screen[i].toJSON(), expected: expected[i], observed: value }]
            : [],
        ),
        fixedTrack: b.querySelector('[data-layout-track-target]').dataset.layoutFixedTrack,
        fixedBody: b.querySelector('[data-layout-body-bounds]').dataset.layoutFixedBody,
      });
    }
    // Static CSS scale/skew/rotation must use the exact original dynamic path.
    for (const transform of ['scale(1.1,.8)', 'skewX(12deg)', 'rotate(4deg)']) {
      next.style.transform = transform;
      const applyTransformed = window.bindCamera(b, { fixedTargets: true });
      const view = { x: 8, y: 7, width: 80 },
        size = { width: 800, height: 500 };
      applyTransformed(view, size);
      window.applyCamera(a, view, size);
      results.push({
        transform,
        track:
          b.querySelector('[data-layout-track-target]').outerHTML ===
          a.querySelector('[data-layout-track-target]').outerHTML,
        body:
          b.querySelector('[data-layout-body-bounds]').outerHTML ===
          a.querySelector('[data-layout-body-bounds]').outerHTML,
      });
    }
    return results;
  });
  for (const result of results) {
    if (result.transform) {
      assert.equal(result.track, true, `${result.transform} retains the original track path`);
      assert.equal(result.body, true, `${result.transform} retains the original body path`);
    } else {
      assert.ok(result.samples > 0);
      assert.deepEqual(
        result.differences,
        [],
        `Actual SVG hit regions match at view width ${result.width}`,
      );
      assert.equal(result.fixedTrack, 'true');
      assert.equal(result.fixedBody, 'true');
    }
  }
  console.log(JSON.stringify({ cameraHitDifferential: results }));
} finally {
  await browser.close();
}
