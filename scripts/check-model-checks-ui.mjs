import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

// Browser-only presentation check; model responses are fixtures, with no native services.
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const board = createEmptyPCB();
board.graphics = [
  {
    id: 'outline',
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.05,
    start: { x: 0, y: 0 },
    points: [
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ],
    end: { x: 0, y: 80 },
  },
];
board.footprints = [
  {
    id: 'hole',
    symbolId: null,
    libraryId: 'Fixture:MountingHole',
    reference: 'MH1',
    value: 'Mounting hole',
    x: 12,
    y: 15,
    rotation: 0,
    side: 'front',
    pads: [
      {
        id: 'hole-pad',
        number: '1',
        type: 'np_thru_hole',
        shape: 'circle',
        x: 0,
        y: 0,
        size: { x: 3.2, y: 3.2 },
        rotation: 0,
        layers: ['*.Cu', '*.Mask'],
        drill: 3.2,
        netId: null,
      },
    ],
    graphics: [],
    models: [],
  },
  {
    id: 'component',
    symbolId: null,
    libraryId: 'Fixture:Unavailable',
    reference: 'J1',
    value: 'Connector',
    x: 82,
    y: 65,
    rotation: 0,
    side: 'back',
    pads: [
      {
        id: 'component-pad',
        number: '1',
        type: 'smd',
        shape: 'rect',
        x: 0,
        y: 0,
        size: { x: 4, y: 3 },
        rotation: 0,
        layers: ['B.Cu'],
        netId: null,
      },
    ],
    graphics: [],
    models: [
      {
        path: 'missing.step',
        offset: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        rotation: { x: 0, y: 0, z: 0 },
      },
    ],
  },
];
board.footprints.push({
  ...structuredClone(board.footprints[1]),
  id: 'broken',
  libraryId: 'Fixture:Broken',
  reference: 'U1',
  x: 50,
  y: 40,
  pads: [],
  models: [
    {
      path: 'broken.step',
      offset: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  ],
});
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useRef}from'react';import{createRoot}from'react-dom/client';
import Preview from'./components/PCBModelPreview';import RulePanel from'./components/RuleCheckPanel';import RuleStatus from'./components/RuleStatus';
function Harness(){const[active,setActive]=useState(true),[readOnly,setReadOnly]=useState(false);
const[sidebarVisible,setSidebarVisible]=useState(false),view=useRef(null),sequence=useRef(0);
const[report,setReport]=useState(null),[open,setOpen]=useState(false);
const[focus,setFocus]=useState(null),[sourcePending,setSourcePending]=useState(false);
window.modelCheckHarness={setActive,setReadOnly,view,setSourcePending};window.modelCheckReport=report;
return <div className="editor" style={{height:'100vh'}}><div style={{position:'absolute',zIndex:20,right:12,top:12}}><RuleStatus kind="model"
report={report?{issues:report.issues,complete:report.state==='ready'}:null}
state={!report?'unchecked':report.state==='loading'?'checking':report.state==='error'?'failed':'ready'}
expanded={open} disabled={false} onToggle={()=>setOpen(value=>!value)}/></div>
<Preview board={window.fixture} schematic={window.schematicFixture} active={active} readOnly={readOnly}
onModelChecksChange={setReport} modelCheckFocus={focus}
viewState={view} sidebarVisible={sidebarVisible} onShowSidebar={()=>setSidebarVisible(true)}
rulePanel={open&&<RulePanel kind="model" report={null} sourcePending={sourcePending}
modelReport={report?{...report,canLocate:report.canLocate&&active}:null} onSelectModelCheckIssue={issue=>{setFocus({request:++sequence.current,board:window.fixture,footprintId:issue.footprintId});setOpen(false)}}
onRun={()=>{throw Error('Model checks must not run ERC/DRC')}} onSelectIssue={()=>{}} onClose={()=>setOpen(false)}/>}/>
</div>}
createRoot(document.getElementById('root')).render(<Harness/>);`,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  outdir: 'test-results/model-checks-ui',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'inspect-model-check-navigation',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: filename }) => {
          const source = await readFile(filename, 'utf8');
          const marker = '      redraw.current = render;';
          assert.ok(source.includes(marker));
          return {
            loader: 'tsx',
            resolveDir: path.dirname(filename),
            contents: source.replace(
              marker,
              marker +
                '\n      window.inspectModelChecks=()=>({camera,orbit,board,selection:selectionRef.current.ids,components,cad:cadRef.current});',
            ),
          };
        });
      },
    },
  ],
});
await mkdir('test-results/model-checks-ui', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ board, schematic }) => {
      window.fixture = board;
      window.schematicFixture = schematic;
      window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
    },
    { board, schematic: emptyCircuit() },
  );
  await page.route('http://localhost/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/libraries/footprints')
      return route.fulfill({
        json: {
          footprint: ['footprint', '"Fixture"'],
          models: url.searchParams.get('id') === 'Fixture:Broken' ? [{ path: 'broken.step' }] : [],
        },
      });
    if (url.pathname === '/api/library-model')
      return route.fulfill({ status: 500, json: { error: 'Model parse failed.' } });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const filename of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(filename, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root{height:100%;margin:0}' });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  await page
    .waitForFunction(
      () => window.inspectModelChecks && !document.querySelector('.pcb-model-status'),
    )
    .catch(async (error) => {
      console.error(await page.locator('body').innerText(), errors);
      throw error;
    });
  await page.waitForFunction(() => window.modelCheckReport?.state === 'ready');
  const ruleStatus = page.getByRole('button', { name: 'Rule', exact: true });
  assert.equal(await ruleStatus.locator('.rule-status-count').count(), 2);
  assert.equal(await ruleStatus.locator('[data-rule-errors]').textContent(), '1');
  assert.equal(await ruleStatus.locator('[data-rule-warnings]').textContent(), '2');
  assert.equal(await ruleStatus.getAttribute('aria-description'), 'MODEL. 1 errors, 2 warnings');
  assert.equal(await page.locator('.pcb-model-issues').count(), 0);
  const panel = page.getByRole('dialog', { name: 'Rule', exact: true });
  const buttons = panel
    .getByRole('list', { name: 'Model issues', exact: true })
    .getByRole('button');
  const open = async () => {
    await page.getByRole('button', { name: 'Rule', exact: true }).click();
    await panel.waitFor();
    await panel.getByRole('heading', { name: 'Model checks', exact: true }).waitFor();
    assert.equal(await panel.getByRole('tab').count(), 0);
  };
  const inspect = () =>
    page.evaluate(() => {
      const { camera, orbit, selection } = window.inspectModelChecks();
      return { target: orbit.target.toArray(), quaternion: camera.quaternion.toArray(), selection };
    });
  const assertWarningStyle = async () => {
    // Theme colors transition; wait until count, text and border all reach gray.
    await page.waitForFunction(() => {
      const element = document.querySelector('section[aria-label="Rule"]');
      const probe = document.createElement('span');
      probe.style.color = 'var(--muted)';
      element.append(probe);
      const gray = getComputedStyle(probe).color;
      probe.remove();
      const warning = element.querySelector('[data-severity="warning"]');
      const summary = element.querySelector('[aria-label="Model summary"]');
      const footerWarning = document.querySelector('[data-rule-warnings]');
      return (
        summary.children.length === 2 &&
        getComputedStyle(summary.lastElementChild).color === gray &&
        getComputedStyle(warning).color === gray &&
        getComputedStyle(warning).borderInlineStartColor === gray &&
        getComputedStyle(footerWarning).color === gray
      );
    });
  };
  await open();
  assert.equal(await panel.getByLabel('Model summary').textContent(), '1 error2 warnings');
  await assertWarningStyle();
  assert.deepEqual(await buttons.allTextContents(), [
    'MH1: No 3D model',
    'J1: 3D model unavailable',
    'U1: Model parse failed.',
  ]);
  assert.equal(await buttons.nth(0).getAttribute('data-severity'), 'warning');
  assert.equal(await buttons.nth(0).getAttribute('aria-description'), 'Warning');
  assert.equal(await buttons.nth(2).getAttribute('data-severity'), 'error');
  await buttons.first().click();
  await panel.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.inspectModelChecks().selection[0] === 'hole');
  const hole = await inspect();
  assert.deepEqual(hole.target, [12, -15, board.thickness / 2]);
  assert.equal(
    await page.getByRole('textbox', { name: 'Reference', exact: true }).inputValue(),
    'MH1',
  );
  await open();
  await buttons.nth(1).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.inspectModelChecks().selection[0] === 'component');
  const connector = await inspect();
  assert.ok(Math.abs(connector.target[0] - 82) < 1e-8);
  assert.ok(Math.abs(connector.target[1] + 65) < 1e-8);
  hole.quaternion.forEach((value, index) =>
    assert.ok(Math.abs(value - connector.quaternion[index]) < 1e-8),
  );
  await open();
  await buttons.first().focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.inspectModelChecks().selection[0] === 'hole');
  await open();
  for (const key of ['Enter', ' '])
    for (const options of [{ isComposing: true }, { keyCode: 229 }])
      for (const type of ['keydown', 'keyup'])
        assert.equal(
          await buttons.nth(1).evaluate(
            (element, data) => {
              const event = new KeyboardEvent(data.type, {
                key: data.key,
                ...data.options,
                bubbles: true,
                cancelable: true,
              });
              element.dispatchEvent(event);
              return event.defaultPrevented;
            },
            { type, key, options },
          ),
          true,
        );
  await buttons.nth(1).dispatchEvent('compositionstart');
  await buttons.nth(1).click();
  assert.deepEqual((await inspect()).selection, ['hole']);
  await buttons.nth(1).dispatchEvent('compositionend');
  await page.evaluate(() => window.modelCheckHarness.setSourcePending(true));
  await page.waitForFunction(() => document.querySelector('[data-severity="warning"]').disabled);
  await page.evaluate(() => window.modelCheckHarness.setSourcePending(false));
  await page.waitForFunction(() => !document.querySelector('[data-severity="warning"]').disabled);
  await page.evaluate(() => window.modelCheckHarness.setActive(false));
  await page.waitForFunction(() => document.querySelector('[data-severity="warning"]').disabled);
  await page.evaluate(() => window.modelCheckHarness.setActive(true));
  await page.waitForFunction(() => !document.querySelector('[data-severity="warning"]').disabled);
  await page.setViewportSize({ width: 680, height: 600 });
  const layout = await panel.boundingBox();
  const drawing = await page.locator('.model-drawing-region').boundingBox();
  const sidebar = await page.locator('.model-properties-dock').boundingBox();
  assert.ok(Math.abs(layout.x - drawing.x - 9) <= 1);
  assert.ok(layout.width <= 480 && layout.width <= drawing.width - 16);
  assert.ok(layout.x + layout.width <= sidebar.x);
  await page.screenshot({ path: 'test-results/model-checks-ui/checks.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await assertWarningStyle();
  await page.screenshot({ path: 'test-results/model-checks-ui/checks-dark.png' });
  await panel.getByRole('button', { name: 'Close Rule', exact: true }).click();
  await page.getByRole('button', { name: 'Orthographic projection', exact: true }).click();
  await page.waitForFunction(() => window.inspectModelChecks().camera.isPerspectiveCamera);
  await open();
  await buttons.nth(1).click();
  assert.ok(Math.abs((await inspect()).target[0] - 82) < 1e-8);
  await open();
  await buttons.first().click();
  assert.ok(Math.abs((await inspect()).target[0] - 12) < 1e-8);
  // Read-only history previews permit camera navigation without an editable selection.
  await page.evaluate(() => window.modelCheckHarness.setReadOnly(true));
  await page.waitForFunction(() => window.inspectModelChecks().selection.length === 0);
  await page.locator('.pcb-model-issues summary').click();
  await page.locator('.model-issue-locate').nth(1).click();
  assert.ok(Math.abs((await inspect()).target[0] - 82) < 1e-8);
  assert.deepEqual((await inspect()).selection, []);
  assert.deepEqual(await page.evaluate(() => window.inspectModelChecks().board), board);
  assert.deepEqual(errors, []);
  console.log(
    'Model checks: shared error/warning categories, pointer/keyboard locating, mounting holes, IME/Source/activity guards, both projections/themes, read-only and unchanged board passed.',
  );
} finally {
  await browser.close();
}
