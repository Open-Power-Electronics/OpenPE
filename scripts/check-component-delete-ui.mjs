import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolated component presentation; no DesktopWorkspace recovery, services or native dialogs.
const bundle = await build({
  stdin: {
    contents: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Trash2} from 'lucide-react';
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
    function Fixture(){
      const [mode,setMode]=useState('schematic'),[count,setCount]=useState(0),[open,setOpen]=useState(true);
      window.deleteFixture={count};window.setDeleteMode=setMode;
      const actions=<button type="button" className="icon-button property-delete-action"
        aria-label="Delete object" title="Delete object" data-edit-action disabled={!open}
        onClick={()=>setCount(value=>value+1)}><Trash2 size={16}/></button>;
      return <div className="panel"><EditorDisplayDrawer label="Properties" open={open} onOpenChange={setOpen}>
        <aside className="inspector part-inspector"><div className="inspector-body">
        {mode==='schematic'?<><PartIdentity part={part} library={schematic.libraries[part.libId]}/>
          <PartProperties part={part} active={open} onSave={()=>true}/></>:
          <LayoutProperties board={board} schematic={schematic} active={open} resetKey={false}
            footprint={footprint} actions={actions} rectangle={null} selectionCount={1} snap={value=>value}
            onCommit={()=>false} onFootprint={()=>false} onTrack={()=>false} onZone={()=>false}
            onRectangle={()=>false} onError={()=>{}} onInspectFootprint={()=>{}}/>}
        </div>{mode==='schematic'&&<div className="inspector-footer">{actions}</div>}</aside>
      </EditorDisplayDrawer></div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,
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
  const page = await browser.newPage({ viewport: { width: 600, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      '.panel{width:280px;margin:24px}.panel>.editor-display-drawer{height:680px}.panel .inspector{flex:1;min-height:0;max-height:none;max-width:none}*{transition:none!important}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const action = page.getByRole('button', { name: 'Delete object', exact: true });
  const reference = page.getByRole('textbox', { name: 'Component reference', exact: true });
  await reference.waitFor();
  await mkdir('test-results', { recursive: true });
  for (const mode of ['schematic', 'layout']) {
    await page.evaluate((mode) => window.setDeleteMode(mode), mode);
    await reference.waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const width of [280, 400]) {
        await page
          .locator('.panel')
          .evaluate((element, width) => (element.style.width = width + 'px'), width);
        await page.mouse.move(590, 750);
        const style = await action.evaluate((element, mode) => {
          const box = element.getBoundingClientRect(),
            identity = element
              .closest(mode === 'schematic' ? '.inspector' : '.inspector-symbol')
              .getBoundingClientRect();
          const icon = element.querySelector('svg'),
            iconBox = icon.getBoundingClientRect(),
            paint = getComputedStyle(icon);
          return {
            button: [box.width, box.height],
            icon: [iconBox.width, iconBox.height],
            border: paint.borderWidth,
            color: paint.color,
            expected: getComputedStyle(element).getPropertyValue('--error-ink').trim(),
            right: Math.abs(box.right - identity.right + (mode === 'schematic' ? 13 : 0)) < 1,
            inside: box.top >= identity.top && box.bottom <= identity.bottom,
            bottom: mode !== 'schematic' || Math.abs(identity.bottom - box.bottom - 7) < 1,
          };
        }, mode);
        assert.deepEqual(style.button, [30, 30]);
        assert.deepEqual(style.icon, [16, 16]);
        assert.equal(style.border, '0px');
        assert.equal(style.color, theme === 'dark' ? 'rgb(255, 150, 150)' : 'rgb(181, 42, 42)');
        assert.ok(style.right && style.inside && style.bottom);
        assert.equal(
          await page.locator('.editor-display-drawer-header [aria-label="Delete object"]').count(),
          0,
        );
        assert.equal(await page.locator('.inspector-footer').count(), mode === 'schematic' ? 1 : 0);
      }
      await page
        .locator('.inspector')
        .screenshot({ path: 'test-results/component-delete-' + mode + '-' + theme + '.png' });
    }
    const count = await page.evaluate(() => window.deleteFixture.count);
    await reference.dispatchEvent('compositionstart');
    await action.click();
    assert.equal(await page.evaluate(() => window.deleteFixture.count), count);
    await reference.dispatchEvent('compositionend');
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
  }
  assert.deepEqual(errors, []);
  console.log(
    'Component-level delete placement, 30 px target, 16 px default-red icon, preview isolation, narrow/wide light/dark Schematic/Layout, Enter/Space and IME guards passed.',
  );
} finally {
  await browser.close();
}
