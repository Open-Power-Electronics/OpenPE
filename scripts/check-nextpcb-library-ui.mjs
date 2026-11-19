import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Isolated chooser fixtures: no Electron, provider, remote library or user data.
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import LibraryChooser from './components/LibraryChooser';
      import symbols from './lib/kicad-starter-symbols.json';
      import {quote, val} from './lib/sexpr';
      const local = {id:'Device:R',name:'R',library:'Device',description:'Local resistor',keywords:'resistor',package:'0805'};
      const ground = {id:'power:GND',name:'GND',library:'power',description:'Ground',keywords:'ground'};
      const online = [1001,1002].map((id,index) => ({
        id:'NextPCB:'+id,name:'Online amplifier '+(index+1),library:'NextPCB',
        description:'Online fixture amplifier '+(index+1),keywords:'amplifier',footprint:index===0?'NextPCB:1001':'',
        footprintPreview:index===0?'2d-and-3d':'unavailable',
        manufacturer:'Fixture Semiconductor',package:'SOIC-8',category:'1737',
      }));
      const resistor = {id:'NextPCB:1003',name:'Online resistor',library:'NextPCB',description:'Online resistor',keywords:'resistor',manufacturer:'Fixture Passives',package:'0603',category:'201'};
      const regulator = {...resistor,id:'NextPCB:1004',name:'Online regulator',keywords:'regulator',category:'302'};
      const jlc = {id:'JLCPCB:C7593',name:'NE555DR',library:'JLCPCB',description:'Timer',keywords:'timer',package:'SOIC-8',footprintPreview:'2d-and-3d'};
      const jlcRows = [jlc,...Array.from({length:124},(_,index)=>({
        ...jlc,id:'JLCPCB:C'+(9000+index),name:'Timer '+(index+1),footprintPreview:undefined,
      }))];
      const jlcAllRows = [{...jlc,id:'JLCPCB:C8000',name:'Unfiltered catalog part',footprintPreview:'unavailable'},...jlcRows];
      const kicadRows = [local,...Array.from({length:79},(_,index)=>({
        ...local,id:'Device:Fixture'+(index+1),name:'KiCad fixture '+(index+1),
      }))];
      const paged = Array.from({length:120},(_,index)=>({
        ...online[0],id:'NextPCB:'+(2000+index),name:'Paged amplifier '+String(index+1).padStart(3,'0'),
        description:'Paged fixture amplifier',
      }));
      const overlapping = Array.from({length:120},(_,index)=>({
        ...online[0],id:'NextPCB:'+(4000+index),name:'Overlap amplifier '+String(index+1).padStart(3,'0'),
        description:'Overlapping-page fixture amplifier',
      }));
      const searchable = [local,ground,...online,resistor,regulator,...paged];
      const entries = [...searchable,...overlapping,...jlcAllRows,...kicadRows.slice(1)];
      const fixture = window.fixture = {
        requests:[], chosen:[], closed:0, failNextSearch:false, failNextAppend:false, failNextCategories:true,
        blockedCad:false,
        holdSearch:false, holdCategories:true, releaseCategories:null, editedAt:0,
        holdJlcPage:false, releaseJlcPage:null, checkedBrowseFixture:false,
        heldDetails:new Set(), pendingDetails:new Map(), pendingSearch:[],
        releaseDetail(id) {
          for (const resolve of this.pendingDetails.get(id) || []) resolve();
          this.pendingDetails.delete(id);
          this.heldDetails.delete(id);
        },
        releaseSearch() {
          this.holdSearch = false;
          this.pendingSearch.splice(0).forEach(resolve => resolve());
        },
      };
      const capabilityHost = {async query(action,input,{signal,onProgress}) {
        const request = {action,input,aborted:signal.aborted};
        fixture.requests.push(request);
        signal.addEventListener('abort',()=>{request.aborted=true;},{once:true});
        if(action==='library.categories') {
          if(input.source==='JLCPCB')
            return {categories:[{id:'20',name:'Clock/Timing',children:[{id:'228',name:'555 Timers / Counters',children:[]}]}]};
          if(input.source==='NextPCB'&&fixture.holdCategories) {
            await new Promise(resolve=>{fixture.releaseCategories=resolve;});
          }
          if(input.source==='NextPCB'&&fixture.failNextCategories) {
            fixture.failNextCategories=false;
            throw new Error('NextPCB categories are temporarily unavailable.');
          }
          return {categories: input.source==='KiCad'
            ? ['Device','power'].map(id=>({id,name:id,children:[]}))
            : [
                {id:'100',name:'Amplifiers',children:[
                  {id:'1737',name:'Operational amplifiers',children:[]},
                  {id:'102',name:'Instrumentation amplifiers',children:[]},
                ]},
                {id:'200',name:'Passives',children:[{id:'201',name:'Resistors',children:[]}]},
                {id:'300',name:'Power management',children:[{id:'301',name:'Regulators',children:[{id:'302',name:'Switching regulators',children:[]}]}]},
                {id:'400',name:'Discrete components',children:[]},
              ]};
        }
        if (action === 'library.search') {
          if (input.library === 'JLCPCB') {
            const matches = !input.category ? jlcAllRows : ['20','228'].includes(input.category) ? jlcRows : [];
            if (input.query === 'SOIC-8' && !input.category)
              return {entries:[jlc],total:1,nextOffset:null,libraries:['JLCPCB']};
            if (input.query === 'blocked') return {entries:[{...jlc,footprintPreview:undefined}],total:1,nextOffset:null,libraries:['JLCPCB']};
            if (input.query === 'sparse') {
              if (input.offset === 0) return {entries:[],total:13,nextOffset:12,libraries:['JLCPCB']};
              return {entries:[jlc],total:13,nextOffset:null,libraries:['JLCPCB']};
            }
            if (input.query === 'LM2596') {
              if (input.offset === 0) return {entries:jlcRows.slice(0,12),total:25,nextOffset:16,libraries:['JLCPCB']};
              if (input.offset !== 16) throw new Error('The filtered batch must advance by its raw cursor.');
              return {entries:jlcRows.slice(11,20),total:25,nextOffset:null,libraries:['JLCPCB']};
            }
            if (fixture.holdJlcPage && !input.category && !input.query && input.offset === 12) {
              onProgress?.({completed:5,total:12});
              await new Promise(resolve => {fixture.releaseJlcPage=resolve;});
            }
            const end = input.offset + (input.includeAssetStatus ? 12 : 100);
            return {entries:matches.slice(input.offset,end),total:matches.length,nextOffset:end<matches.length?end:null,libraries:['JLCPCB']};
          }
          if (fixture.checkedBrowseFixture && input.includeAssetStatus && !input.query) {
            const nextpcb = input.library === 'NextPCB';
            const matches = nextpcb ? [...online,...paged] : kicadRows;
            const end = input.offset + (nextpcb ? 12 : 24);
            return {entries:matches.slice(input.offset,end),total:matches.length,nextOffset:end<matches.length?end:null,
              libraries:nextpcb?['NextPCB']:['Device','power']};
          }
          if (input.library === 'NextPCB' && input.offset > 0 && fixture.failNextAppend) {
            fixture.failNextAppend = false;
            throw new Error('NextPCB fixture page is temporarily unavailable.');
          }
          if (input.library === 'NextPCB' && fixture.failNextSearch) {
            fixture.failNextSearch = false;
            throw new Error('NextPCB fixture is temporarily unavailable.');
          }
          if (fixture.holdSearch) {
            if (input.includeAssetStatus) onProgress?.({completed:7,total:16});
            await new Promise(resolve => fixture.pendingSearch.push(resolve));
          }
          if (input.library === 'NextPCB' && input.query === 'Overlap') {
            const pages = {
              0: overlapping.slice(0,16),
              16: overlapping.slice(12,28),
              32: overlapping.slice(28,44),
              48: overlapping.slice(44,52),
            };
            if (!Object.hasOwn(pages,input.offset))
              throw new Error('Unexpected overlapping-page offset: '+input.offset);
            return {entries:pages[input.offset],total:56,nextOffset:({0:16,16:32,32:48,48:null})[input.offset],libraries:['NextPCB']};
          }
          if (input.library === 'NextPCB' && input.query === 'package:0603' && input.category === '201') {
            return {entries:input.offset === 50 ? [resistor] : [],total:51,
              nextOffset:input.offset === 50 ? null : 50,libraries:['NextPCB']};
          }
          if (input.library === 'NextPCB' && input.query === '0603' && !input.category) {
            if (input.offset !== 0) throw new Error('Bare package search must start at offset 0.');
            return {entries:[resistor],total:1,nextOffset:null,libraries:['NextPCB']};
          }
          const matches = searchable.filter(entry =>
            (input.library === 'NextPCB' ? entry.library === 'NextPCB' : entry.library !== 'NextPCB'&&(!input.library||entry.library===input.library)) &&
            (!input.category || entry.category===input.category || input.category==='100'&&['1737','102'].includes(entry.category) || input.category==='200'&&entry.category==='201' || ['300','301'].includes(input.category)&&entry.category==='302') &&
            (!input.query || [entry.name,entry.description,entry.keywords,entry.manufacturer].join(' ').toLowerCase().includes(input.query.toLowerCase())));
          const end = input.offset + (input.includeAssetStatus ? 16 : 100);
          return {entries:matches.slice(input.offset,end),total:!input.library&&!input.query?22712:matches.length,nextOffset:end<matches.length?end:null,libraries:input.library==='NextPCB'?['NextPCB']:['Device','power']};
        }
        if (action === 'library.detail') {
          if (input.id === jlc.id && fixture.blockedCad) throw new Error('EasyEDA CAD denied the request (HTTP 403).');
          if (fixture.heldDetails.has(input.id))
            await new Promise(resolve => {
              const pending = fixture.pendingDetails.get(input.id) || [];
              pending.push(resolve); fixture.pendingDetails.set(input.id,pending);
            });
          const entry = entries.find(entry => entry.id === input.id);
          if (!entry) throw new Error('Unknown fixture symbol.');
          const symbol = structuredClone(symbols['Device:R']);
          symbol[1] = quote(entry.id);
          return {
            ...entry,symbol,units:1,
            ...(entry.id==='NextPCB:1001'?{footprintPreview:'2d-and-3d'}:{}),
            ...(entry.id===jlc.id?{footprint:entry.id,footprintPreview:'2d-and-3d'}:{}),
          };
        }
        throw new Error('Unexpected fixture capability.');
      }};
      function App() {
        const [open,setOpen] = useState(true);
        window.reopenChooser=()=>setOpen(true);
        return open && <LibraryChooser kind="symbols" capabilityHost={capabilityHost}
          onClose={()=>{fixture.closed++;setOpen(false);}}
          onChoose={(detail,unit,model)=>{
            fixture.chosen.push({
              id:detail.id,library:detail.library,nativeId:val(detail.symbol),unit,model,
            });
          }}/>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
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
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const errors = [];
  const priceRequests = [];
  let priceReply;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.url() === 'http://localhost/api/browser-preview/session')
      return route.fulfill({ json: { token: 'a'.repeat(64) } });
    if (request.url() === 'http://localhost/api/browser-preview/price') {
      priceRequests.push(request.postDataJSON());
      return route.fulfill(await priceReply);
    }
    if (request.url() === 'http://localhost/brand/openpe-mark.svg')
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: await readFile('public/brand/openpe-mark.svg'),
      });
    return route.request().url() === 'http://localhost/'
      ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
      : route.abort();
  });
  await page.goto('http://localhost/');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const chooser = page.getByRole('dialog', { name: 'Components', exact: true });
  const rows = page.locator('.library-results button[data-index]');
  const place = page.getByRole('button', { name: 'Place', exact: true });
  const search = page.getByRole('textbox', { name: 'Search components', exact: true });
  const submit = page.getByRole('button', { name: 'Search', exact: true });
  const source = page.getByRole('combobox', { name: 'Library source', exact: true });
  const categoryLevel = (level) =>
    page.getByRole('combobox', { name: `Category level ${level}`, exact: true });
  const categoryPath = async () =>
    (
      await Promise.all(
        [1, 2].map(async (level) =>
          (await categoryLevel(level).isDisabled()) ? '' : await categoryLevel(level).textContent(),
        ),
      )
    )
      .filter((label) => label && !label.startsWith('All'))
      .join(' / ');
  const resultCount = page.locator('.library-filter > [role="status"]');
  const listbox = (name) => page.getByRole('listbox', { name, exact: true });
  const option = (name, text) => listbox(name).getByRole('option', { name: text, exact: true });
  const searchCount = () =>
    page.evaluate(
      () => window.fixture.requests.filter((request) => request.action === 'library.search').length,
    );
  const browseState = () =>
    page.evaluate(() => ({
      rows: [...document.querySelectorAll('.library-results button[data-index]')].map((node) => ({
        id: node.getAttribute('aria-description'),
        selected: node.getAttribute('aria-pressed'),
      })),
      detail: document.querySelector('.library-detail')?.textContent,
      count: document.querySelector('.library-result-status')?.textContent,
      requests: fixture.requests.filter((request) => request.action === 'library.search').length,
    }));
  const waitForDetail = async (id) => {
    await page.waitForFunction(
      (expected) =>
        document.querySelector('.library-detail-id')?.textContent === expected &&
        !document.querySelector('.dialog-button.primary')?.disabled,
      id,
    );
  };

  async function chooseSource(name) {
    await source.click();
    await option('Library source', name).click();
  }
  async function chooseCategory(labels) {
    for (const [index, label] of [
      labels[0],
      ...(labels.length > 1 ? [labels.slice(1).join(' / ')] : []),
    ].entries()) {
      await categoryLevel(index + 1).click();
      await option(`Category level ${index + 1}`, label).click();
    }
  }

  await waitForDetail('Device:R');
  assert.equal(await chooser.getByRole('combobox', { name: 'Price source' }).isVisible(), true);
  assert.equal(await categoryLevel(2).isDisabled(), true);
  assert.equal(
    await page.getByRole('button', { name: 'Footprint', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole('button', { name: '3D model', exact: true }).isDisabled(),
    true,
  );
  const initialBrowse = await browseState();
  await search.fill('draft local');
  await search.fill('');
  await search.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await page.waitForTimeout(200);
  assert.deepEqual(
    await browseState(),
    initialBrowse,
    'Local drafts and clearing retain the accepted browse state.',
  );
  assert.equal(await resultCount.textContent(), '22,712 results');
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.requests.filter(
          (request) =>
            request.action === 'library.categories' && request.input.source === 'NextPCB',
        ).length,
    ),
    0,
  );
  await source.click();
  assert.deepEqual(await listbox('Library source').getByRole('option').allTextContents(), [
    'KiCad',
    'NextPCB',
    'JLCPCB',
  ]);
  assert.equal(
    await listbox('Library source')
      .getByRole('option', { name: /Texas Instruments/ })
      .count(),
    0,
  );
  await option('Library source', 'KiCad').click();

  // Online categories are loaded only after the user explicitly selects NextPCB.
  await page.evaluate(() => (fixture.holdSearch = true));
  await chooseSource('NextPCB');
  await page.getByRole('status', { name: 'Loading library', exact: true }).waitFor();
  await page.waitForFunction(
    () => fixture.pendingSearch.length === 1 && typeof fixture.releaseCategories === 'function',
  );
  const progress = page.getByRole('progressbar', { name: 'Loading library', exact: true });
  await progress.waitFor();
  assert.equal(await progress.getAttribute('aria-valuenow'), '7');
  assert.equal(await progress.getAttribute('aria-valuemax'), '16');
  assert.equal(await progress.locator('span').getAttribute('style'), 'width: 43.75%;');
  assert.equal(await page.getByText('7 / 16 loaded', { exact: true }).isVisible(), true);
  assert.ok(await page.locator('.loading-mark img').count());
  assert.equal(await page.locator('.loading-mark').count(), 1);
  await mkdir('test-results/library-chooser-ui', { recursive: true });
  await page.screenshot({ path: 'test-results/library-chooser-ui/loading.png' });
  await page.evaluate(() => fixture.releaseSearch());
  await progress.waitFor({ state: 'hidden' });
  await waitForDetail('NextPCB:1001');
  assert.equal(await resultCount.textContent(), '16 results loaded');
  const pricing = chooser.getByRole('region', { name: 'Price', exact: true });
  assert.equal(
    await pricing.evaluate((section) => section.parentElement.lastElementChild === section),
    true,
  );
  const checkPrice = pricing.getByRole('button', { name: 'Check price', exact: true });
  const retryPrice = pricing.getByRole('button', { name: 'Retry price check', exact: true });
  const refreshPrice = pricing.getByRole('button', { name: 'Refresh price', exact: true });
  const quoteStatus = pricing.getByRole('status');
  const checkedAt = 1_760_000_000_000;
  const quote = {
    source: 'huaqiu',
    currency: 'USD',
    checkedAt,
    offers: [
      {
        sku: 'FIXTURE-123',
        manufacturer: 'Fixture Semiconductor',
        stock: 1200,
        tiers: [{ quantity: 10, unitPrice: 0.08 }],
      },
      {
        sku: 'FIXTURE-456',
        manufacturer: null,
        stock: 0,
        tiers: [{ quantity: 5, unitPrice: 0.07 }],
      },
    ],
  };
  assert.equal(priceRequests.length, 0);
  const htmlReply = Promise.withResolvers();
  priceReply = htmlReply.promise;
  const composingPriceKeyBlocked = await checkPrice.evaluate((button) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(composingPriceKeyBlocked, true);
  await checkPrice.press('Enter');
  await quoteStatus.getByText('Checking HQ Online…', { exact: true }).waitFor();
  assert.equal(await checkPrice.isDisabled(), true);
  await checkPrice.press('Enter');
  htmlReply.resolve({ contentType: 'text/html', body: '<!DOCTYPE html><title>OpenPE</title>' });
  await quoteStatus.getByText(/Price service unavailable/).waitFor();
  assert.equal(await retryPrice.evaluate((button) => button === document.activeElement), true);
  assert.deepEqual(priceRequests, [{ id: 'NextPCB:1001', kind: 'symbols', source: 'huaqiu' }]);

  priceReply = { json: quote };
  await retryPrice.press('Space');
  await pricing.getByRole('cell', { name: '$0.08', exact: true }).waitFor();
  const priceTables = pricing.getByRole('table');
  assert.equal(await priceTables.first().locator('caption').textContent(), 'Fixture Semiconductor');
  assert.equal(await priceTables.last().locator('caption').count(), 0);
  assert.equal(await pricing.getByText(/FIXTURE-123|FIXTURE-456/).count(), 0);
  const firstPriceFooter = priceTables.first().locator('tfoot');
  const lastPriceFooter = priceTables.last().locator('tfoot');
  assert.equal(await firstPriceFooter.getByText('Stock 1,200', { exact: true }).isVisible(), true);
  assert.equal(await firstPriceFooter.locator('time').count(), 0);
  assert.equal(await lastPriceFooter.getByText('Stock 0', { exact: true }).isVisible(), true);
  assert.ok(
    await priceTables.evaluateAll((tables) =>
      tables.every((table) => {
        const body = table.tBodies[0].getBoundingClientRect();
        const footer = table.tFoot.querySelector('.library-price-footer').getBoundingClientRect();
        const stock = table.tFoot
          .querySelector('.library-price-footer')
          .lastElementChild.getBoundingClientRect();
        return footer.top >= body.bottom && Math.abs(stock.right - body.right) <= 1;
      }),
    ),
    'Stock aligns with the right edge below each price table.',
  );
  const checkedDate = new Date(checkedAt).toISOString();
  assert.equal(await lastPriceFooter.locator('time').getAttribute('datetime'), checkedDate);
  priceReply = { json: { ...quote, checkedAt: Number.MAX_SAFE_INTEGER } };
  await refreshPrice.click();
  await quoteStatus.getByText('Could not check prices. Try again.', { exact: true }).waitFor();
  assert.equal(await pricing.getByRole('cell', { name: '$0.08', exact: true }).isVisible(), true);
  assert.match(await pricing.locator('.library-price-checked').textContent(), /^Last checked /);
  assert.equal(await pricing.locator('time').getAttribute('datetime'), checkedDate);
  assert.equal(await place.isEnabled(), true);
  await pricing.screenshot({ path: 'test-results/library-chooser-ui/price-retry.png' });
  const priceSource = pricing.getByRole('combobox', { name: 'Price source' });
  async function assertPriceSourceFits(name) {
    const label = priceSource.locator('.select-value');
    const viewport = page.viewportSize();
    for (const width of [viewport.width, 360]) {
      await page.setViewportSize({ ...viewport, width });
      assert.equal(await label.textContent(), name);
      assert.ok(
        await label.evaluate((element) => element.scrollWidth <= element.clientWidth),
        `The selected price source ${name} should fit at ${width}px.`,
      );
    }
    await page.setViewportSize(viewport);
  }
  await assertPriceSourceFits('HQ Online');
  await priceSource.press('Enter');
  assert.deepEqual(await listbox('Price source').getByRole('option').allTextContents(), [
    'LCSC Electronics',
    'HQ Online',
  ]);
  await page.getByRole('option', { name: 'LCSC Electronics', exact: true }).click();
  await assertPriceSourceFits('LCSC Electronics');
  assert.equal(await pricing.getByRole('table').count(), 0);
  assert.equal(priceRequests.length, 3);
  priceReply = { json: { ...quote, source: 'lcsc', offers: [] } };
  await checkPrice.press('Enter');
  await quoteStatus
    .getByText('No USD quote from LCSC Electronics for this component.', { exact: true })
    .waitFor();
  assert.deepEqual(priceRequests.at(-1), { id: 'NextPCB:1001', kind: 'symbols', source: 'lcsc' });
  await priceSource.press('Enter');
  await page.getByRole('option', { name: 'HQ Online', exact: true }).click();
  await pricing.getByRole('cell', { name: '$0.08', exact: true }).waitFor();
  priceReply = { json: { ...quote, offers: [] } };
  await refreshPrice.click();
  await quoteStatus
    .getByText('No USD quote from HQ Online for this component.', { exact: true })
    .waitFor();
  assert.equal(await pricing.getByRole('table').count(), 0);
  await rows.nth(1).click();
  await waitForDetail('NextPCB:1002');
  assert.equal(await checkPrice.isEnabled(), true);
  assert.equal(await pricing.locator('time').count(), 0);
  await rows.first().click();
  await waitForDetail('NextPCB:1001');
  assert.equal(await checkPrice.isEnabled(), true);
  assert.equal(priceRequests.length, 5);

  const catalogSearches = () =>
    page.evaluate(() =>
      fixture.requests
        .filter(
          (request) => request.action === 'library.search' && request.input.library === 'NextPCB',
        )
        .map(({ input }) => input),
    );
  const initialCatalogSearches = await catalogSearches();
  assert.equal(initialCatalogSearches.length, 1);
  assert.equal(initialCatalogSearches[0].query, '');
  assert.equal(initialCatalogSearches[0].category, undefined);
  assert.equal(await rows.locator('[title="Online resistor"]').count(), 1);
  await page.evaluate(() => {
    fixture.holdCategories = false;
    fixture.releaseCategories();
  });
  assert.equal(await search.inputValue(), '');
  await categoryLevel(1).click();
  await option('Category level 1', 'Categories unavailable').waitFor();
  assert.equal(
    await option('Category level 1', 'Categories unavailable').getAttribute('aria-disabled'),
    'true',
  );
  await categoryLevel(1).press('Escape');
  const retryCategories = chooser.getByRole('button', { name: 'Retry categories', exact: true });
  assert.equal(await retryCategories.isEnabled(), true);
  const categoryRequestCount = () =>
    page.evaluate(
      () =>
        fixture.requests.filter(
          (request) =>
            request.action === 'library.categories' && request.input.source === 'NextPCB',
        ).length,
    );
  const beforeCategoryRetry = await categoryRequestCount();
  await retryCategories.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await page.waitForTimeout(50);
  assert.equal(await categoryRequestCount(), beforeCategoryRetry);
  await page.evaluate(() => {
    window.fixture.holdCategories = true;
    window.fixture.releaseCategories = null;
    window.fixture.failNextCategories = true;
  });
  await retryCategories.click();
  await page.waitForFunction(() => typeof fixture.releaseCategories === 'function');
  await retryCategories.waitFor({ state: 'detached' });
  assert.equal(await categoryRequestCount(), beforeCategoryRetry + 1);
  assert.deepEqual(await catalogSearches(), initialCatalogSearches);
  assert.equal(await rows.count(), 16);
  await page.evaluate(() => {
    fixture.holdCategories = false;
    fixture.releaseCategories();
  });
  await page
    .getByText('NextPCB categories are temporarily unavailable.', { exact: true })
    .waitFor();
  assert.equal(
    await retryCategories.isEnabled(),
    true,
    'A repeated category failure remains retryable.',
  );
  await retryCategories.click();
  assert.equal(await source.textContent(), 'NextPCB');
  assert.equal(await categoryLevel(1).textContent(), 'All categories');
  await page
    .getByText('NextPCB categories are temporarily unavailable.', { exact: true })
    .waitFor({ state: 'detached' });
  assert.deepEqual(await catalogSearches(), initialCatalogSearches);
  await page.evaluate(() => (fixture.failNextSearch = true));
  await submit.click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'NextPCB fixture is temporarily unavailable.' })
    .waitFor();
  assert.equal(await resultCount.textContent(), 'Unavailable');
  assert.equal(await rows.count(), 0);
  assert.equal(await page.locator('.library-detail-id').count(), 0);
  assert.equal(await place.isDisabled(), true);
  await chooser.getByRole('button', { name: 'Retry loading results' }).click();
  await waitForDetail('NextPCB:1001');
  assert.equal(await resultCount.textContent(), '16 results loaded');

  assert.equal(await chooser.getByText(/^Browse suggestions ·/).count(), 0);
  await rows.nth(1).click();
  await waitForDetail('NextPCB:1002');
  assert.equal(await categoryLevel(1).textContent(), 'All categories');
  const beforeSameAll = await searchCount();
  await categoryLevel(1).click();
  await option('Category level 1', 'All categories').click();
  await page.waitForTimeout(50);
  assert.equal(await searchCount(), beforeSameAll);
  await chooseCategory(['Amplifiers', 'Operational amplifiers']);
  await waitForDetail('NextPCB:1001');

  // Failed online searches do not inherit the prior source's count or candidates.
  await chooseSource('KiCad');
  await waitForDetail('Device:R');
  assert.equal(await resultCount.textContent(), '22,712 results');
  await chooseCategory(['Device']);
  await waitForDetail('Device:R');
  await search.fill('resistor');
  await submit.click();
  await waitForDetail('Device:R');
  assert.equal(await rows.count(), 1);
  await chooseSource('NextPCB');
  await waitForDetail('NextPCB:1001');
  assert.equal(await resultCount.textContent(), '16 results loaded');

  // Online edits do not search until Search or non-composing input Enter.
  const onlineBrowse = await browseState();
  await search.fill('Online');
  const beforeSubmit = await searchCount();
  await page.evaluate(() => {
    window.fixture.editedAt = performance.now();
  });
  await waitForAsync(page, () => performance.now() - window.fixture.editedAt > 350);
  assert.equal(await searchCount(), beforeSubmit);
  assert.deepEqual(
    await browseState(),
    onlineBrowse,
    'Online draft retains rows, selection, count and preview.',
  );
  assert.equal(await page.getByRole('status', { name: 'Loading library', exact: true }).count(), 0);
  await search.press('Enter');
  await waitForDetail('NextPCB:1001');
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.locator('small').count(), 0);
  assert.equal(
    await page
      .locator('.library-detail')
      .getByText('Fixture Semiconductor', { exact: true })
      .count(),
    1,
  );
  assert.deepEqual(await rows.locator('.library-result-package').allTextContents(), [
    'SOIC-8',
    'SOIC-8',
  ]);
  const sortBy = (column) =>
    chooser.getByRole('button', { name: `Sort by ${column}`, exact: true });
  const rowIds = () =>
    rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-description')));
  const originalOrder = ['NextPCB:1001', 'NextPCB:1002'];
  const reversedOrder = [...originalOrder].reverse();
  const beforeSort = await page.evaluate(() => fixture.requests.length);
  assert.equal(
    await sortBy('Name').evaluate((button) =>
      button.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          keyCode: 229,
        }),
      ),
    ),
    false,
    'Composing Enter cannot activate a sort header.',
  );
  await sortBy('Name').press('Enter');
  assert.deepEqual(await rowIds(), originalOrder);
  await sortBy('Name').press('Space');
  assert.equal(await sortBy('Name').getAttribute('aria-description'), 'Sorted descending');
  assert.deepEqual(await rowIds(), reversedOrder);
  assert.equal(await rows.last().getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.library-detail-id').textContent(), 'NextPCB:1001');
  assert.equal(await page.evaluate(() => fixture.requests.length), beforeSort);
  await search.press('ArrowUp');
  await waitForDetail('NextPCB:1002');
  await search.press('ArrowDown');
  await waitForDetail('NextPCB:1001');
  await sortBy('Name').click();
  assert.deepEqual(await rowIds(), originalOrder);
  for (const column of ['Footprint', 'Model']) {
    const checked = rows.first().getByTitle(`${column}: Available`);
    const unchecked = rows.last().getByTitle(`${column}: Unavailable`);
    assert.equal(await checked.getAttribute('data-status'), 'yes');
    assert.equal(await unchecked.getAttribute('data-status'), 'no');
    assert.equal(await checked.locator('svg').count(), 1);
    assert.equal(await unchecked.locator('svg').count(), 1);
    assert.match(await unchecked.locator('svg').getAttribute('class'), /\blucide-square\b(?!-)/);
    assert.equal(await checked.textContent(), '');
    assert.equal(await unchecked.textContent(), '');
    await sortBy(column).click();
    assert.deepEqual(await rowIds(), originalOrder);
    await sortBy(column).click();
    assert.deepEqual(await rowIds(), reversedOrder);
    await sortBy(column).click();
    assert.deepEqual(await rowIds(), originalOrder);
  }
  const packageSort = sortBy('Package');
  await packageSort.press('Enter');
  assert.deepEqual(await rowIds(), originalOrder, 'Equal package names keep the catalog order.');
  await packageSort.press('Enter');
  await packageSort.press('Enter');
  assert.equal(await packageSort.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => window.fixture.chosen.length), 0);
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.fixture.requests.filter((request) => request.action === 'library.search').at(-1)
          .input,
    ),
    {
      kind: 'symbols',
      query: 'Online',
      library: 'NextPCB',
      offset: 0,
      category: '1737',
      includeAssetStatus: true,
    },
  );

  // Clearing retains accepted results until an explicit submit.
  const beforeClear = await browseState();
  await search.fill('');
  await page.waitForTimeout(200);
  assert.deepEqual(await browseState(), beforeClear);
  await submit.click();
  await waitForDetail('NextPCB:1001');
  assert.equal(await resultCount.textContent(), '16 results loaded');
  const defaultSearch = await page.evaluate(
    () =>
      window.fixture.requests.filter((request) => request.action === 'library.search').at(-1).input,
  );
  assert.equal(defaultSearch.query, '');
  await search.fill('Online');
  await submit.click();
  await waitForDetail('NextPCB:1001');

  // Returning to a source restores its category, query, results and preview.
  await search.fill('Unsubmitted amplifier draft');
  const beforeSourceSwitch = await searchCount();
  await chooseSource('KiCad');
  await waitForDetail('Device:R');
  assert.equal(await categoryLevel(1).textContent(), 'Device');
  assert.equal(await search.inputValue(), 'resistor');
  assert.equal(await rows.count(), 1);
  await chooseSource('NextPCB');
  await waitForDetail('NextPCB:1001');
  assert.equal(await search.inputValue(), 'Unsubmitted amplifier draft');
  assert.equal(await categoryPath(), 'Amplifiers / Operational amplifiers');
  assert.equal(await rows.count(), 2);
  assert.equal(await searchCount(), beforeSourceSwitch);
  await chooseSource('NextPCB');
  assert.equal(await categoryPath(), 'Amplifiers / Operational amplifiers');
  assert.equal(await search.inputValue(), 'Unsubmitted amplifier draft');
  assert.equal(await searchCount(), beforeSourceSwitch);

  // A slow old selection must not authorize placement while the new one loads.
  await search.fill('');
  await chooseCategory(['Power management', 'Regulators', 'Switching regulators']);
  await waitForDetail('NextPCB:1004');
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.requests.filter((request) => request.action === 'library.search').at(-1)
          .input.category,
    ),
    '302',
  );
  await categoryLevel(2).click();
  await option('Category level 2', 'All subcategories').click();
  await waitForDetail('NextPCB:1004');
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.requests.filter((request) => request.action === 'library.search').at(-1)
          .input.category,
    ),
    '300',
  );
  await chooseCategory(['Amplifiers']);
  assert.equal(await categoryLevel(2).textContent(), 'All subcategories');
  assert.equal(await categoryLevel(3).count(), 0);
  await chooseCategory(['Discrete components']);
  assert.equal(await categoryLevel(2).isDisabled(), true);
  await chooseCategory(['Amplifiers']);
  await categoryLevel(2).click();
  await option('Category level 2', 'Operational amplifiers').click();
  await waitForDetail('NextPCB:1001');
  assert.equal(await categoryLevel(3).count(), 0);
  await search.fill('Online');
  await submit.click();
  await waitForDetail('NextPCB:1001');
  await page.evaluate(() => {
    window.fixture.heldDetails.add('NextPCB:1001');
    window.fixture.heldDetails.add('NextPCB:1002');
  });
  await rows.nth(1).click();
  await page.waitForFunction(() => window.fixture.pendingDetails.has('NextPCB:1002'));
  await page.getByRole('status', { name: 'Loading preview', exact: true }).waitFor();
  await rows.first().click();
  await page.waitForFunction(() => window.fixture.pendingDetails.has('NextPCB:1001'));
  await page.evaluate(() => window.fixture.releaseDetail('NextPCB:1002'));
  await page.waitForFunction(() =>
    window.fixture.requests.some(
      (request) =>
        request.action === 'library.detail' &&
        request.input.id === 'NextPCB:1002' &&
        request.aborted,
    ),
  );
  assert.equal(await place.isDisabled(), true);
  assert.equal(await page.locator('.library-detail-id').textContent(), 'NextPCB:1001');
  assert.equal(
    await page.getByRole('status', { name: 'Loading preview', exact: true }).isVisible(),
    true,
  );
  await rows.first().press('Enter');
  assert.equal(await page.evaluate(() => window.fixture.chosen.length), 0);
  await page.evaluate(() => window.fixture.releaseDetail('NextPCB:1001'));
  await waitForDetail('NextPCB:1001');

  // Composition lifecycle and native key metadata both protect confirmation.
  const beforeComposition = await searchCount();
  for (const target of [search, rows.first()]) {
    await target.focus();
    for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const key of ['Enter', 'Escape']) {
        const prevented = await target.evaluate(
          (node, properties) => {
            const event = new KeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              ...properties,
            });
            node.dispatchEvent(event);
            return event.defaultPrevented;
          },
          { key, ...properties },
        );
        assert.equal(prevented, true);
        assert.equal(await chooser.isVisible(), true);
        assert.equal(await page.evaluate(() => window.fixture.chosen.length), 0);
      }
    }
  }
  await search.focus();
  await search.dispatchEvent('compositionstart', { data: '' });
  await search.press('Enter');
  await search.press('Escape');
  assert.equal(await chooser.isVisible(), true);
  assert.equal(await page.evaluate(() => window.fixture.chosen.length), 0);
  assert.equal(await searchCount(), beforeComposition);
  await search.dispatchEvent('compositionend', { data: '' });

  await rows.first().press('Enter');
  await place.click();
  await rows.first().dblclick();
  assert.deepEqual(await page.evaluate(() => window.fixture.chosen), [
    {
      id: 'NextPCB:1001',
      library: 'NextPCB',
      nativeId: 'NextPCB:1001',
      unit: 1,
      model: 0,
    },
  ]);

  await page.evaluate(() => {
    window.fixture.failNextSearch = true;
  });
  await search.fill('amplifier 2');
  await submit.click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'NextPCB fixture is temporarily unavailable.' })
    .waitFor();
  assert.equal(await place.isDisabled(), true);
  assert.equal(await resultCount.textContent(), 'Unavailable');
  await page.getByRole('button', { name: 'Retry loading results', exact: true }).click();
  await waitForDetail('NextPCB:1002');
  assert.equal(await rows.count(), 1);
  assert.equal(await search.inputValue(), 'amplifier 2');
  assert.equal(await source.textContent(), 'NextPCB');
  assert.equal(await page.evaluate(() => window.fixture.chosen.length), 1);

  // A new category resets pagination and removes the old loaded preview immediately.
  await search.fill('Paged');
  await submit.click();
  await waitForDetail('NextPCB:2000');
  await page.evaluate(() => {
    window.fixture.failNextAppend = true;
  });
  await page.locator('.library-results').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await page
    .getByRole('alert')
    .filter({ hasText: 'NextPCB fixture page is temporarily unavailable.' })
    .waitFor();
  assert.equal(await rows.count(), 16);
  assert.equal(await resultCount.textContent(), '16 results loaded');
  assert.equal(await page.locator('.library-detail-id').textContent(), 'NextPCB:2000');
  assert.equal(await place.isDisabled(), false);
  await page.getByRole('button', { name: 'Retry loading results', exact: true }).click();
  await page.waitForFunction(() =>
    window.fixture.requests.some(
      (request) => request.action === 'library.search' && request.input.offset === 16,
    ),
  );
  await page.waitForFunction(
    () => document.querySelectorAll('.library-results button[data-index]').length === 32,
  );
  const pagedBrowse = await browseState();
  await search.fill('unsent pagination draft');
  await search.fill('');
  await page.waitForTimeout(200);
  assert.deepEqual(
    await browseState(),
    pagedBrowse,
    'Unsubmitted edits retain appended pages and preview.',
  );
  await search.fill('Paged');
  await page.evaluate(() => {
    window.fixture.holdSearch = true;
  });
  await chooseCategory(['Passives', 'Resistors']);
  await page.waitForFunction(() => window.fixture.pendingSearch.length >= 1);
  assert.equal(await place.isDisabled(), true);
  assert.equal(await page.locator('.library-detail-id').count(), 0);
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.fixture.requests.filter((request) => request.action === 'library.search').at(-1)
          .input,
    ),
    {
      kind: 'symbols',
      query: 'Paged',
      library: 'NextPCB',
      offset: 0,
      category: '201',
      includeAssetStatus: true,
    },
  );
  await page.evaluate(() => window.fixture.releaseSearch());
  await search.fill('package:0603');
  await search.press('Enter');
  await chooser.getByText('No matching symbols in this batch.', { exact: true }).waitFor();
  await chooser.getByRole('button', { name: 'Load more', exact: true }).press('Enter');
  await waitForDetail('NextPCB:1003');
  assert.equal(await rows.count(), 1);
  await search.fill('Online');
  await submit.click();
  await waitForDetail('NextPCB:1003');
  assert.equal(await rows.count(), 1);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/nextpcb-library-chooser.png' });
  await page.setViewportSize({ width: 620, height: 760 });
  await categoryLevel(1).click();
  await option('Category level 1', 'Amplifiers').click();
  await categoryLevel(2).click();
  await option('Category level 2', 'Operational amplifiers').waitFor();
  await page.screenshot({ path: 'test-results/nextpcb-library-hierarchy.png' });
  await categoryLevel(2).press('Escape');

  // Provider pages can overlap: display unique IDs but consume every raw row.
  await chooseCategory(['Amplifiers', 'Operational amplifiers']);
  await waitForDetail('NextPCB:1001');
  await search.fill('Overlap');
  await submit.click();
  await waitForDetail('NextPCB:4000');
  assert.equal(await rows.count(), 16);
  await search.fill('Unsubmitted page draft');
  assert.equal(await resultCount.textContent(), '16 results loaded');
  await page.locator('.library-results').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.library-results button[data-index]').length === 32,
  );
  const uniqueIds = async () =>
    new Set(
      await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-description'))),
    ).size;
  assert.equal(await uniqueIds(), 32);
  assert.equal(
    await rows
      .filter({ has: page.locator('strong', { hasText: 'Overlap amplifier 001' }) })
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await page.locator('.library-detail-id').textContent(), 'NextPCB:4000');

  // Source restoration retains the raw cursor and the visible batch limit.
  const beforeOverlapRestore = await searchCount();
  await chooseSource('KiCad');
  await waitForDetail('Device:R');
  await chooseSource('NextPCB');
  await waitForDetail('NextPCB:4000');
  assert.equal(await search.inputValue(), 'Unsubmitted page draft');
  assert.equal(await rows.count(), 32);
  assert.equal(await searchCount(), beforeOverlapRestore);
  await page.evaluate(() => {
    window.fixture.failNextAppend = true;
  });
  await page.locator('.library-results').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await page
    .getByRole('alert')
    .filter({ hasText: 'NextPCB fixture page is temporarily unavailable.' })
    .waitFor();
  assert.equal(await rows.count(), 44);
  assert.equal(await resultCount.textContent(), '44 results loaded');
  assert.equal(await page.locator('.library-detail-id').textContent(), 'NextPCB:4000');
  await page.getByRole('button', { name: 'Retry loading results', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.library-results button[data-index]').length === 48,
  );
  assert.equal(await uniqueIds(), 48);
  assert.equal(await page.locator('.library-detail-id').textContent(), 'NextPCB:4000');
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.requests
        .filter(
          (request) => request.action === 'library.search' && request.input.query === 'Overlap',
        )
        .map((request) => request.input.offset),
    ),
    [0, 16, 32, 48, 48],
  );
  const consumedOverlap = await searchCount();
  await chooser.getByRole('button', { name: 'Load more', exact: true }).press('Enter');
  assert.equal(await uniqueIds(), 52);
  await page.locator('.library-results').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => {
    window.fixture.editedAt = performance.now();
  });
  await waitForAsync(page, () => performance.now() - window.fixture.editedAt > 350);
  assert.equal(await searchCount(), consumedOverlap);

  // Explicit All remains selected through details, resubmission, clearing and restoration.
  await search.fill('Online');
  await submit.click();
  await waitForDetail('NextPCB:1001');
  await categoryLevel(1).click();
  await option('Category level 1', 'All categories').click();
  await waitForDetail('NextPCB:1001');
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.requests.filter((request) => request.action === 'library.search').at(-1)
          .input.category,
    ),
    undefined,
    'Keyword All has no hidden category.',
  );
  await rows.nth(1).click();
  await waitForDetail('NextPCB:1002');
  assert.equal(await categoryLevel(1).textContent(), 'All categories');
  await submit.click();
  await waitForDetail('NextPCB:1001');
  assert.equal(await categoryLevel(1).textContent(), 'All categories');
  await search.fill('');
  await submit.click();
  await waitForDetail('NextPCB:1001');
  assert.equal(
    await page.evaluate(
      () =>
        fixture.requests.findLast((request) => request.action === 'library.search').input.category,
    ),
    undefined,
  );
  assert.equal(await categoryLevel(1).textContent(), 'All categories');
  const beforeCatalogRestore = await searchCount();
  await chooseSource('KiCad');
  await waitForDetail('Device:R');
  await chooseSource('NextPCB');
  assert.equal(await categoryLevel(1).textContent(), 'All categories');
  assert.ok((await rows.count()) > 0);
  assert.equal(await searchCount(), beforeCatalogRestore);

  // Closing cancels the active online search; even a late result cannot place.
  await page.evaluate(() => {
    window.fixture.holdSearch = true;
  });
  await search.fill('resistor');
  await submit.click();
  await page.waitForFunction(() => window.fixture.pendingSearch.length === 1);
  assert.equal(await rows.count(), 0);
  assert.equal(await page.locator('.library-detail-id').count(), 0);
  assert.equal(await place.isDisabled(), true);
  await search.press('Escape');
  await chooser.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.fixture.closed), 1);
  assert.equal(await page.evaluate(() => window.fixture.requests.at(-1).aborted), true);
  await page.evaluate(() => window.fixture.releaseSearch());
  assert.equal(await chooser.count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.chosen.length), 1);
  await page.evaluate(() => {
    fixture.failNextCategories = true;
    window.reopenChooser();
  });
  await waitForDetail('Device:R');
  await chooseSource('NextPCB');
  await page
    .getByText('NextPCB categories are temporarily unavailable.', { exact: true })
    .waitFor();
  await page.evaluate(() => {
    fixture.holdCategories = true;
    fixture.releaseCategories = null;
  });
  await retryCategories.click();
  await page.waitForFunction(() => typeof fixture.releaseCategories === 'function');
  await search.press('Escape');
  await chooser.waitFor({ state: 'detached' });
  assert.equal(
    await page.evaluate(
      () =>
        fixture.requests
          .filter(
            (request) =>
              request.action === 'library.categories' && request.input.source === 'NextPCB',
          )
          .at(-1).aborted,
    ),
    true,
  );
  await page.evaluate(() => {
    fixture.holdCategories = false;
    fixture.releaseCategories();
    window.reopenChooser();
  });
  await waitForDetail('Device:R');
  await page.evaluate(() => (fixture.holdJlcPage = true));
  await chooseSource('JLCPCB');
  await page.waitForFunction(() => Boolean(fixture.releaseJlcPage));
  await waitForDetail('JLCPCB:C8000');
  assert.equal(await chooser.getByRole('combobox', { name: 'Price source' }).isVisible(), true);
  assert.equal(await categoryLevel(1).textContent(), 'All categories');
  assert.equal(await search.inputValue(), '');
  assert.equal(await rows.count(), 12, 'The first page is visible and usable during the append.');
  const appendProgress = page
    .locator('.library-results > .library-page-progress:last-child')
    .getByRole('progressbar', { name: 'Loading more components' });
  await appendProgress.waitFor();
  assert.equal(await appendProgress.getAttribute('aria-valuenow'), '5');
  assert.equal(await chooser.getByRole('button', { name: 'Load more', exact: true }).count(), 0);
  await page.evaluate(() => {
    fixture.holdJlcPage = false;
    fixture.releaseJlcPage();
  });
  await page.waitForFunction(
    () => document.querySelector('.library-result-status').textContent === '16 results loaded',
  );
  await appendProgress.waitFor({ state: 'hidden' });
  assert.equal(await rows.count(), 16);
  const unknownModel = rows.nth(2).getByTitle('Model: Unknown');
  assert.equal(await unknownModel.getAttribute('data-status'), 'unknown');
  const emptyBox = await unknownModel.locator('svg').getAttribute('class');
  assert.match(emptyBox, /\blucide-square\b(?!-)/);
  assert.equal(
    await rows.first().getByTitle('Model: Unavailable').locator('svg').getAttribute('class'),
    emptyBox,
    'Missing and unknown models have the same empty checkbox.',
  );
  assert.equal(
    await page.evaluate(() =>
      fixture.requests.some(
        (request) => request.action === 'library.detail' && request.input.id === 'JLCPCB:C7593',
      ),
    ),
    false,
  );
  for (const asset of ['Footprint', 'Model']) {
    const confirmed = rows.nth(1).getByTitle(`${asset}: Available`);
    assert.equal(await confirmed.getAttribute('data-status'), 'yes');
    assert.match(await confirmed.locator('svg').getAttribute('class'), /\blucide-square-check\b/);
  }
  await sortBy('Model').click();
  assert.equal(await rows.first().getAttribute('aria-description'), 'JLCPCB:C7593');
  await rows.first().click();
  await waitForDetail('JLCPCB:C7593');
  assert.equal(
    await rows.first().getByTitle('Model: Available').getAttribute('data-status'),
    'yes',
  );
  assert.equal(
    await chooser.getByRole('button', { name: '3D model', exact: true }).isEnabled(),
    true,
  );
  await sortBy('Model').click();
  await sortBy('Model').click();
  await rows.first().click();
  await waitForDetail('JLCPCB:C8000');
  await sortBy('Name').click();
  assert.equal(await rows.first().getAttribute('aria-description'), 'JLCPCB:C7593');
  await page.locator('.library-results').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.library-results button[data-index]').length === 32,
  );
  assert.equal(await uniqueIds(), 32);
  assert.equal(
    await chooser.locator('.library-results button[aria-description="JLCPCB:C9029"]').count(),
    1,
  );
  assert.equal(await rows.last().getAttribute('aria-description'), 'JLCPCB:C8000');
  assert.equal(await rows.last().getAttribute('aria-pressed'), 'true');
  await sortBy('Name').click();
  await sortBy('Name').click();
  await categoryLevel(1).click();
  await option('Category level 1', 'Clock/Timing').click();
  await waitForDetail('JLCPCB:C7593');
  await page.waitForFunction(
    () => document.querySelector('.library-result-status').textContent === '16 results loaded',
  );
  const knownModel = rows.first().getByTitle('Model: Available');
  assert.equal(await knownModel.getAttribute('data-status'), 'yes');
  assert.match(await knownModel.locator('svg').getAttribute('class'), /\blucide-square-check\b/);
  await categoryLevel(2).click();
  await option('Category level 2', '555 Timers / Counters').click();
  await waitForDetail('JLCPCB:C7593');
  assert.equal(await categoryPath(), 'Clock/Timing / 555 Timers / Counters');
  await page.waitForFunction(
    () => document.querySelector('.library-result-status').textContent === '16 results loaded',
  );
  assert.equal(await rows.count(), 16);
  await page.locator('.library-results').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.library-results button[data-index]').length === 32,
  );
  assert.equal(await uniqueIds(), 32);
  assert.deepEqual(
    await page.evaluate(() =>
      fixture.requests
        .filter(
          (request) => request.action === 'library.search' && request.input.library === 'JLCPCB',
        )
        .map((request) => [request.input.category, request.input.query, request.input.offset]),
    ),
    [undefined, '20', '228'].flatMap((category) =>
      (category === '20' ? [0, 12] : [0, 12, 24]).map((offset) => [category, '', offset]),
    ),
  );
  await chooseSource('KiCad');
  await waitForDetail('Device:R');
  await chooseSource('JLCPCB');
  await waitForDetail('JLCPCB:C7593');
  assert.equal(await categoryPath(), 'Clock/Timing / 555 Timers / Counters');
  assert.equal(await rows.count(), 32);
  await categoryLevel(1).click();
  await option('Category level 1', 'All categories').click();
  await waitForDetail('JLCPCB:C8000');
  await search.fill('LM2596');
  await submit.click();
  await page.waitForFunction(
    () => document.querySelector('.library-result-status').textContent === '16 results loaded',
  );
  assert.equal(
    await uniqueIds(),
    16,
    'Keyword results fill 16 visible rows despite filtering and overlap.',
  );
  const beforeBufferedResults = await searchCount();
  await chooser.getByRole('button', { name: 'Load more', exact: true }).press('Enter');
  assert.equal(await uniqueIds(), 20);
  assert.equal(
    await searchCount(),
    beforeBufferedResults,
    'Buffered results are not fetched twice.',
  );

  await search.fill('sparse');
  await submit.click();
  await waitForDetail('JLCPCB:C7593');
  assert.equal(await rows.count(), 1, 'An empty batch advances automatically to the next cursor.');
  assert.equal(await resultCount.textContent(), '1 result loaded');
  assert.equal(await chooser.getByRole('button', { name: 'Load more', exact: true }).count(), 0);

  const footer = chooser.locator('.dialog-footer');
  await page.evaluate(() => (window.fixture.blockedCad = true));
  const detailRequests = () =>
    page.evaluate(
      () => window.fixture.requests.filter((request) => request.action === 'library.detail').length,
    );
  const beforeBlockedPreview = await detailRequests();
  await search.fill('blocked');
  await submit.click();
  await footer
    .getByRole('alert')
    .filter({ hasText: 'EasyEDA CAD denied the request (HTTP 403).' })
    .waitFor();
  assert.equal(await detailRequests(), beforeBlockedPreview + 1);
  assert.equal(await place.isDisabled(), true);
  assert.equal(await chooser.locator('.dialog-content').getByRole('alert').count(), 0);
  assert.equal(await rows.count(), 1);
  assert.equal(await chooser.locator('.library-detail-id').textContent(), 'JLCPCB:C7593');
  assert.equal(await rows.first().getByTitle('Footprint: Unknown').count(), 1);
  assert.equal(
    await footer.locator('.library-footer-feedback').getByRole('button').count(),
    1,
    'Retry appears next to the request error.',
  );
  assert.equal(await chooser.evaluate((node) => getComputedStyle(node).boxShadow), 'none');
  const beforeRetrySearches = await searchCount();
  await page.evaluate(() => {
    fixture.blockedCad = false;
    fixture.heldDetails.add('JLCPCB:C7593');
  });
  const retryPreview = footer.getByRole('button', { name: 'Retry loading preview' });
  await retryPreview.click();
  await page.waitForFunction(() => fixture.pendingDetails.has('JLCPCB:C7593'));
  await retryPreview.waitFor({ state: 'detached' });
  assert.equal(await rows.first().getAttribute('aria-pressed'), 'true');
  assert.equal(await searchCount(), beforeRetrySearches);
  await page.evaluate(() => fixture.releaseDetail('JLCPCB:C7593'));
  await waitForDetail('JLCPCB:C7593');
  await footer.getByRole('alert').waitFor({ state: 'detached' });
  await rows.first().getByTitle('Footprint: Available').waitFor();

  await chooseSource('NextPCB');
  await search.fill('Missing model');
  await submit.click();
  const empty = chooser.getByRole('heading', { name: 'No matching symbols.', exact: true });
  await empty.waitFor();
  assert.equal(await chooser.locator('.library-result-columns').count(), 0);
  assert.equal(await chooser.locator('.library-detail').isVisible(), false);
  assert.equal(await place.isEnabled(), false);
  for (const width of [1120, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const frame = await chooser.locator('.library-browser').boundingBox();
    const state = await chooser.locator('.library-empty-state').boundingBox();
    assert.ok(Math.abs(frame.x + frame.width / 2 - (state.x + state.width / 2)) < 2);
    assert.ok(Math.abs(frame.y + frame.height / 2 - (state.y + state.height / 2)) < 2);
  }
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.keyboard.press('Escape');
  await chooser.waitFor({ state: 'detached' });
  await page.evaluate(() => {
    fixture.requests = [];
    fixture.checkedBrowseFixture = true;
    window.reopenChooser();
  });
  const waitForBrowseRows = (count) =>
    page.waitForFunction((expected) => {
      const list = document.querySelector('.library-results');
      return (
        list?.getAttribute('aria-busy') === 'false' &&
        list.querySelectorAll('button[data-index]').length === expected
      );
    }, count);
  await waitForBrowseRows(16);
  await waitForDetail('Device:R');
  await chooser.getByRole('button', { name: 'Load more', exact: true }).press('Enter');
  await waitForBrowseRows(32);
  await chooseSource('NextPCB');
  await waitForBrowseRows(16);
  await waitForDetail('NextPCB:1001');
  await chooser.locator('.library-results').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await waitForBrowseRows(32);
  await chooser.getByRole('button', { name: 'Load more', exact: true }).press('Enter');
  await waitForBrowseRows(48);
  assert.deepEqual(
    await page.evaluate(() =>
      fixture.requests
        .filter((request) => request.action === 'library.search')
        .map((request) => [request.input.library, request.input.offset]),
    ),
    [
      ['', 0],
      ['', 24],
      ['NextPCB', 0],
      ['NextPCB', 12],
      ['NextPCB', 24],
      ['NextPCB', 36],
    ],
  );
  assert.equal(await categoryPath(), '');
  await search.fill('0603');
  await search.press('Enter');
  await waitForBrowseRows(1);
  await waitForDetail('NextPCB:1003');
  assert.equal(await rows.first().locator('.library-result-package').textContent(), '0603');
  assert.equal(await categoryPath(), '');
  await chooseSource('JLCPCB');
  await search.fill('SOIC-8');
  await search.press('Enter');
  await waitForBrowseRows(1);
  await waitForDetail('JLCPCB:C7593');
  assert.equal(await rows.first().locator('.library-result-package').textContent(), 'SOIC-8');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: default online browsing, overlapping-page deduplication/raw cursor/restoration/retry, failed-search count reset, append-error retention, source/category hierarchy, explicit search, metadata, native single placement, stale preview, IME and cancellation (mocked isolated browser).',
  );
} finally {
  await browser.close();
}
