import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import nativeProject from '../electron/native-project.cjs';
import { projectFromNativeFiles, serializeProject } from '../server/project-format.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Isolated renderer using actual native files; no Electron, Git, solvers or providers.
const sources = [];
for (const stem of ['lm5001-soic8-boost', 'tps61046-bga6-boost']) {
  const native = await nativeProject.readNativeProject(
    path.resolve('examples', stem, `${stem}.kicad_pro`),
  );
  sources.push(serializeProject(projectFromNativeFiles(native)));
}
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import Dialog from './components/Dialog';
      import Comparison from './components/SchematicComparison';
      const root = createRoot(document.getElementById('root'));
      let state = {};
      window.renderComparison = (next) => {
        state = {...state, ...next};
        flushSync(() => root.render(<Dialog title="Git" className="project-history-dialog" open={state.open}
          onClose={() => window.renderComparison({open: false})}>
          <section className="project-history-view">
            <Comparison active={state.open} beforeSource={state.source} afterSource={state.source}
              beforeLabel="init" afterLabel="Worktree"/>
          </section>
        </Dialog>));
      };
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
let page;
const errors = [];
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const comparison = page.getByRole('region', { name: 'Schematic comparison', exact: true });
  const drawings = comparison.locator('svg[role="img"]');
  async function checkFitted() {
    await waitForAsync(
      page,
      () => {
        const svgs = [...document.querySelectorAll('.schematic-compare-pane > svg')];
        return (
          svgs.length === 2 &&
          svgs.every((svg) => {
            const drawing = svg.lastElementChild;
            const box = drawing.getBBox();
            const view = svg.viewBox.baseVal;
            const bounds = svg.getBoundingClientRect();
            return (
              bounds.width > 100 &&
              bounds.height > 100 &&
              box.width > 0 &&
              box.height > 0 &&
              view.x <= box.x &&
              view.y <= box.y &&
              view.x + view.width >= box.x + box.width &&
              view.y + view.height >= box.y + box.height
            );
          })
        );
      },
      undefined,
      { timeout: 5000 },
    );
    assert.equal(
      await drawings.nth(0).getAttribute('viewBox'),
      await drawings.nth(1).getAttribute('viewBox'),
    );
    await comparison.getByText('No schematic changes', { exact: true }).waitFor();
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    // The comparison mounts synchronously inside a closed dialog, before showModal.
    await page.evaluate((source) => window.renderComparison({ open: true, source }), sources[0]);
    await checkFitted();
    await page.screenshot({ path: `test-results/schematic-comparison-native-${theme}.png` });
    const fitted = await drawings.nth(0).getAttribute('viewBox');
    await comparison.getByRole('button', { name: 'Zoom in comparison', exact: true }).click();
    const zoomed = await drawings.nth(0).getAttribute('viewBox');
    assert.notEqual(zoomed, fitted);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.evaluate(() => window.renderComparison({ open: true }));
    await comparison.waitFor();
    assert.equal(
      await drawings.nth(0).getAttribute('viewBox'),
      zoomed,
      'Reopening preserves the camera.',
    );
    await comparison.getByRole('button', { name: 'Fit comparison', exact: true }).click();
    await checkFitted();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.evaluate((source) => window.renderComparison({ source }), sources[1]);
    await page.evaluate(() => window.renderComparison({ open: true }));
    await checkFitted();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: native LM5001/TPS61046 unchanged comparisons fit after dialog reveal, remain visible in both themes, preserve cameras on reopen and fit hidden project changes.',
  );
} catch (error) {
  if (page) {
    console.error(errors);
    await page.screenshot({ path: 'test-results/schematic-comparison-native-failure.png' });
    console.error(
      await page.locator('.schematic-compare-pane > svg').evaluateAll((svgs) =>
        svgs.map((svg) => {
          const { x, y, width, height } = svg.lastElementChild.getBBox();
          return { view: svg.getAttribute('viewBox'), bounds: { x, y, width, height } };
        }),
      ),
    );
  }
  throw error;
} finally {
  await browser.close();
}
