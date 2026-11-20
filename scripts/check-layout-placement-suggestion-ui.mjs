import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);

// Isolated renderer: real pointer dispatch, no Electron, user data or service requests.
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      import SettingsDialog from './components/SettingsDialog';
      import {useAppearance} from './components/AppearanceSettings';
      function Test(){const [board,setBoard]=useState(window.fixture.board);
        const [settings,setSettings]=useState(false);
        const [blocked,setBlocked]=useState(false);
        const [revision,setRevision]=useState(window.revision);
        const appearance=useAppearance();
        window.openLayoutTestSettings=()=>setSettings(true);
        window.blockLayoutTest=()=>setBlocked(true);
        window.refreshLayoutTestRevision=()=>setRevision(window.revision);
        const getRevision=()=>window.revision;
        return <><LayoutEditor board={board} schematic={window.fixture.schematic} active={!settings}
          placementSuggestionRevision={appearance.layoutPreferences.enabled && !blocked ? revision : undefined}
          getRevision={getRevision}
          onCommit={next=>{window.lastBoard=next;window.commits++;setBoard(next);return true}}
          annotations={[]} annotationSessionId="selection" onAnnotationsChange={()=>{}}/>
          {settings && <SettingsDialog appearance={appearance} agents={[]} detecting={false}
            error="" onDetect={async()=>{}} onEnterRawMode={async()=>{window.rawEntries++}}
            onClose={()=>setSettings(false)}/>}</>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  outdir: 'test-results/layout-placement-suggestion-bundle',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const script = bundle.outputFiles.find(({ path }) => path.endsWith('.js')).text;
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const board = {
    ...createEmptyPCB(),
    nets: [{ id: 'signal', name: 'Signal' }],
    graphics: [
      { x: 12, y: 26 },
      { x: 38, y: 26 },
      { x: 38, y: 41 },
      { x: 12, y: 41 },
    ].map((start, i, corners) => ({
      id: 'edge-' + i,
      layer: 'Edge.Cuts',
      width: 0.05,
      start,
      end: corners[(i + 1) % corners.length],
    })),
    footprints: [20, 30].map((x, index) => ({
      id: 'R' + (index + 1),
      x,
      y: 20,
      symbolId: null,
      libraryId: 'Test:Placement',
      reference: 'R' + (index + 1),
      value: '1k',
      rotation: 0,
      side: 'front',
      graphics: [],
      pads: [
        {
          id: 'pad-' + index,
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 1, y: 1 },
          netId: 'signal',
        },
      ],
    })),
  };
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.addInitScript(
    (fixture) => {
      window.fixture = fixture;
      window.lastBoard = fixture.board;
      window.commits = 0;
      window.revision = 0;
      window.rawEntries = 0;
    },
    { board, schematic: emptyCircuit() },
  );
  const load = async () => {
    await page.goto('http://localhost');
    for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    await page.addStyleTag({
      content: 'html,body,#root{height:100%;margin:0}.layout-editor{height:100%}',
    });
    for (const { path, text } of bundle.outputFiles)
      if (path.endsWith('.css')) await page.addStyleTag({ content: text });
    await page.addScriptTag({ content: script });
  };
  await load();
  const canvas = page.getByTestId('layout-canvas');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const settingsTab = (name) => settings.getByRole('tab', { name, exact: true });
  const workspace = settings.getByRole('tabpanel', { name: 'Workspace', exact: true });
  const settingsSwitch = workspace.getByRole('switch', {
    name: 'Layout shadow suggestions',
    exact: true,
  });
  const shadows = canvas.locator('[data-suggested-footprint]');
  const commits = () => page.evaluate(() => window.commits);
  const marquee = async () => {
    const [start, end] = await canvas.evaluate((svg) =>
      [
        [17, 17],
        [33, 23],
      ].map(([x, y]) => {
        const at = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
        return [at.x, at.y];
      }),
    );
    await page.mouse.move(...start);
    await page.mouse.down();
    await page.mouse.move(...end, { steps: 4 });
    await page.mouse.up();
  };
  await canvas.waitFor();
  await marquee();
  assert.equal(await shadows.count(), 0);
  await canvas.press('Tab');
  assert.ok(!(await canvas.evaluate((svg) => document.activeElement === svg)));
  assert.equal(await commits(), 0);
  await page.evaluate(() => window.openLayoutTestSettings());
  await settingsTab('Appearance').waitFor();
  assert.equal(
    await settings.getByRole('switch', { name: 'Layout shadow suggestions' }).count(),
    0,
  );
  await settingsTab('Appearance').press('ArrowDown');
  await workspace.waitFor();
  assert.equal(await workspace.getByRole('combobox').count(), 2);
  await settingsTab('Workspace').dispatchEvent('keydown', { key: 'End', keyCode: 229 });
  assert.equal(await settingsTab('Workspace').getAttribute('aria-selected'), 'true');
  await settingsTab('Workspace').press('End');
  assert.equal(await settingsTab('Agents').getAttribute('aria-selected'), 'true');
  assert.equal(await settings.getByRole('combobox').count(), 0);
  await settings.getByRole('button', { name: 'Detect agents', exact: true }).waitFor();
  await settingsTab('Workspace').click();
  assert.equal(await settingsSwitch.getAttribute('aria-checked'), 'false');
  await settingsSwitch.click();
  assert.equal(await settingsSwitch.getAttribute('aria-checked'), 'true');
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await marquee();
  await shadows.first().waitFor();
  assert.equal(await shadows.count(), 2);
  assert.equal(await commits(), 0);
  assert.ok(await page.getByText('Tab to apply placement', { exact: true }).isVisible());
  for (const modifiers of [
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
  ]) {
    await canvas.dispatchEvent('keydown', { key: 'Tab', ...modifiers });
    assert.equal(await commits(), 0);
  }
  await page.evaluate(() => window.revision++);
  await canvas.press('Tab');
  assert.equal(await commits(), 0, 'A live revision change prevents a stale apply.');
  await page.evaluate(() => window.refreshLayoutTestRevision());
  await shadows.first().waitFor({ state: 'detached' });
  await marquee();
  await shadows.first().waitFor();
  const positions = await shadows.evaluateAll((elements) =>
    elements.map((element) => {
      const line = element.querySelector('line');
      return [Number(line.getAttribute('x2')), Number(line.getAttribute('y2'))];
    }),
  );
  assert.ok(positions.every(([x, y]) => x > 12.5 && x < 37.5 && y > 26.5 && y < 40.5));
  await canvas.press('Tab');
  assert.equal(await commits(), 1);
  assert.deepEqual(
    await page.evaluate(() => window.lastBoard.footprints.map(({ x, y }) => [x, y])),
    positions,
  );
  assert.equal(await shadows.count(), 0);
  await canvas.press('Tab');
  assert.equal(await commits(), 1);

  await load();
  await canvas.waitFor();
  await page.evaluate(() => window.openLayoutTestSettings());
  await settingsTab('Workspace').click();
  await settingsSwitch.waitFor();
  assert.equal(await settingsSwitch.getAttribute('aria-checked'), 'true');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await marquee();
  await shadows.first().waitFor();
  await page.evaluate(() => window.blockLayoutTest());
  await shadows.first().waitFor({ state: 'detached' });
  await canvas.press('Tab');
  assert.equal(await commits(), 0);

  await page.evaluate(() => window.openLayoutTestSettings());
  await settingsTab('Workspace').click();
  const mode = workspace.getByRole('combobox', { name: 'Workspace mode', exact: true });
  const options = settings.getByRole('listbox', { name: 'Workspace mode', exact: true });
  await mode.dispatchEvent('keydown', { key: 'ArrowDown', isComposing: true });
  assert.equal(await options.count(), 0);
  await mode.click();
  await options.getByRole('option', { name: 'Raw KiCad', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.rawEntries), 1);

  assert.deepEqual(errors, []);
  console.log(
    'Layout shadow suggestions: settings persistence, preview, keyboard guards and exact placement.',
  );
  await page.close();
} finally {
  await browser.close();
}
