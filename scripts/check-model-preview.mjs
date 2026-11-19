import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { BoxGeometry } from 'three';
import sharp from 'sharp';

// Isolated renderer coverage: mocked service, no Electron or user workspace.
const geometry = new BoxGeometry(3, 2, 1);
const model = {
  meshes: [
    {
      color: [0.1, 0.35, 0.15],
      attributes: {
        position: { array: Array.from(geometry.attributes.position.array) },
        normal: { array: Array.from(geometry.attributes.normal.array) },
      },
      index: { array: Array.from(geometry.index.array) },
      brep_faces: [{ first: 0, last: geometry.index.count / 3 - 1, color: null }],
    },
  ],
};
geometry.dispose();
const bundle = await build({
  stdin: {
    contents: `import React from 'react';
      import {createRoot} from 'react-dom/client';
      import ModelPreview from './components/ModelPreview';
      const root = createRoot(document.getElementById('root'));
      window.preview = id => root.render(id ? <ModelPreview id={id} index={0}/> : null);
      window.preview('Test:First');`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  let releasePending;
  const pending = new Promise((resolve) => {
    releasePending = resolve;
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (['/brand/openpe-mark.svg', '/brand/openpe-signal.svg'].includes(url.pathname))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: await readFile('public' + url.pathname),
      });
    if (url.pathname === '/api/library-model') {
      if (url.searchParams.get('id') === 'Test:Pending') await pending;
      if (url.searchParams.get('id') === 'Test:Missing')
        return route.fulfill({
          status: 422,
          json: {
            error: 'The linked 3D model is unavailable. The 2D footprint can still be used.',
          },
        });
      return route.fulfill({
        json: {
          ...model,
          model: {
            path: 'Fixture.step',
            rotate: [
              'rotate',
              ['xyz', '0', '0', url.searchParams.get('id') === 'Test:Rotated' ? '90' : '0'],
            ],
          },
        },
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<div id="root" style="width:450px"></div>',
    });
  });
  await page.goto('http://localhost/');
  await page.addStyleTag({
    content: `${await readFile('app/globals.css', 'utf8')}\n${await readFile('app/workspace.css', 'utf8')}`,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const preview = page.locator('.model-preview');
  const ready = async () => {
    await preview.waitFor();
    await page.waitForFunction(() => {
      const host = document.querySelector('.model-preview');
      const canvas = host?.querySelector('canvas');
      return !host?.querySelector('[role="status"]') && canvas?.width > 0 && canvas?.height > 0;
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await preview.locator('canvas').count(),
      1,
      'Loading completion must retain exactly one WebGL canvas.',
    );
  };
  await ready();
  await page.evaluate(() => window.preview('Test:Pending'));
  const loading = preview.getByRole('status', { name: 'Loading 3D model…', exact: true });
  await loading.waitFor();
  const logo = loading.locator('img');
  assert.equal(await logo.getAttribute('src'), '/brand/openpe-mark.svg');
  const indicator = loading.locator('.loading-signal');
  const animation = () => indicator.evaluate((el) => getComputedStyle(el, '::after').animationName);
  assert.equal(await animation(), 'loading-signal-flow');
  const panelBounds = await preview.boundingBox();
  const markBounds = await loading.locator('.loading-content').boundingBox();
  assert.ok(
    Math.abs(markBounds.x + markBounds.width / 2 - panelBounds.x - panelBounds.width / 2) < 1,
  );
  assert.ok(
    Math.abs(markBounds.y + markBounds.height / 2 - panelBounds.y - panelBounds.height / 2) < 1,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.motion = 'reduced';
  });
  assert.equal(await animation(), 'none');
  await page.evaluate(() => {
    document.documentElement.dataset.motion = 'full';
    document.documentElement.dataset.theme = 'dark';
  });
  assert.equal(await logo.getAttribute('src'), '/brand/openpe-mark.svg');
  await mkdir('test-results', { recursive: true });
  await preview.screenshot({ path: 'test-results/model-loading-dark.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  assert.equal(await logo.getAttribute('src'), '/brand/openpe-mark.svg');
  releasePending();
  await ready();
  const before = await preview.screenshot();
  const { data, info } = await sharp(before)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let coloredPixels = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i + 1] > data[i] + 15 && data[i + 1] > data[i + 2] + 15) coloredPixels++;
  assert.ok(coloredPixels > 500, 'The retained canvas must actually render the model.');
  await page.evaluate(() => window.preview('Test:Rotated'));
  await ready();
  const rotated = await preview.screenshot();
  assert.notDeepEqual(rotated, before, 'The library preview applies the declared native rotation.');
  const bounds = await preview.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 20, {
    steps: 8,
  });
  await page.mouse.up();
  assert.notDeepEqual(
    await preview.screenshot(),
    rotated,
    'Orbit gestures change the rendered view.',
  );
  const beforeResize = await preview.locator('canvas').evaluate((canvas) => canvas.width);
  await page.locator('#root').evaluate((el) => {
    el.style.width = '300px';
  });
  await page.waitForFunction((previous) => {
    const host = document.querySelector('.model-preview-canvas');
    const canvas = host?.querySelector('canvas');
    return (
      canvas?.width > 0 &&
      canvas.width < previous &&
      canvas.width === Math.floor(host.clientWidth * Math.min(devicePixelRatio, 2))
    );
  }, beforeResize);
  await page.evaluate(() => window.preview('Test:Missing'));
  await preview.getByRole('alert').filter({ hasText: 'unavailable' }).waitFor();
  assert.equal(
    await preview.getByRole('button', { name: 'Retry preview', exact: true }).isVisible(),
    true,
  );
  assert.equal(
    await preview.locator('canvas').count(),
    0,
    'Failed replacements remove the previous model.',
  );
  await page.evaluate(() => window.preview('Test:Second'));
  await ready();
  await mkdir('test-results', { recursive: true });
  await preview.screenshot({ path: 'test-results/model-preview.png' });
  await page.evaluate(() => window.preview(null));
  await preview.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: centered animated Signal E loading, reduced motion, visible 3D mesh, orbit, resize, failure/retry control, replacement and unmount.',
  );
} finally {
  await browser.close();
}
