// Isolated browser check of the real Home/menu data hook. No Electron or providers.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const bundle = await build({
  stdin: {
    contents: `import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {useExampleList} from './components/useExampleList';
      import {homeExampleCatalog,homeRecent} from './lib/home-examples';
      import HomeProjectCard from './components/HomeProjectCard';
      import HomeProjectSection from './components/HomeProjectSection';
      import {switchingStageFixture} from './tests/fixtures/switching-stage';
      const listeners = new Set();
      const fixture = window.fixture = {entries:[...homeRecent], initialized:false, fail:false, exampleFail:false, listeners,
        refresh:()=>listeners.forEach(listener=>listener())};
      window.openpe = {
        listExamples:async()=>{
          if(fixture.exampleFail) throw Error('Examples unavailable');
          return {entries:homeExampleCatalog.map(item=>({...item,section:item.root})),warnings:[]};
        },
        listRecent:async()=>{
          if(fixture.fail) throw Error('Recent unavailable');
          return {initialized:fixture.initialized,entries:fixture.entries,warnings:[]};
        },
        previewRecent:async()=>switchingStageFixture(),
        removeRecent:async id=>{fixture.initialized=true;fixture.entries=fixture.entries.filter(entry=>entry.id!==id);fixture.refresh();},
        pinRecent:async(id,pinned)=>{
          const entry=fixture.entries.find(entry=>entry.id===id.replace(/^default:/,''));
          if(id.startsWith('default:')&&!pinned) fixture.entries=fixture.entries.filter(item=>item!==entry);
          else if(entry) {entry.pinned=pinned;fixture.entries=[...fixture.entries.filter(item=>item.pinned),...fixture.entries.filter(item=>!item.pinned)];}
          fixture.refresh();
        },
        onRecentChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback);},
      };
      function Fixture(){
        const [active,setActive]=useState(true);
        const list=useExampleList(active,'home');
        fixture.setActive=setActive; fixture.list=list;
        return <main>{list.sections.map(section=><div key={section.id} id={section.id}>
          <HomeProjectSection title={section.title}>{expanded=>section.examples.map(item=><HomeProjectCard key={item.id} entry={item}
            active={active && expanded} recent={section.title==='Recent'} revision={list.revision}
            onOpen={()=>{}} onError={message=>{fixture.actionError=message;}} />)}</HomeProjectSection>
          </div>)}<p role="alert">{list.error}</p></main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div>',
    }),
  );
  await page.goto('http://localhost');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await waitForAsync(page, () => window.fixture?.listeners.size === 1);
  assert.deepEqual(await page.locator('#recent-heading h3').allTextContents(), ['EMC Flyback']);
  assert.equal(await page.locator('#example-heading h3').count(), 9);
  const recentToggle = page.getByRole('button', { name: 'Recent', exact: true });
  const exampleToggle = page.getByRole('button', { name: 'Example', exact: true });
  await recentToggle.click();
  assert.equal(await recentToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#recent-heading .home-example').isVisible(), false);
  assert.equal(await exampleToggle.getAttribute('aria-expanded'), 'true');
  await recentToggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await recentToggle.getAttribute('aria-expanded'), 'true');
  await exampleToggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await exampleToggle.getAttribute('aria-expanded'), 'false');
  await exampleToggle.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  await exampleToggle.dispatchEvent('keyup', { key: 'Enter', isComposing: true, keyCode: 229 });
  assert.equal(await exampleToggle.getAttribute('aria-expanded'), 'false');
  await exampleToggle.click();
  await page
    .getByRole('button', { name: 'Open EMC Flyback example', exact: true })
    .click({ button: 'right' });
  assert.equal(
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
  await waitForAsync(page, () => document.querySelectorAll('#recent-heading h3').length === 0);
  await page.evaluate(() => window.fixture.refresh());
  assert.equal(await page.locator('#recent-heading h3').count(), 0);
  await page.evaluate(() => {
    window.fixture.entries = [
      { id: 'recent:one', title: 'Personal.kicad_pro', description: 'C:/Personal.kicad_pro' },
    ];
    window.fixture.initialized = true;
    window.fixture.refresh();
  });
  await waitForAsync(
    page,
    () => document.querySelector('#recent-heading h3')?.textContent === 'Personal',
  );
  assert.equal(
    await page.locator('#recent-heading h3').count(),
    1,
    'Unpinned default does not replace real history.',
  );
  assert.equal(await page.locator('#recent-heading small').textContent(), 'C:/Personal.kicad_pro');
  assert.equal(await page.getByRole('button', { name: 'Open Personal', exact: true }).count(), 1);
  await page.evaluate(() => {
    window.fixture.exampleFail = true;
    window.fixture.refresh();
  });
  await waitForAsync(page, () => window.fixture.list.error === 'Examples unavailable');
  assert.equal(await page.locator('#recent-heading h3').textContent(), 'Personal');
  await page.evaluate(() => {
    window.fixture.fail = true;
    window.fixture.refresh();
  });
  await waitForAsync(page, () => window.fixture.list.error.includes('Recent unavailable'));
  assert.equal(
    await page.locator('#recent-heading h3').count(),
    0,
    'Failure does not fabricate a default history.',
  );
  await page.evaluate(() => {
    window.fixture.fail = false;
    window.fixture.exampleFail = false;
    window.dispatchEvent(new Event('focus'));
  });
  await waitForAsync(page, () => window.fixture.list.error === '');
  assert.equal(await page.locator('#recent-heading h3').textContent(), 'Personal');
  await page.evaluate(() => window.fixture.setActive(false));
  await waitForAsync(page, () => window.fixture.listeners.size === 0);
  await page.evaluate(() => {
    window.fixture.entries = [
      { id: 'recent:two', title: 'Latest.kicad_pcb', description: 'C:/Latest.kicad_pcb' },
    ];
    window.fixture.setActive(true);
  });
  await waitForAsync(
    page,
    () => document.querySelector('#recent-heading h3')?.textContent === 'Latest.kicad_pcb',
  );
  const card = page.getByRole('button', { name: 'Open Latest.kicad_pcb', exact: true });
  await card.scrollIntoViewIfNeeded();
  await waitForAsync(page, () => document.querySelectorAll('#recent-heading svg use').length > 0);
  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await waitForAsync(page, () => window.fixture.list.sections[0].examples[0]?.pinned === true);
  assert.equal(await page.locator('#recent-heading small').textContent(), 'C:/Latest.kicad_pcb');
  assert.equal(await card.locator('.home-example-pin').count(), 1);
  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
  await waitForAsync(page, () => window.fixture.list.sections[0].examples[0]?.pinned === false);
  assert.equal(await page.locator('#recent-heading small').textContent(), 'C:/Latest.kicad_pcb');
  assert.equal(await card.locator('.home-example-pin').count(), 0);
  await card.focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Recent project actions', exact: true });
  await menu.waitFor();
  await menu.dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229 });
  assert.equal(await menu.isVisible(), true, 'IME cannot dismiss or activate the menu.');
  await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0);
  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
  await waitForAsync(page, () => document.querySelectorAll('#recent-heading h3').length === 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: default pinned EMC Flyback, Pin/Unpin, protected removal, live refresh, keyboard/IME, independent discovery failures and retry.',
  );
} finally {
  await browser.close();
}
