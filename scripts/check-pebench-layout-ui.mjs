import { toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { parseProject } from '../lib/project.ts';

// Isolated renderer only: no Electron, native grants, provider or local service.
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import LayoutEditor from './components/LayoutEditor';function Test(){const [board,setBoard]=useState(window.fixture.pcb);return <LayoutEditor leftButtonDrag="drag-any" board={board} schematic={window.fixture.schematic} active onCommit={next=>{window.lastBoard=next;window.commits++;setBoard(next);return true}} annotations={[]} annotationSessionId="fixture" onAnnotationsChange={()=>{}}/>}createRoot(document.getElementById('root')).render(<Test/>);`,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
await mkdir('test-results/pebench-layout', { recursive: true });
try {
  for (const id of ['pebench-buck-ap63357', 'pebench-motor-shield-v2']) {
    const project = parseProject(
      await readFile(`tests/fixtures/pebench/${id}.openpe.json`, 'utf8'),
    );
    const page = await browser.newPage({ viewport: { width: 1460, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://localhost/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
    );
    await page.goto('http://localhost');
    await page.evaluate((project) => {
      window.fixture = project;
      window.lastBoard = project.pcb;
      window.commits = 0;
    }, project);
    for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    await page.addStyleTag({
      content: 'html,body,#root{height:100%;margin:0}.layout-editor{height:100%}',
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.getByTestId('layout-canvas');
    await canvas.waitFor({ timeout: 15000 }).catch((error) => {
      throw new Error(`${error.message}; page errors: ${errors.join('; ')}`);
    });
    await page.getByRole('button', { name: 'Fit board to canvas', exact: true }).click();
    assert.equal(
      await canvas.evaluate(
        (svg) =>
          new Set(
            [...svg.querySelectorAll('.layout-footprint')].map((group) =>
              group.getAttribute('data-selection-id'),
            ),
          ).size,
      ),
      project.pcb.footprints.length,
    );
    assert.equal(
      await page.locator('[data-pad-id]').count(),
      project.pcb.footprints.reduce((n, f) => n + f.pads.length, 0),
    );
    assert.equal(await page.evaluate(() => window.commits), 0, 'Viewing a board does not edit it.');
    if (project.pcb.layers.length === 4) {
      await toggleLayoutVisualization(page, 'Visible layers');
      await page.getByRole('checkbox', { name: 'In1.Cu', exact: true }).uncheck();
      await page.getByRole('checkbox', { name: 'In1.Cu', exact: true }).check();
      await toggleLayoutVisualization(page, 'Visible layers');
    }
    await page.screenshot({ path: `test-results/pebench-layout/${id}.png` });
    const target = project.pcb.footprints.find((f) => f.pads.some((p) => p.netId));
    const svg = page.locator(`[data-selection-id="${target.id}"]`).first();
    const box = await svg.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 3 });
    await page.mouse.up();
    const after = await page.evaluate(() => window.lastBoard);
    assert.equal(
      await page.evaluate(() => window.commits),
      1,
      'A footprint drag commits one board transaction.',
    );
    assert.notDeepEqual(
      after.footprints,
      project.pcb.footprints,
      'Dragging changes the editable board.',
    );
    assert.deepEqual(
      after.tracks,
      project.pcb.tracks,
      'Moving a footprint preserves routed copper.',
    );
    assert.deepEqual(after.vias, project.pcb.vias);
    assert.deepEqual(after.zones, project.pcb.zones);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PEBench heavy-artwork and four-layer layouts rendered; layer toggles and footprint interaction preserve copper.',
  );
} finally {
  await browser.close();
}
