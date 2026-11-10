import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { checkComponentDeletePlacement } from './schematic-panel-test-helpers.mjs';

// Isolated component presentation; no DesktopWorkspace recovery, services or native dialogs.
const bundle = await build({
  stdin: {
    contents: `
    import React,{useState,useRef} from 'react';
    import {createRoot} from 'react-dom/client';
    import PropertyDeleteButton from './components/PropertyDeleteButton';
    import ModelCadPanel from './components/ModelCadPanel';
    import {newModelCadObject} from './lib/model-cad';
    import EditorDisplayDrawer from './components/EditorDisplayDrawer';
    import PartIdentity from './components/PartIdentity';
    import PartProperties from './components/PartProperties';
    import LayoutProperties from './components/LayoutProperties';
    import {createPart,emptyCircuit} from './lib/circuit';
    import {createEmptyPCB} from './lib/pcb-layout';
    const schematic=emptyCircuit(),part=createPart(schematic,'R',0,0);
    part.fields={...part.fields,Footprint:'Fixture:R'};schematic.parts.push(part);
    const board=createEmptyPCB();
    const footprint={id:'package',symbolId:part.id,libraryId:'Fixture:R',reference:part.ref,
      value:part.value,x:0,y:0,rotation:0,side:'front',pads:[],graphics:[]};
    board.footprints.push(footprint);
    const solid=newModelCadObject(board,'box');
    function Fixture(){
      const [mode,setMode]=useState('schematic'),[count,setCount]=useState(0),[open,setOpen]=useState(true);
      const [spiceAvailable,setSpiceAvailable]=useState(true);
      const [applied,setApplied]=useState(0);
      const composing=useRef(false);
      window.deleteFixture={count,applied};window.setDeleteMode=setMode;window.setSpiceAvailable=setSpiceAvailable;
      const actions=<PropertyDeleteButton disabled={!open}
        onClick={()=>{if(!composing.current)setCount(value=>value+1)}}/>;
      return <div className="panel" onCompositionStart={()=>composing.current=true} onCompositionEnd={()=>composing.current=false}><EditorDisplayDrawer label="Properties" open={open} onOpenChange={setOpen}>
      {mode==='model'?<ModelCadPanel object={solid} mode="edit" docked visible={open} disabled={!open} revision="1" onClose={()=>{}} onDraftChange={()=>{}} onApply={async()=>{setApplied(value=>value+1)}} onRemove={async()=>{setCount(value=>value+1)}}/>:
        <aside className="inspector part-inspector"><div className="inspector-body">
        {mode==='schematic'?<><PartIdentity part={part} library={schematic.libraries[part.libId]}/>
          <PartProperties part={part} active={open} spiceAvailable={spiceAvailable} tabAction={actions} onSave={()=>true}/></>:
          <LayoutProperties board={board} schematic={schematic} active={open} resetKey={false}
            actions={actions} spiceAvailable={spiceAvailable}
            footprint={footprint} rectangle={null} selectionCount={1} lockTargets={[]} onLock={()=>{}} snap={value=>value}
            onCommit={()=>false} onFootprint={()=>false} onTrack={()=>false} onZone={()=>false}
            onRectangle={()=>false} onError={()=>{}} onInspectFootprint={()=>{}} onSavePartProperties={()=>true}/>}
        </div></aside>}
      </EditorDisplayDrawer></div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'test-results/component-delete-ui.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 760 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addStyleTag({
    content:
      '.panel{width:280px;margin:24px}.panel>.editor-display-drawer{height:680px}.panel .inspector{position:relative;inset:auto;flex:1;width:100%;min-height:0;max-height:none;max-width:none;border:0;border-radius:0;box-shadow:none}*{transition:none!important}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const action = page.getByRole('button', { name: 'Delete object', exact: true });
  const reference = page.getByRole('textbox', { name: 'Component reference', exact: true });
  await reference.waitFor();
  const inspector = page.locator('.panel .inspector');
  const general = inspector.getByRole('tab', { name: 'General', exact: true });
  const spice = inspector.getByRole('tab', { name: 'SPICE', exact: true });
  await general.focus();
  await general.press('ArrowRight');
  assert.equal(await spice.getAttribute('aria-selected'), 'true');
  await spice.press('Tab');
  assert.equal(await action.evaluate((element) => element === document.activeElement), true);
  await action.press('Escape');
  const disclosure = page.getByRole('button', { name: 'Properties', exact: true });
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await disclosure.evaluate((element) => element === document.activeElement), true);
  await disclosure.click();
  await page.evaluate(() => window.setSpiceAvailable(false));
  await reference.waitFor();
  assert.equal(await inspector.getByRole('tablist').count(), 0);
  await checkComponentDeletePlacement(inspector);
  await page.evaluate(() => window.setSpiceAvailable(true));
  await general.waitFor();
  await mkdir('test-results', { recursive: true });
  for (const mode of ['schematic', 'layout', 'model']) {
    await page.evaluate((mode) => window.setDeleteMode(mode), mode);
    const field = mode === 'model' ? page.getByLabel('Solid name', { exact: true }) : reference;
    try {
      await field.waitFor();
    } catch (error) {
      assert.deepEqual(errors, [], `${mode} Properties mounts without renderer errors.`);
      throw error;
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const width of [280, 400]) {
        await page
          .locator('.panel')
          .evaluate((element, width) => (element.style.width = width + 'px'), width);
        await page.mouse.move(590, 750);
        const style = await action.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const icon = element.querySelector('svg'),
            iconBox = icon.getBoundingClientRect(),
            paint = getComputedStyle(icon);
          return {
            button: [box.width, box.height],
            icon: [iconBox.width, iconBox.height],
            border: paint.borderWidth,
            color: paint.color,
          };
        });
        assert.deepEqual(style.button, [30, 30]);
        assert.deepEqual(style.icon, [16, 16]);
        assert.equal(style.border, '0px');
        assert.equal(style.color, theme === 'dark' ? 'rgb(255, 150, 150)' : 'rgb(181, 42, 42)');
        if (mode === 'model') {
          const solid = page.getByRole('complementary', { name: 'Solid properties settings' });
          const row = solid.locator('.property-tabs-row');
          const apply = row.getByRole('button', { name: 'Apply', exact: true });
          const [rowBox, applyBox, deleteBox, nameBox, solidBox] = await Promise.all([
            row.boundingBox(),
            apply.boundingBox(),
            action.boundingBox(),
            field.boundingBox(),
            solid.boundingBox(),
          ]);
          assert.equal(await solid.locator('footer').count(), 0);
          assert.ok(Math.abs(solidBox.x + solidBox.width - deleteBox.x - deleteBox.width - 12) < 1);
          assert.ok(Math.abs(rowBox.y - solidBox.y - 8) < 1);
          assert.ok(applyBox.x + applyBox.width < deleteBox.x && applyBox.y === deleteBox.y);
          assert.ok(deleteBox.y + deleteBox.height < nameBox.y);
        } else {
          await checkComponentDeletePlacement(inspector);
        }
        assert.equal(
          await page.locator('.editor-display-drawer-header [aria-label="Delete object"]').count(),
          0,
        );
      }
      await page
        .locator('.panel')
        .screenshot({ path: 'test-results/component-delete-' + mode + '-' + theme + '.png' });
    }
    const count = await page.evaluate(() => window.deleteFixture.count);
    await field.dispatchEvent('compositionstart');
    await action.click();
    assert.equal(await page.evaluate(() => window.deleteFixture.count), count);
    await field.dispatchEvent('compositionend');
    assert.equal(
      await action.evaluate((element) => {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      true,
    );
    await action.focus();
    await action.press('Enter');
    assert.equal(await page.evaluate(() => window.deleteFixture.count), count + 1);
    await action.press('Space');
    assert.equal(await page.evaluate(() => window.deleteFixture.count), count + 2);
    if (mode === 'model') {
      await field.fill('Revised solid');
      assert.equal(await action.isDisabled(), true);
      const apply = page.getByRole('button', { name: 'Apply', exact: true });
      await field.dispatchEvent('compositionstart');
      await apply.click();
      assert.equal(await page.evaluate(() => window.deleteFixture.applied), 0);
      await field.dispatchEvent('compositionend');
      await apply.press('Enter');
      await page.waitForFunction(() => window.deleteFixture.applied === 1);
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Upper-right Properties actions in Schematic, Layout and Model, light/dark sizing, keyboard navigation and IME guards passed.',
  );
} finally {
  await browser.close();
}
