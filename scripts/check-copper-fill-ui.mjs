import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { createReferenceExample } = await tsImport('../lib/reference-examples.ts', import.meta.url);
const { projectFromNativeFiles } = await tsImport('../lib/project.ts', import.meta.url);
const { runPCBDesignRules } = await tsImport('../lib/pcb-drc.ts', import.meta.url);
const fixture = createReferenceExample('reference-tps61046-bga6-boost');
assert.ok(fixture.pcb.zones.every((zone) => zone.clearance === 0));
// Actual Core/renderer and native documents in an isolated browser; no Electron,
// user files, service, provider or solver execution.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';import {ProjectCore} from './core/project-core';
      import {createCapabilityHost} from './api/capabilities';import {registerProjectCapabilities} from './core/register-project';
      function Test(){const [core]=useState(()=>new ProjectCore(window.fixture));
        const [host]=useState(()=>{const host=createCapabilityHost();registerProjectCapabilities(host,core);return host});
        const state=useSyncExternalStore(core.subscribe,core.getSnapshot);
        window.readState=()=>({board:core.getSnapshot().project.pcb,undoDepth:core.getSnapshot().undoDepth,files:core.getSnapshot().sourceDraft===null?core.getNativeFiles():null});
        window.pendingSource=()=>core.updateSource('pending');window.clearSource=()=>core.discardSource();
        return <LayoutEditor board={state.project.pcb} schematic={state.project.schematic} active capabilityHost={host}
          onCommit={board=>core.replaceBoard(board)}
          undoAction={<button aria-label="Undo" disabled={!state.canUndo} onClick={()=>core.undo()}>Undo</button>}
          annotations={[]} annotationSessionId="fill" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
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
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((fixture) => {
    window.fixture = fixture;
  }, fixture);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const state = () => page.evaluate(() => window.readState());
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  const before = await state();
  await button('Fill copper zones').click();
  const panel = page.getByRole('complementary', { name: 'Copper fill settings' });
  const clearance = panel.getByRole('spinbutton', { name: 'Minimum clearance (mm)' });
  assert.equal(await clearance.inputValue(), '0.25');
  assert.equal((await state()).undoDepth, 0);
  await clearance.fill('0');
  await button('Fill zones').click();
  assert.equal((await state()).undoDepth, 0);
  await clearance.fill('0.8');
  await clearance.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 229,
    isComposing: true,
  });
  assert.equal((await state()).undoDepth, 0);
  await clearance.press('Escape');
  assert.equal(await clearance.inputValue(), '0.25');
  await canvas.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal((await state()).undoDepth, 0);
  await button('Fill copper zones').click();
  await clearance.fill('0.4');
  await mkdir('test-results/copper-fill', { recursive: true });
  await page.screenshot({ path: 'test-results/copper-fill/settings.png' });
  await button('Fill zones').click();
  await panel.waitFor({ state: 'hidden' });
  const filled = await state();
  assert.equal(filled.undoDepth, 1);
  assert.ok(
    filled.board.zones.every((zone) => zone.clearance === 0.4 && zone.filledPolygons !== undefined),
  );
  const reopened = projectFromNativeFiles(filled.files);
  assert.ok(
    reopened.pcb.zones.every((zone) => zone.clearance === 0.4 && zone.filledPolygons !== undefined),
  );
  assert.deepEqual(
    runPCBDesignRules(reopened.pcb).issues.filter((issue) =>
      ['pcb.short', 'pcb.clearance'].includes(issue.ruleId),
    ),
    [],
  );
  await page.screenshot({ path: 'test-results/copper-fill/filled.png' });
  await button('Fill copper zones').click();
  assert.equal(await clearance.inputValue(), '0.4', 'Accepted preference survives reopening.');
  await clearance.fill('0.8');
  await page.evaluate(() => window.pendingSource());
  await button('Fill zones').click();
  await page
    .getByRole('alert')
    .getByText('Apply the Source edits before changing the project.')
    .waitFor();
  assert.equal((await state()).undoDepth, 1);
  assert.deepEqual((await state()).board, filled.board);
  await page.evaluate(() => window.clearSource());
  await button('Close tool settings').click();
  await button('Undo').click();
  assert.deepEqual((await state()).board, before.board);
  assert.deepEqual(errors, []);
  console.log(
    'Copper fill settings, invalid/IME/cancel input, actual Core fill, native clearance/contours, Source guards and one-edit undo passed.',
  );
} finally {
  await browser.close();
}
