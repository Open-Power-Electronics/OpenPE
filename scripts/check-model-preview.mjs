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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/library-model') {
      if (url.searchParams.get('id') === 'Test:Missing')
        return route.fulfill({
          status: 422,
          json: {
            error: 'The linked 3D model is unavailable. The 2D footprint can still be used.',
          },
        });
      return route.fulfill({ json: model });
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
  const before = await preview.screenshot();
  const { data, info } = await sharp(before)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let coloredPixels = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i + 1] > data[i] + 15 && data[i + 1] > data[i + 2] + 15) coloredPixels++;
  assert.ok(coloredPixels > 500, 'The retained canvas must actually render the model.');
  const bounds = await preview.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 20, {
    steps: 8,
  });
  await page.mouse.up();
  assert.notDeepEqual(
    await preview.screenshot(),
    before,
    'Orbit gestures change the rendered view.',
  );
  await page.locator('#root').evaluate((el) => {
    el.style.width = '300px';
  });
  await page.waitForFunction(() => document.querySelector('canvas')?.width === 300);
  await page.evaluate(() => window.preview('Test:Missing'));
  await preview.getByRole('status').filter({ hasText: 'unavailable' }).waitFor();
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
    'PASS: visible 3D mesh after loading, orbit, resize, failure, replacement and unmount.',
  );
} finally {
  await browser.close();
}
