import { setLayoutVisibility } from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { parseProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const project = parseProject(
  await readFile('tests/fixtures/reference/lm27761-wson8-pump.json', 'utf8'),
);
const source = serializeProject(project);
const fixture = { board: project.pcb, schematic: project.schematic };
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      createRoot(document.getElementById('root')).render(<LayoutEditor
        board={window.fixture.board} schematic={window.fixture.schematic} active grid={false}
        onCommit={()=>{window.commits++;return false}}
        annotations={[]} annotationSessionId="components" onAnnotationsChange={()=>{}}/>);`,
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
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((fixture) => {
    window.fixture = fixture;
    window.commits = 0;
  }, fixture);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const pads = fixture.board.footprints.flatMap((f) => f.pads);
  const expectedNets = pads.filter((p) => p.type !== 'np_thru_hole' && p.netId).length;
  assert.equal(await canvas.locator('[data-pad-label="net"]').count(), expectedNets);
  assert.equal(
    await canvas.locator('[data-pad-label="number"]').count(),
    pads.filter((p) => p.type !== 'np_thru_hole' && p.number).length,
  );
  for (const f of fixture.board.footprints) {
    const ref = fixture.schematic.parts.find((p) => p.id === f.symbolId)?.ref ?? f.reference;
    const captions = canvas.locator(`[data-footprint-captions="${f.id}"]`);
    assert.equal(
      await captions.getByText(ref, { exact: true }).count(),
      2,
      `${ref}: silk and fabrication references are visible.`,
    );
    assert.ok(
      !(await captions.textContent().then((s) => s.includes('${'))),
      'Display variables are resolved.',
    );
  }
  // Check real SVG glyph extents and composed rotations, rather than just the helper's estimates.
  const geometry = await canvas.evaluate((svg) => {
    const failures = [];
    for (const label of svg.querySelectorAll('[data-pad-label], [data-footprint-captions] text')) {
      const matrix = label.getCTM();
      const angle = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
      if (angle < -90.01 || angle > 90.01)
        failures.push(`Upside down: ${label.textContent} (${angle})`);
      const group = label.closest('[data-pad-id]');
      if (!group) continue;
      const pad = window.fixture.board.footprints
        .flatMap((f) => f.pads)
        .find((p) => p.id === group.dataset.padId);
      const box = label.getBBox();
      const local = group.getCTM().inverse().multiply(matrix);
      for (const x of [box.x, box.x + box.width])
        for (const y of [box.y, box.y + box.height]) {
          const p = new DOMPoint(x, y).matrixTransform(local);
          if (Math.abs(p.x) > pad.size.x / 2 + 0.01 || Math.abs(p.y) > pad.size.y / 2 + 0.01)
            failures.push(`Outside pad: ${label.textContent}`);
        }
    }
    return failures;
  });
  assert.deepEqual(geometry, []);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) =>
        document.documentElement.style.setProperty(
          '--canvas',
          theme === 'dark' ? '#181818' : '#ffffff',
        ),
      theme,
    );
    await page.locator(`[data-layout-editor][data-pcb-theme="${theme}"]`).waitFor();
    await button('Fit board to canvas').click();
    await page.screenshot({ path: `test-results/openpe-layout-components-${theme}.png` });
  }
  await setLayoutVisibility(page, 'Pad numbers', false);
  assert.equal(await canvas.locator('[data-pad-label="number"]').count(), 0);
  assert.equal(await canvas.locator('[data-pad-label="net"]').count(), expectedNets);
  await setLayoutVisibility(page, 'Pad numbers', true);
  await setLayoutVisibility(page, 'Pad net names', false);
  assert.equal(await canvas.locator('[data-pad-label="net"]').count(), 0);
  assert.ok((await canvas.locator('[data-pad-label="number"]').count()) > 0);
  await setLayoutVisibility(page, 'Pad net names', true);
  await setLayoutVisibility(page, 'F.Fab', false);
  assert.equal(
    await canvas.locator('[data-footprint-captions]').first().locator('text').count(),
    1,
  );
  await setLayoutVisibility(page, 'F.Fab', true);
  await setLayoutVisibility(page, 'Footprints', false);
  assert.equal(await canvas.locator('[data-pad-id], [data-footprint-captions]').count(), 0);
  await setLayoutVisibility(page, 'Footprints', true);
  const beforeZoom = await canvas.locator('[data-pad-label]').allTextContents();
  await button('Actual size (100%)').click();
  await page.setViewportSize({ width: 1100, height: 760 });
  assert.deepEqual(await canvas.locator('[data-pad-label]').allTextContents(), beforeZoom);
  assert.equal(await page.evaluate(() => window.commits), 0);
  assert.deepEqual(await page.evaluate(() => window.fixture), fixture);
  assert.equal(serializeProject(project), source);
  assert.deepEqual(errors, []);
  console.log(
    'Layout components: fitted pad numbers/nets, upright silk/Fab captions, independent visibility, light/dark rendering and unchanged design data.',
  );
} finally {
  await browser.close();
}
