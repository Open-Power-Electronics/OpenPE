import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Real inspector controls in an isolated browser; no Electron, service or solver.
const source = await readFile('lib/emc-flyback-example.json', 'utf8');
const bundle = await build({
  stdin: {
    contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import PartIdentity from './components/PartIdentity';import PartProperties from './components/PartProperties';
import LayoutProperties from './components/LayoutProperties';import ModelCadPanel from './components/ModelCadPanel';
import{parseProject}from'./lib/project';import{newModelCadObject}from'./lib/model-cad';
const project=parseProject(${JSON.stringify(source)}),board=project.pcb;
const footprint=board.footprints.find(f=>f.symbolId&&f.pads.length),part=project.schematic.parts.find(p=>p.id===footprint.symbolId);
const solid=newModelCadObject(board,'box');solid.holes=[{id:crypto.randomUUID(),x:0,y:0,diameterMm:3.2}];
window.inspectorSaves=0;window.solidApplies=0;window.draft=null;
function Fixture(){const[choice,setChoice]=useState('pad'),[width,setWidth]=useState(280),[visible,setVisible]=useState(true);return <>
<nav>{['pad','track','via','footprint','text','dimension','zone'].map(v=><button onClick={()=>setChoice(v)} key={v}>{v}</button>)}<button onClick={()=>setWidth(width===280?480:280)}>Resize</button><button onClick={()=>setVisible(!visible)}>Toggle model</button></nav>
<main style={{'--inspector-width':width+'px'}}>
<section className="column"><header>Schematic</header><div className="inspector part-inspector"><div className="inspector-body"><PartIdentity part={part} library={project.schematic.libraries[part.libId]}/><PartProperties part={part} circuit={project.schematic} spiceAvailable active onSave={()=>{window.inspectorSaves++;return true}}/></div></div></section>
<section className="column"><header>Layout</header><div className="layout-inspector"><div className="layout-inspector-content"><LayoutProperties key={choice} board={board} schematic={project.schematic} active resetKey snap={v=>v}
pad={choice==='pad'?footprint.pads[0]:undefined} padOwner={choice==='pad'?footprint:undefined} footprint={choice==='footprint'?footprint:undefined}
track={choice==='track'?board.tracks[0]:undefined} via={choice==='via'?board.vias[0]:undefined}
zone={choice==='zone'?{id:crypto.randomUUID(),layer:'F.Cu',netId:board.nets[0].id,clearance:.25,minThickness:.2,thermalGap:.3,thermalBridge:.3,outline:[{x:0,y:0},{x:10,y:0},{x:10,y:10}]}:undefined}
graphic={choice==='text'?{id:'text',kind:'text',layer:'F.SilkS',width:.15,start:{x:0,y:0},end:{x:0,y:0},text:{value:'Output',rotation:0,size:{x:1,y:1},thickness:.15}}:choice==='dimension'?{id:'dimension',kind:'dimension',layer:'Dwgs.User',width:.15,start:{x:0,y:0},end:{x:20,y:0},dimension:{type:'aligned',height:5,caption:{value:'20 mm',x:10,y:5,rotation:0,size:{x:1,y:1},thickness:.15},format:{prefix:'',suffix:'',units:2,precision:2},style:{arrowLength:1,extensionOffset:.5,textPositionMode:0}}}:undefined}
rectangle={null} selectionCount={1} onCommit={()=>true} onFootprint={()=>true} onTrack={()=>true} onZone={()=>true} onRectangle={()=>true} onError={e=>{throw Error(e)}} onInspectFootprint={()=>{}} onSavePartProperties={()=>true}/></div></div></section>
<section className="column model-column"><header>Model</header><ModelCadPanel object={solid} mode="edit" visible={visible} docked disabled={false} revision="1" onClose={()=>{}} onDraftChange={v=>window.draft=v} onApply={async()=>{window.solidApplies++}}/></section>
</main></>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'test-results/compact-properties.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1510, height: 850 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addStyleTag({
    content: `body{overflow:auto}nav{display:flex;gap:8px;padding:12px}nav button{padding:6px}main{display:flex;gap:20px;padding:12px}.column{width:var(--inspector-width);height:740px;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line)}.column>header{padding:10px 12px;background:var(--panel);font-weight:600}.column>.inspector,.column>.layout-inspector{position:static;width:100%;min-height:0;flex:1;border:0;box-shadow:none;max-height:none;max-width:none}.inspector-body{padding:12px}.layout-inspector{display:flex;flex-direction:column}`,
  });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const fields = page.locator('.property-additional-fields').first();
  await fields.waitFor();
  assert.equal(await fields.getAttribute('open'), null);
  const fieldsSummary = fields.locator('summary');
  await fieldsSummary.focus();
  await fieldsSummary.press('Enter');
  await fields.getByRole('button', { name: 'Add field', exact: true }).click();
  const name = fields.getByPlaceholder('Name', { exact: true }).last();
  await name.fill('Retained field');
  await name.press('Tab');
  const fieldValue = fields.getByPlaceholder('Value', { exact: true }).last();
  await fieldValue.fill('draft');
  await fieldsSummary.click();
  await fieldsSummary.press('Space');
  assert.equal(await name.inputValue(), 'Retained field');
  assert.equal(await fieldValue.inputValue(), 'draft');
  await fieldsSummary.click();

  const model = page.getByRole('complementary', { name: 'Solid properties settings', exact: true });
  const placement = model.locator('summary').filter({ hasText: /^Placement$/ });
  const holes = model.locator('summary').filter({ hasText: /^Holes/ });
  assert.equal(await placement.locator('..').getAttribute('open'), null);
  assert.equal(await holes.locator('..').getAttribute('open'), null);
  await placement.click();
  const x = model.getByLabel('Solid X position (mm)', { exact: true });
  const originalX = await x.inputValue();
  await x.fill('12.345');
  await x.press('Escape');
  assert.equal(await x.inputValue(), originalX);
  await x.fill('12.345');
  await x.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.solidApplies), 0);
  await placement.click();
  await page.getByRole('button', { name: 'Toggle model', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle model', exact: true }).click();
  await placement.click();
  assert.equal(await x.inputValue(), '12.345');
  await holes.click();
  assert.equal(await model.getByLabel('Hole 1 diameter (mm)', { exact: true }).inputValue(), '3.2');
  await model.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await page.evaluate(() => window.solidApplies), 1);
  assert.equal(await page.evaluate(() => window.draft.position.x), 12.345);
  await placement.click();
  await holes.click();

  await mkdir('test-results/compact-properties', { recursive: true });
  const assertControlBounds = async (context) => {
    const overflows = await page
      .locator('.column input, .column textarea, .column .select-trigger')
      .evaluateAll((controls) =>
        controls
          .filter((control) => {
            if (!control.getClientRects().length) return false;
            const column = control.closest('.column').getBoundingClientRect();
            const rect = control.getBoundingClientRect();
            return rect.left < column.left - 1 || rect.right > column.right + 1;
          })
          .map((control) => control.getAttribute('aria-label')),
      );
    assert.deepEqual(overflows, [], `${context}: controls stay in the dock.`);
    assert.equal(
      await page
        .locator('.layout-inspector .quantity-input > input')
        .evaluateAll((controls) =>
          controls.every((control) => getComputedStyle(control).borderWidth === '0px'),
        ),
      true,
      'Quantity controls have one outer outline.',
    );
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [280, 480]) {
      if (width === 480) await page.getByRole('button', { name: 'Resize', exact: true }).click();
      for (const choice of ['pad', 'track', 'via', 'footprint', 'text', 'dimension', 'zone']) {
        await page.getByRole('button', { name: choice, exact: true }).click();
        const disclosure = page.locator('.layout-inspector summary');
        const summaries = await disclosure.all();
        for (const summary of summaries) {
          await summary.click();
          await assertControlBounds(`${theme} ${width}px ${choice} expanded`);
        }
        for (const summary of summaries.reverse()) await summary.click();
        await assertControlBounds(`${theme} ${width}px ${choice}`);
        await page.locator('.layout-inspector-content').evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.mouse.move(1490, 20);
        if (width === 280)
          await page.screenshot({ path: `test-results/compact-properties/${theme}-${choice}.png` });
      }
      if (width === 480) await page.getByRole('button', { name: 'Resize', exact: true }).click();
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: compact inspectors at 280/480 px in both themes, secondary disclosures, retained drafts, keyboard/IME and Model Apply.',
  );
} finally {
  await browser.close();
}
