import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolated real SVG layout and concurrent React replay. No desktop, native
// project writes, providers, solvers or downloaded fonts are involved.
const bundle = await build({
  stdin: {
    contents: `import React,{Suspense,startTransition,useMemo,useState} from 'react';
      import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
      import SymbolPreview from './components/SymbolPreview';
      import useRetainedElements from './components/useRetainedElements';
      import {ownProjectData} from './lib/immutable-project';
      const library=['symbol','"Fixture:Preview"',
        ['symbol','"Preview_1_1"',
          ['circle',['center','0','0'],['radius','0.5'],['fill',['type','none']]],
          ['text','"Wide glyph WWWiiii"',['at','0','2']]],
        ['symbol','"Preview_2_1"',
          ['rectangle',['start','-8','-2'],['end','8','2'],['fill',['type','none']]]]];
      const owned=ownProjectData(library);
      function PreviewFixture(){
        const [state,setState]=useState({epoch:0,library:owned,unit:1,fields:{}});
        window.updatePreview=changes=>flushSync(()=>setState(previous=>({...previous,...changes})));
        window.unownedLibrary=Object.freeze(structuredClone(library));
        window.freshOwnedLibrary=()=>ownProjectData(structuredClone(library));
        return <SymbolPreview key={state.epoch} library={state.library} unit={state.unit}
          part={{id:'preview',libId:'Fixture:Preview',ref:'R1',value:'x',x:state.epoch,y:0,
            rotation:0,fields:state.fields}}/>;
      }
      const first={id:'retained',label:'Committed'},initial={objects:[first],selected:false};
      const never=new Promise(()=>{});
      function Item({object,selected}){
        window.retainedRenders++;
        return <span data-testid="retained-object" data-selected={selected}>{object.label}</span>;
      }
      function RetainedLayer({state}){
        const retain=useRetainedElements(state.objects,[state.objects,state.selected]);
        const nodes=useMemo(()=>state.objects.map(object=>retain({key:object.id,object,
          selected:state.selected},({key,...props})=>{window.retainedBuilds++;
            return <Item key={key} {...props}/>;})),[state.objects,state.selected]);
        return <div>{nodes}</div>;
      }
      function Suspend({state}){
        if(state.suspend){window.suspendSeen++;throw never;} return null;
      }
      function RetentionFixture(){
        const [state,setState]=useState(initial);
        window.suspendRetention=()=>startTransition(()=>setState({objects:[{...first,
          label:'Abandoned'}],selected:true,suspend:true}));
        window.cancelRetention=()=>flushSync(()=>setState(initial));
        window.refreshRetention=()=>flushSync(()=>setState({...initial,objects:[first]}));
        return <Suspense fallback={<span>Waiting</span>}><RetainedLayer state={state}/>
          <Suspend state={state}/></Suspense>;
      }
      createRoot(document.getElementById('preview')).render(<React.StrictMode><PreviewFixture/></React.StrictMode>);
      createRoot(document.getElementById('retention')).render(<React.StrictMode><RetentionFixture/></React.StrictMode>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  jsx: 'automatic',
  jsxDev: true,
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div class="workbench"><div id="preview"></div><div id="retention"></div></div>',
    }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.evaluate(() => {
    window.previewMeasures = 0;
    window.previewStyleReads = 0;
    window.retainedBuilds = 0;
    window.retainedRenders = 0;
    window.suspendSeen = 0;
    const native = SVGGraphicsElement.prototype.getBBox;
    window.nativeBBox = native;
    const computedStyle = window.getComputedStyle;
    window.getComputedStyle = function (element, ...args) {
      if (element.closest?.('.component-preview')) window.previewStyleReads++;
      return computedStyle.call(this, element, ...args);
    };
    SVGGraphicsElement.prototype.getBBox = function (...args) {
      if (this.parentElement?.parentElement?.classList.contains('component-preview'))
        window.previewMeasures++;
      return native.apply(this, args);
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const preview = page.locator('#preview svg');
  await preview.waitFor();
  const settled = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  await settled();
  const count = () => page.evaluate(() => window.previewMeasures);
  const exactFit = async () => {
    const { actual, expected, contained } = await preview.evaluate((svg) => {
      const actual = svg.getAttribute('viewBox');
      const visibleBounds = window.nativeBBox.call(svg.firstElementChild);
      const [x, y, width, height] = actual.split(' ').map(Number);
      svg.setAttribute('viewBox', '-8 -8 16 16');
      const bounds = window.nativeBBox.call(svg.firstElementChild);
      svg.setAttribute('viewBox', actual);
      const size = Math.max(bounds.width, bounds.height, 4) * 1.25;
      return {
        actual,
        expected: `${bounds.x + bounds.width / 2 - size / 2} ${bounds.y + bounds.height / 2 - size / 2} ${size} ${size}`,
        contained:
          visibleBounds.x >= x &&
          visibleBounds.y >= y &&
          visibleBounds.x + visibleBounds.width <= x + width &&
          visibleBounds.y + visibleBounds.height <= y + height,
      };
    });
    assert.equal(actual, expected, 'The preview fits exact browser-measured SVG/text bounds.');
    assert.ok(
      contained,
      'The final display scale keeps all measured symbol/text geometry visible.',
    );
  };
  assert.equal(await count(), 1, 'StrictMode replay and initial resize reuse one exact measure.');
  await exactFit();
  const initialView = await preview.getAttribute('viewBox');
  const initialStyleReads = await page.evaluate(() => window.previewStyleReads);
  for (let epoch = 1; epoch <= 5; epoch++) {
    await page.evaluate((epoch) => window.updatePreview({ epoch }), epoch);
    await settled();
  }
  assert.equal(await count(), 1, 'Remounts retain owned drawing bounds.');
  assert.equal(
    await page.evaluate(() => window.previewStyleReads),
    initialStyleReads,
    'Owned remounts hit the exact scope cache before any computed-style/layout read.',
  );
  assert.equal(await preview.getAttribute('viewBox'), initialView);
  await page.evaluate(() => {
    document.querySelector('.component-preview').style.width = '90px';
    document.querySelector('.component-preview svg').style.width = '70px';
  });
  await settled();
  assert.equal(await count(), 2, 'A changed viewport size measures its precise SVG text context.');
  await exactFit();
  await page.evaluate(() => window.updatePreview({ fields: { Footprint: 'Fixture:Physical' } }));
  await settled();
  assert.equal(await count(), 2, 'A colour-only symbol role does not invalidate geometry.');
  assert.equal(
    await preview.locator('.symbol-graphic').getAttribute('data-symbol-role'),
    'physical',
  );

  await page.evaluate(() => window.updatePreview({ fields: { 'Sim.Device': 'V' } }));
  await settled();
  assert.equal(await count(), 3, 'A changed source mark gets its own measured bounds.');
  assert.equal(await preview.locator('[data-source-mark="voltage"]').count(), 1);
  await exactFit();
  await page.evaluate(() => window.updatePreview({ unit: 2 }));
  await settled();
  assert.equal(await count(), 4, 'A changed symbol unit gets its own measured bounds.');
  await exactFit();

  for (const [property, value] of [
    ['--ui-font', 'Georgia'],
    ['--ui-weight', '700'],
    ['--ui-style', 'italic'],
  ]) {
    const before = await count();
    await page.evaluate(
      ([property, value]) => document.documentElement.style.setProperty(property, value),
      [property, value],
    );
    await settled();
    assert.equal(await count(), before + 1, `${property} changes invalidate font metrics.`);
    await exactFit();
  }
  const beforeFontLoad = await count();
  await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')));
  await settled();
  assert.equal(await count(), beforeFontLoad + 1, 'A completed font load invalidates old metrics.');
  await exactFit();

  await page.evaluate(() => window.updatePreview({ unit: 1 }));
  await settled();
  const beforeTheme = await count();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await settled();
    await exactFit();
  }
  assert.equal(await count(), beforeTheme, 'Colour-only theme changes retain exact font geometry.');

  const beforeStyle = await count();
  const extraStyle = await page.addStyleTag({
    content: '.component-preview .symbol-graphic text{font-family:Arial;letter-spacing:0.4px}',
  });
  await settled();
  assert.equal(
    await count(),
    beforeStyle + 1,
    'Stylesheet changes invalidate exact glyph metrics.',
  );
  await exactFit();
  await extraStyle.evaluate((style) => style.remove());
  await settled();
  await exactFit();
  const beforeViewport = await page.evaluate(() => window.previewStyleReads);
  await page.setViewportSize({ width: 880, height: 620 });
  await settled();
  assert.ok(
    (await page.evaluate(() => window.previewStyleReads)) > beforeViewport,
    'Viewport changes revalidate declared styling before scope reuse.',
  );
  await exactFit();

  const beforeHidden = await count();
  await page.evaluate(() => {
    document.getElementById('preview').style.display = 'none';
    window.updatePreview({ library: window.freshOwnedLibrary(), epoch: 10 });
  });
  await settled();
  assert.equal(await count(), beforeHidden, 'A hidden preview never caches empty SVG bounds.');
  await page.evaluate(() => (document.getElementById('preview').style.display = 'block'));
  await settled();
  assert.equal(await count(), beforeHidden + 1, 'Revealing a hidden drawing measures real bounds.');
  await exactFit();

  await page.evaluate(() => window.updatePreview({ library: window.unownedLibrary, epoch: 11 }));
  await settled();
  const unownedCount = await count();
  await page.evaluate(() => {
    window.unownedLibrary[2][2][2][1] = '2';
    window.updatePreview({ epoch: 12 });
  });
  await settled();
  assert.ok(
    (await count()) > unownedCount,
    'Caller freezing never qualifies a library for shared reuse.',
  );
  await exactFit();

  const retained = page.getByTestId('retained-object');
  assert.equal(await retained.textContent(), 'Committed');
  await page.evaluate(() => window.suspendRetention());
  await page.waitForFunction(() => window.suspendSeen > 0);
  assert.equal(
    await retained.textContent(),
    'Committed',
    'An interrupted preview stays uncommitted.',
  );
  await page.evaluate(() => window.cancelRetention());
  await settled();
  const beforeRefresh = await page.evaluate(() => ({
    builds: window.retainedBuilds,
    renders: window.retainedRenders,
  }));
  await page.evaluate(() => window.refreshRetention());
  await settled();
  assert.deepEqual(
    await page.evaluate(() => ({ builds: window.retainedBuilds, renders: window.retainedRenders })),
    beforeRefresh,
    'Abandoned concurrent work cannot poison committed element retention.',
  );
  assert.equal(await retained.textContent(), 'Committed');
  assert.equal(await retained.getAttribute('data-selected'), 'false');
  assert.deepEqual(errors, []);
  console.log(
    'Exact preview bounds survive StrictMode, remounts and resize; unit/source/font/reveal changes remeasure, caller freezing does not cache, and interrupted concurrent elements cannot replace committed presentation.',
  );
} finally {
  await browser.close();
}
