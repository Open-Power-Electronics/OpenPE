import { formatTestProjectSource } from './format-test-project.mjs';
// Isolated rendered-pane controller check. No Electron, host files or provider.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { parseProject } from '../server/project-format.mjs';

const project = parseProject(formatTestProjectSource());

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
  import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
  import Controller from './components/PanelFindController';
  import Canvas from './components/Canvas';import Layout from './components/LayoutEditor';
  import {defaultSchematicLayers}from'./lib/schematic-layers';
  const project=${JSON.stringify(project)};
  function Drawing({mode,blocked}){const[selection,setSelection]=useState([]);const[tool,setTool]=useState('select');
    return mode==='canvas'?<Canvas doc={project.schematic} selection={selection} onSelection={setSelection} onSelect={()=>{}} tool={tool} setTool={setTool} fitKey={1} grid={false} gridSpacing={2.54} layers={defaultSchematicLayers} annotations={[]} annotationSessionId="find" onAnnotationsChange={()=>{}} onCommit={()=>{throw Error('Find must not commit')}} onPosition={()=>{}} editingBlocked={blocked}/>:<Layout board={project.pcb} schematic={project.schematic} sidebarVisible={false} annotations={[]} annotationSessionId="find" onAnnotationsChange={()=>{}} onCommit={()=>{throw Error('Find must not commit')}} annotationDisabled={blocked}/>;}
  function Fixture(){const root=useRef(null),control=useRef(null);const[active,setActive]=useState(true),[mode,setMode]=useState('schematic'),[blocked,setBlocked]=useState(false);window.findFixture={setActive,setMode,setBlocked};
    return <><div ref={root} className="fixture" hidden={!active}>
      <aside className="chat-panel"><div className="chat-header">Agent</div><div className="chat-scroll"><p>Agent needle. Agent <b>nee</b>dle.</p><p hidden>Hidden needle</p><div style={{maxHeight:20,overflow:'hidden'}}><div>Visible</div><p>Folded only</p></div><p>{'<script>literal</script>'}</p><div style={{height:900}}/><p data-distant-match>Last needle</p><div style={{height:400}}/></div><textarea aria-label="Composer" defaultValue="Draft stays unchanged"/></aside>
      <section className="editor"><div>Preview R42</div><div className="file-editor-surface" hidden={mode!=='schematic'}><div className="editor-toolbar">Toolbar-only R42</div><div className="canvas-wrap"><svg data-testid="schematic-canvas" height="100"><text x="10" y="30">R42 visible needle</text></svg></div><aside>Properties-only R42</aside></div><div className="file-editor-surface" hidden={mode!=='source'}><header>Source toolbar-only</header><nav>Source file-list-only</nav><div className="source-editor-code"><div className="cm-scroller"><div className="cm-gutters">Source gutter-only</div><div className="cm-content"><p>Source-only text</p></div></div></div></div>{(mode==='canvas'||mode==='layout')&&<div className="file-editor-surface fixture-drawing-surface"><div className="fixture-drawing"><Drawing mode={mode} blocked={blocked}/></div><aside className="fixture-properties"><p>Properties-only R1 C1</p><p>Footprint sidebar-only</p><p>Simulation-only R1</p></aside></div>}<input aria-label="Property draft" defaultValue="12 V"/></section>
    </div><Controller workspace={root} control={control} active={active} scopeKey={mode}/></>};createRoot(document.getElementById('root')).render(<Fixture/>);
`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  jsx: 'automatic',
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div>',
    }),
  );
  await page.goto('http://localhost');
  await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/layout-editor.css', 'utf8') });
  await page.addStyleTag({
    content:
      '.fixture{display:flex;gap:8px;height:600px}.chat-panel{width:360px;display:flex;flex-direction:column}.chat-scroll{height:420px;overflow:auto}.editor{width:680px;position:relative}.file-editor-surface{height:420px}.fixture-drawing-surface{flex-direction:row!important}.fixture-drawing{display:flex;flex-direction:column;flex:1;position:relative;min-width:0}.fixture-properties{width:140px}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const composer = page.getByRole('textbox', { name: 'Composer' });
  const property = page.getByRole('textbox', { name: 'Property draft' });
  await composer.waitFor();
  await property.focus();
  await page.locator('.chat-scroll').hover();
  await page.keyboard.press('Control+f');
  const agent = page.getByRole('search', { name: 'Find in Agent', exact: true });
  const query = agent.getByRole('searchbox');
  await query.fill('needle');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '1/3',
  );
  assert.equal(await page.getByRole('dialog').count(), 0);
  const parent = await page.locator('.chat-panel').boundingBox();
  const bounds = await agent.boundingBox();
  assert.ok(Math.abs(bounds.width - 240) <= 1);
  assert.ok(
    bounds.x >= parent.x &&
      Math.abs(bounds.x + bounds.width - parent.x - parent.width + 8) <= 2 &&
      bounds.y < parent.y + 80,
  );
  await query.press('Enter');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '2/3',
  );
  assert.equal(await page.evaluate(() => CSS.highlights.get('openpe-panel-find-all').size), 3);
  const highlightState = () =>
    page.evaluate(() => {
      const range = [...CSS.highlights.get('openpe-panel-find-current')][0];
      const hit = range.getBoundingClientRect();
      const scroll = document.querySelector('.chat-scroll').getBoundingClientRect();
      const bar = document.querySelector('[data-panel-find]').getBoundingClientRect();
      const text = range.startContainer.parentElement;
      return {
        text: range.toString(),
        distant: !!text.closest('[data-distant-match]'),
        visible: hit.top >= Math.max(scroll.top, bar.bottom + 4) - 1 && hit.bottom <= scroll.bottom,
        all: getComputedStyle(text, '::highlight(openpe-panel-find-all)').backgroundColor,
        current: getComputedStyle(text, '::highlight(openpe-panel-find-current)').backgroundColor,
      };
    });
  await agent.getByRole('button', { name: 'Next match', exact: true }).click();
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '3/3',
  );
  assert.equal(await query.evaluate((element) => element === document.activeElement), true);
  const distant = await highlightState();
  assert.equal(distant.text, 'needle');
  assert.equal(distant.distant, true);
  assert.equal(distant.visible, true);
  assert.notEqual(distant.all, distant.current);
  await query.press('Enter');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '1/3',
  );
  assert.equal((await highlightState()).visible, true);
  await query.dispatchEvent('compositionstart');
  await query.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await agent.getByRole('button', { name: 'Next match', exact: true }).click();
  assert.equal(await agent.getByRole('status').textContent(), '1/3');
  await query.dispatchEvent('compositionend');
  await query.press('Shift+Enter');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '3/3',
  );
  await query.fill('Folded only');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '0/0',
  );
  await query.fill('R42');
  assert.equal(await agent.getByRole('status').textContent(), '0/0');
  await composer.focus();
  await page.locator('.editor').hover();
  await page.keyboard.press('Meta+f');
  const preview = page.getByRole('search', { name: 'Find in Preview', exact: true });
  assert.equal(await agent.count(), 0);
  await preview.getByRole('searchbox').fill('R42');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '1/1',
  );
  await preview.getByRole('searchbox').fill('Source-only');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '0/0',
  );
  await preview.getByRole('searchbox').press('Escape');
  assert.equal(await preview.count(), 0);
  assert.equal(await composer.inputValue(), 'Draft stays unchanged');
  assert.equal(await property.inputValue(), '12 V');
  await composer.dispatchEvent('compositionstart');
  await composer.dispatchEvent('keydown', { key: 'f', ctrlKey: true, keyCode: 229 });
  assert.equal(await page.getByRole('search').count(), 0);
  await composer.dispatchEvent('compositionend');
  await page.locator('.chat-scroll').hover();
  await page.keyboard.press('Control+f');
  await agent.waitFor();
  await page.evaluate(() => window.findFixture.setMode('source'));
  await waitForAsync(page, () => !document.querySelector('[data-panel-find]'));
  assert.equal(await page.evaluate(() => CSS.highlights.has('openpe-panel-find-all')), false);
  await page.locator('.source-editor-code:visible').hover();
  await page.keyboard.press('Control+f');
  await preview.getByRole('searchbox').fill('Source');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '1/1',
  );
  await preview.getByRole('searchbox').press('Escape');
  const drawingView = (selector) => page.locator(selector).getAttribute('viewBox');
  const assertLocated = async (selector, id) => {
    const located = await page.locator(selector).evaluate((svg, id) => {
      const object = [...svg.querySelectorAll('[data-selection-id]')].find(
        (node) => node.dataset.selectionId === id && node.matches('.part, .layout-footprint'),
      );
      const frame = svg.getBoundingClientRect();
      const box = object?.getBoundingClientRect();
      return (
        box && {
          selected: object.matches('.is-selected, .selected'),
          visible:
            box.left >= frame.left &&
            box.right <= frame.right &&
            box.top >= frame.top &&
            box.bottom <= frame.bottom,
          centered:
            Math.abs((box.left + box.right - frame.left - frame.right) / 2) < frame.width * 0.2,
          readable: box.width > 25 || box.height > 25,
        }
      );
    }, id);
    assert.deepEqual(located, { selected: true, visible: true, centered: true, readable: true });
    assert.equal(
      await preview.getByRole('searchbox').evaluate((input) => input === document.activeElement),
      true,
    );
  };
  for (const mode of ['canvas', 'layout']) {
    await page.evaluate((mode) => window.findFixture.setMode(mode), mode);
    const selector =
      mode === 'canvas'
        ? '.fixture-drawing [data-testid="schematic-canvas"]'
        : '.fixture-drawing [data-testid="layout-canvas"]';
    await page
      .locator(selector)
      .waitFor({ state: 'attached', timeout: 5000 })
      .catch((error) => {
        throw new Error(`${error.message}; page errors: ${JSON.stringify(errors)}`);
      });
    assert.deepEqual(errors, []);
    assert.ok(
      await page.locator(selector).isVisible(),
      await page.locator(selector).evaluate((svg) => ({
        box: svg.getBoundingClientRect().toJSON(),
        parent: svg.parentElement.getBoundingClientRect().toJSON(),
      })),
    );
    await page.locator(selector).hover();
    await page.keyboard.press('Control+f');
    const canvasBounds = await page.locator(selector).boundingBox();
    const findBounds = await preview.boundingBox();
    assert.ok(
      Math.abs(findBounds.x + findBounds.width - canvasBounds.x - canvasBounds.width + 8) <= 1,
      'Find anchors to the canvas right edge.',
    );
    assert.ok(
      Math.abs(findBounds.y - canvasBounds.y - 4) <= 1,
      'Find anchors to the canvas top edge.',
    );
    assert.ok(findBounds.width <= canvasBounds.width - 16 + 1);
    await preview.getByRole('searchbox').fill('Properties-only');
    await waitForAsync(
      page,
      () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '0/0',
    );
    const before = await drawingView(selector);
    await preview.getByRole('searchbox').fill('R1');
    await waitForAsync(
      page,
      (selector) => {
        const svg = document.querySelector(selector);
        return svg.querySelector('.part.is-selected, .layout-footprint.selected');
      },
      selector,
    );
    const after = await drawingView(selector);
    assert.equal(
      await preview.getByRole('status').textContent(),
      '1/1',
      'Sidebar copies of R1 are outside canvas search.',
    );
    assert.ok(
      Number(after.split(' ')[2]) < Number(before.split(' ')[2]),
      'Find zooms into the object.',
    );
    const [resistor, capacitor] =
      mode === 'canvas' ? project.schematic.parts : project.pcb.footprints;
    await assertLocated(selector, resistor.id);
    await preview.getByRole('searchbox').fill('C1');
    await waitForAsync(
      page,
      ({ selector, id }) =>
        [...document.querySelector(selector).querySelectorAll('.is-selected, .selected')].some(
          (node) => node.dataset.selectionId === id,
        ),
      { selector, id: capacitor.id },
    );
    await assertLocated(selector, capacitor.id);
    await preview.getByRole('searchbox').fill('1');
    await waitForAsync(
      page,
      () =>
        Number(
          document.querySelector('[data-panel-find] [role=status]')?.textContent.split('/')[1],
        ) >= 2,
    );
    const total = (await preview.getByRole('status').textContent()).split('/')[1];
    await preview.getByRole('searchbox').press('Shift+Enter');
    await waitForAsync(
      page,
      (total) =>
        document.querySelector('[data-panel-find] [role=status]')?.textContent ===
        total + '/' + total,
      total,
    );
    await preview.getByRole('searchbox').press('Enter');
    await waitForAsync(
      page,
      (total) =>
        document.querySelector('[data-panel-find] [role=status]')?.textContent === '1/' + total,
      total,
    );
    await preview.getByRole('searchbox').fill('C1');
    await waitForAsync(
      page,
      ({ selector, id }) =>
        [...document.querySelector(selector).querySelectorAll('.is-selected, .selected')].some(
          (node) => node.dataset.selectionId === id,
        ),
      { selector, id: capacitor.id },
    );
    await page.evaluate(() => window.findFixture.setBlocked(true));
    const blockedView = await drawingView(selector);
    await preview.getByRole('searchbox').fill('R1');
    await waitForAsync(
      page,
      () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '1/1',
    );
    assert.equal(
      await drawingView(selector),
      blockedView,
      'Pending Source blocks canvas navigation.',
    );
    await page.evaluate(() => window.findFixture.setBlocked(false));
    await preview.getByRole('searchbox').press('F3');
    await assertLocated(selector, resistor.id);
    await preview.getByRole('searchbox').press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS rendered-pane Find: canvas-corner anchoring, toolbar/sidebar/result exclusion, Source code-only scope, compact bar, object selection/zoom, stable offscreen matches, wrapping, query focus, Source/IME guards and draft preservation.',
  );
} finally {
  await browser.close();
}
