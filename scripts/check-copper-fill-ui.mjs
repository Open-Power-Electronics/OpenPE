import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { createReferenceExample } = await tsImport('../lib/reference-examples.ts', import.meta.url);
const { projectFromNativeFiles } = await tsImport('../lib/project.ts', import.meta.url);
const { runPCBDesignRules } = await tsImport('../lib/pcb-drc.ts', import.meta.url);
const fixture = structuredClone(createReferenceExample('reference-tps61046-bga6-boost'));
// Explicit inherited-clearance fixture; current Home defaults may already carry fills/rules.
fixture.pcb.zones = fixture.pcb.zones.map(({ filledPolygons: _filled, ...zone }) => ({
  ...zone,
  clearance: 0,
  fillEnabled: false,
}));
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
  assert.equal(await button('Fill copper zones').count(), 0);
  const zoneId = before.board.zones[0].id;
  const outline = before.board.zones[0].outline;
  const at = outline[0],
    next = outline[1];
  const screen = await canvas.evaluate(
    (svg, at) => {
      const p = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM());
      return { x: p.x, y: p.y };
    },
    { x: (at.x + next.x) / 2, y: (at.y + next.y) / 2 },
  );
  await page.mouse.click(screen.x, screen.y);
  const panel = page.getByRole('complementary', { name: 'Layout properties' });
  const filledToggle = panel.getByRole('checkbox', { name: 'Filled', exact: true });
  await filledToggle.waitFor();
  assert.equal(await filledToggle.isChecked(), false);
  const clearance = panel.getByRole('spinbutton', { name: 'Clearance (mm)', exact: true });
  await clearance.fill('0.4');
  await clearance.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 229,
    isComposing: true,
  });
  assert.equal((await state()).undoDepth, 0, 'Composing input cannot change fill rules.');
  await clearance.press('Escape');
  assert.equal(await clearance.inputValue(), '0');
  await clearance.fill('0.4');
  await clearance.press('Enter');
  assert.equal((await state()).undoDepth, 1);
  const fill = panel.getByRole('button', { name: 'Fill zone', exact: true });
  await fill.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  await panel.dispatchEvent('compositionstart');
  await fill.click();
  assert.equal((await state()).undoDepth, 1, 'Composing input cannot fill copper.');
  await panel.dispatchEvent('compositionend');
  await fill.press('Space');
  await page.waitForFunction(
    (id) => window.readState().board.zones.find((z) => z.id === id).filledPolygons !== undefined,
    zoneId,
  );
  const filled = await state();
  assert.equal(filled.undoDepth, 2);
  assert.equal(
    await panel.getByRole('button', { name: 'Refill zone', exact: true }).isEnabled(),
    true,
  );
  const selected = filled.board.zones.find((z) => z.id === zoneId);
  assert.equal(selected.clearance, 0.4);
  assert.equal(selected.fillEnabled, true);
  assert.ok(selected.filledPolygons.length);
  for (const zone of filled.board.zones.filter((z) => z.id !== zoneId))
    assert.equal(zone.filledPolygons, undefined);
  const reopened = projectFromNativeFiles(filled.files);
  const nativeZones = (board) =>
    board.zones.map(({ netId, ...zone }) => ({
      ...zone,
      net: board.nets.find((net) => net.id === netId)?.name ?? null,
    }));
  assert.deepEqual(nativeZones(reopened.pcb), nativeZones(filled.board));
  assert.deepEqual(
    runPCBDesignRules(reopened.pcb).issues.filter((issue) =>
      ['pcb.short', 'pcb.clearance'].includes(issue.ruleId),
    ),
    [],
  );
  await mkdir('test-results/copper-fill', { recursive: true });
  await page.screenshot({ path: 'test-results/copper-fill/properties-filled.png' });
  await panel.screenshot({ path: 'test-results/copper-fill/compact-properties.png' });
  // Drawing either region on top of saved copper must preserve the existing
  // pour. New outlines are intentionally inactive until Filled is requested.
  const zone = filled.board.zones.find((item) => item.id === zoneId);
  const xs = zone.outline.map((point) => point.x),
    ys = zone.outline.map((point) => point.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const left = minX + (maxX - minX) * 0.2,
    right = minX + (maxX - minX) * 0.8;
  const top = minY + (maxY - minY) * 0.2,
    bottom = minY + (maxY - minY) * 0.8;
  const clickPoint = async (x, y) => {
    const at = await canvas.evaluate(
      (svg, point) => {
        const p = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM());
        return { x: p.x, y: p.y };
      },
      { x, y },
    );
    await page.mouse.click(at.x, at.y);
  };
  for (const shape of ['rectangle', 'polygon']) {
    await button(`Draw ${shape}`).click();
    await clickPoint(left, top);
    if (shape === 'polygon') await clickPoint(right, top);
    await clickPoint(right, bottom);
    if (shape === 'polygon') {
      await clickPoint(left, bottom);
      await canvas.press('Enter');
    }
    const added = await state();
    assert.equal(added.undoDepth, filled.undoDepth + 1);
    assert.equal(added.board.zones.length, filled.board.zones.length + 1);
    assert.deepEqual(
      added.board.zones.find((item) => item.id === zoneId),
      zone,
      `${shape} retains the saved pour unchanged.`,
    );
    assert.equal(added.board.zones.at(-1).fillEnabled, false);
    const reopened = projectFromNativeFiles(added.files);
    assert.deepEqual(
      reopened.pcb.zones.find((item) => item.id === zoneId).filledPolygons,
      zone.filledPolygons,
    );
    await button('Undo').click();
    assert.deepEqual((await state()).board, filled.board);
  }
  await page.mouse.click(screen.x, screen.y);
  await filledToggle.uncheck();
  assert.equal((await state()).undoDepth, 3);
  await page.evaluate(() => window.pendingSource());
  await panel.getByRole('button', { name: 'Delete object', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Apply the Source edits' }).waitFor();
  assert.equal((await state()).undoDepth, 3, 'Pending Source blocks footer deletion.');
  await panel.getByRole('button', { name: 'Fill zone', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Apply the Source edits' }).waitFor();
  assert.equal((await state()).undoDepth, 3);
  await page.evaluate(() => window.clearSource());
  await button('Undo').click();
  assert.deepEqual((await state()).board, filled.board);
  await button('Undo').click();
  assert.equal((await state()).board.zones.find((z) => z.id === zoneId).filledPolygons, undefined);
  await button('Undo').click();
  assert.deepEqual((await state()).board, before.board);
  assert.deepEqual(errors, []);
  console.log(
    'Properties fill, rectangle/polygon creation preserving saved pours, native roundtrip, Source/IME guards and undo passed.',
  );
} finally {
  await browser.close();
}
