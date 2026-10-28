// Isolated retained SVG selection, StrictMode, and abandoned-render regression.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const mode = process.env.OPENPE_RENDER_MODE || 'development';
const bundle = await build({
  stdin: {
    contents: `import React,{memo,Suspense,StrictMode,startTransition,useLayoutEffect,useMemo,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {createLayoutSelection,useLayoutSelection} from './components/LayoutSelection';
      const Record=memo(function Record({selection,id,owner}){
        const selected=useLayoutSelection(selection,id,owner);
        window.renders[id]=(window.renders[id]||0)+1;
        useLayoutEffect(()=>{window.mounted++;return()=>window.mounted--},[]);
        return <g data-record={id} data-picked={String(selected)}><rect width="4" height="4"/></g>
      });
      const pending=new Promise(()=>{});
      function Fixture(){
        const [selection]=useState(createLayoutSelection),[ids,setIds]=useState([]),[blocked,setBlocked]=useState(false),[mounted,setMounted]=useState(true);
        window.selection=selection;
        window.pick=(next)=>setIds(next);
        window.stageAbandoned=()=>startTransition(()=>{setIds(['abandoned']);setBlocked(true)});
        window.abortPending=()=>{setIds(['second']);setBlocked(false)};
        window.unmount=()=>setMounted(false);
        const records=useMemo(()=>['first','second','abandoned','unrelated'].map(id=><Record key={id} selection={selection} id={id}/>).concat(<Record key="zone" selection={selection} id="zone" owner="first"/>),[selection]);
        useLayoutEffect(()=>selection.update(new Set(ids),new Set()),[selection,ids]);
        if(blocked)throw pending;
        return <svg>{mounted&&records}</svg>
      }
      window.renders={};window.mounted=0;
      createRoot(document.getElementById('root')).render(<StrictMode><Suspense fallback={<span>Pending</span>}><Fixture/></Suspense></StrictMode>);`,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-record="first"]').waitFor();
  const frame = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const state = () =>
    page.evaluate(() => ({
      renders: { ...window.renders },
      mounted: window.mounted,
      selected: [...document.querySelectorAll('[data-picked="true"]')].map(
        (node) => node.dataset.record,
      ),
      abandoned: window.selection.has('abandoned'),
    }));
  await frame();
  const initial = await state();
  assert.equal(
    initial.mounted,
    5,
    'StrictMode subscriptions clean up and remount once per record.',
  );
  await page.evaluate(() => window.pick(['first']));
  await frame();
  const first = await state();
  assert.deepEqual(first.selected, ['first', 'zone']);
  for (const id of ['second', 'abandoned', 'unrelated'])
    assert.equal(first.renders[id], initial.renders[id]);
  await page.evaluate(() => window.pick(['first']));
  await frame();
  assert.deepEqual(
    await state(),
    first,
    'Equivalent selection updates never notify retained SVG records.',
  );
  await page.evaluate(() => window.stageAbandoned());
  await frame();
  assert.deepEqual(
    await state(),
    first,
    'An abandoned suspended render cannot publish selection or tear the displayed drawing.',
  );
  await page.evaluate(() => window.abortPending());
  await frame();
  const second = await state();
  assert.deepEqual(second.selected, ['second']);
  assert.equal(second.abandoned, false);
  assert.equal(second.renders.unrelated, initial.renders.unrelated);
  assert.equal(second.renders.abandoned, initial.renders.abandoned);
  await page.evaluate(() => window.unmount());
  await frame();
  const unmounted = await state();
  assert.equal(unmounted.mounted, 0);
  await page.evaluate(() => window.pick(['first', 'second', 'abandoned']));
  await frame();
  assert.deepEqual(
    (await state()).renders,
    unmounted.renders,
    'Unmount removes every item/owner subscription.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Layout selection subscriptions: ' +
      mode +
      ' retained records, owner selection, equivalent updates, StrictMode, abandoned render and cleanup passed.',
  );
} finally {
  await browser.close();
}
