import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

// Isolated chooser presentation. No host, providers, downloads or project writes.
const { libraries } = await tsImport('../lib/circuit.ts', import.meta.url);
const symbol = structuredClone(libraries['Device:R']);
const sourceId = 'NextPCB:123_component';
symbol[1] = '"' + sourceId + '"';
const entries = {
  symbols: {
    id: sourceId,
    name: 'Precision controller',
    library: 'NextPCB',
    manufacturer: 'Example Semiconductor',
    package: 'SOP-8',
    description: 'Precision dual amplifier.',
    keywords: 'amplifier analog',
    footprint: 'NextPCB:123_package',
    symbol,
    units: 1,
  },
  footprints: {
    id: 'NextPCB:123_package',
    name: 'Verified package',
    library: 'NextPCB',
    manufacturer: 'Example Semiconductor',
    package: 'SOP-8',
    description: 'Native package.',
    keywords: 'SMD',
    pads: ['1', '2'],
    models: [],
    footprint: [
      'footprint',
      '"123_package"',
      [
        'pad',
        '"1"',
        'smd',
        'rect',
        ['at', '0', '0'],
        ['size', '1', '1'],
        ['layers', '"F.Cu"', '"F.Paste"', '"F.Mask"'],
      ],
      [
        'pad',
        '"2"',
        'smd',
        'rect',
        ['at', '2.54', '0'],
        ['size', '1', '1'],
        ['layers', '"F.Cu"', '"F.Paste"', '"F.Mask"'],
      ],
    ],
  },
};
const copyright = 'Preserve the supplied English copyright attribution.';
const links = 'Visit https://lceda.cn/ and https://easyeda.com for official terms.';
const notice = [
  `【版权归属/Copyright】示例：嘉立创EDA官方库。中文说明。 ${copyright}`,
  `【链接要求/Link】请访问官方网站。 ${links}`,
  'English terms remain available below.',
  ...Array(20).fill('Preserve the wording of the English notice.'),
].join('\n');
const jlcEntries = Object.fromEntries(
  Object.entries(entries).map(([kind, entry]) => {
    const id = 'JLCPCB:C7593';
    const detail = {
      ...structuredClone(entry),
      id,
      library: 'JLCPCB',
      attribution: {
        source: 'JLCEDA/EasyEDA Official Library',
        homepages: ['https://lceda.cn/', 'https://easyeda.com', 'https://invalid.example/'],
        notice,
      },
    };
    if (detail.symbol) {
      detail.symbol[1] = JSON.stringify(id);
      detail.footprint = id;
    } else detail.models = [{ path: 'JLCPCB:fixture.step' }];
    return [kind, detail];
  }),
);
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';
  import{createRoot}from'react-dom/client';import Chooser from './components/LibraryChooser';
  import{defaultAppearance,appearanceVariables}from'./lib/appearance';
  window.setTheme=value=>{document.documentElement.dataset.theme=value;
    for(const[key,color]of Object.entries(appearanceVariables(defaultAppearance,value)))document.documentElement.style.setProperty(key,color)};
  function App(){const[kind,setKind]=useState('symbols');window.setKind=setKind;
    const[source,setSource]=useState('NextPCB');window.setSource=setSource;return <Chooser key={source+kind}
    kind={kind} initialLibrary={source} initialSearch="Fixture" onClose={()=>{}} onChoose={()=>{window.placements=(window.placements||0)+1}}/>}createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await mkdir('test-results/library-chooser-ui', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let detailsHeld = true,
    releaseDetails,
    refreshHeld = false,
    releaseRefresh,
    searches = 0,
    modelReads = 0;
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/library-model') {
      modelReads++;
      return route.fulfill({ json: { meshes: [] } });
    }
    if (url.pathname.startsWith('/api/libraries/')) {
      const kind = url.pathname.split('/').at(-1);
      if (url.searchParams.has('categories'))
        return route.fulfill({
          json: {
            categories: [
              {
                id: '100',
                name: 'Analog',
                children: [
                  {
                    id: '1737',
                    name: 'Amplifiers',
                    children: [{ id: '1738', name: 'Precision', children: [] }],
                  },
                ],
              },
            ],
          },
        });
      if (url.searchParams.has('id') && detailsHeld)
        await new Promise((resolve) => {
          releaseDetails = resolve;
        });
      if (!url.searchParams.has('id')) {
        searches++;
        if (refreshHeld)
          await new Promise((resolve) => {
            releaseRefresh = resolve;
          });
      }
      const jlc =
        url.searchParams.get('library') === 'JLCPCB' ||
        url.searchParams.get('id')?.startsWith('JLCPCB:');
      const entry = (jlc ? jlcEntries : entries)[kind];
      return route.fulfill({
        json: url.searchParams.has('id')
          ? entry
          : { entries: [entry], libraries: [entry.library], total: 1, nextOffset: null },
      });
    }
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.evaluate(() => {
    window.openedHomepages = [];
    window.openpe = {
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      openLibraryHomepage: async (site) => {
        if (window.failHomepage) throw new Error('Fixture browser failure.');
        window.openedHomepages.push(site);
      },
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const place = page.getByRole('button', { name: 'Place', exact: true });
  const requestPreview = () => page.getByRole('button', { name: 'Preview', exact: true }).click();
  await place.waitFor();
  assert.equal(await place.isDisabled(), true);
  await requestPreview();
  await page.getByRole('status', { name: 'Loading preview', exact: true }).waitFor();
  detailsHeld = false;
  releaseDetails();
  async function assertTopControls() {
    const layout = await page.evaluate(() => {
      const header = document.querySelector('.dialog-header').getBoundingClientRect();
      const filters = document.querySelector('.library-filter').getBoundingClientRect();
      const count = document.querySelector('.library-filter [role="status"]');
      const rect = count.getBoundingClientRect();
      const search = document.querySelector('.library-search').getBoundingClientRect();
      const fields = [...document.querySelectorAll('.library-source-filters .select-trigger')];
      return {
        gap: filters.top - header.bottom,
        width: rect.width,
        height: rect.height,
        searchHeight: search.height,
        fieldHeights: fields.map((field) => field.getBoundingClientRect().height),
      };
    });
    assert.ok(layout.gap >= 12, 'Filters have clear space below the header.');
    const footer = await page.evaluate(() => {
      const node = document.querySelector('.dialog-footer');
      const bounds = node.getBoundingClientRect();
      return {
        height: bounds.height,
        center: (bounds.top + bounds.bottom) / 2,
        controls: [...node.querySelectorAll('button')].map((button) => {
          const rect = button.getBoundingClientRect();
          return { height: rect.height, center: (rect.top + rect.bottom) / 2 };
        }),
      };
    });
    assert.ok(footer.height <= 43, 'The footer keeps its compact height.');
    assert.ok(
      footer.controls.every(
        (control) =>
          Math.abs(control.height - 30) < 0.5 && Math.abs(control.center - footer.center) < 1,
      ),
      'Footer controls share their height and vertical center.',
    );
    assert.ok(
      layout.fieldHeights.length === 3 &&
        layout.fieldHeights.every((height) => Math.abs(height - layout.searchHeight) < 0.5),
      'Source, category and search have the same outer height.',
    );
    assert.ok(
      layout.width <= 1 && layout.height <= 1,
      'The result count remains visually clipped.',
    );
  }
  for (const kind of ['symbols', 'footprints']) {
    if (kind === 'footprints') {
      await page.evaluate(() => window.setKind('footprints'));
      await requestPreview();
    }
    await page.waitForFunction(
      (expected) => document.querySelector('.library-detail-id')?.textContent === expected,
      entries[kind].id,
    );
    await page.locator('.library-info-section').first().waitFor();
    const section = (name) =>
      page
        .locator('.library-info-section')
        .filter({ has: page.getByRole('heading', { name, exact: true }) });
    assert.equal(await section('Basic information').count(), 1);
    assert.equal(await section('Package').count(), 1);
    assert.equal(await section('Description').count(), 1);
    const pairs = await page
      .locator('.library-detail-attributes')
      .evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.flatMap((node) =>
            [...node.querySelectorAll('dt')]
              .filter((e) => e.tagName === 'DT')
              .map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
          ),
        ),
      );
    assert.equal(pairs.Source, 'NextPCB');
    assert.equal(await page.getByRole('region', { name: 'CAD source', exact: true }).count(), 0);
    assert.equal(pairs.Manufacturer, 'Example Semiconductor');
    assert.equal(pairs.Package, 'SOP-8');
    if (kind === 'symbols') {
      assert.equal(await place.innerText(), '');
      assert.equal(await place.getAttribute('title'), 'Place');
      assert.equal(await place.isEnabled(), true);
      await place.click();
      await place.click();
      assert.equal(await page.evaluate(() => window.placements), 1);
      const refresh = page.getByRole('button', { name: 'Refresh library', exact: true });
      assert.equal(await place.locator('svg').count(), 1);
      assert.equal(
        await page
          .locator('.dialog-footer')
          .getByRole('button', { name: 'Refresh library' })
          .count(),
        1,
      );
      assert.ok(
        await refresh.evaluate((node) => {
          const place = node.parentElement.querySelector('[aria-label="Place"]');
          return Boolean(node.compareDocumentPosition(place) & Node.DOCUMENT_POSITION_FOLLOWING);
        }),
      );
      const before = searches;
      await refresh.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
      await page.waitForTimeout(50);
      assert.equal(searches, before);
      refreshHeld = true;
      await refresh.click();
      await page.getByRole('status', { name: 'Loading library', exact: true }).waitFor();
      assert.equal(searches, before + 1);
      assert.equal(await refresh.isDisabled(), true);
      refreshHeld = false;
      releaseRefresh();
      await page.waitForFunction(
        () => document.querySelector('.library-detail-id')?.textContent === 'NextPCB:123_component',
      );
      await requestPreview();
      await section('Symbol details').waitFor();
      assert.equal(await section('Symbol details').count(), 1);
      assert.equal(pairs.Units, '1');
      assert.equal(pairs['Reference prefix'], 'R');
    } else {
      assert.equal(await section('3D models').count(), 1);
      assert.equal(pairs.Pads, '2');
    }
    for (const width of [1120, 360]) {
      await page.setViewportSize({ width, height: 800 });
      const source = page.getByRole('combobox', { name: 'Library source', exact: true });
      const nextWidth = (await source.boundingBox()).width;
      await source.click();
      await page
        .getByRole('listbox', { name: 'Library source', exact: true })
        .getByRole('option', { name: 'KiCad', exact: true })
        .click();
      const localWidth = (await source.boundingBox()).width;
      assert.ok(
        Math.abs(localWidth - nextWidth) < 0.5,
        'Source field width is independent of the selected provider.',
      );
      await source.click();
      await page
        .getByRole('listbox', { name: 'Library source', exact: true })
        .getByRole('option', { name: 'NextPCB', exact: true })
        .click();
      await assertTopControls();
      for (const name of ['Library source', 'Category level 1']) {
        const trigger = page.getByRole('combobox', { name, exact: true });
        await trigger.click();
        const popup = page.getByRole('listbox', { name, exact: true });
        assert.ok(
          Math.abs((await popup.boundingBox()).width - (await trigger.boundingBox()).width) < 0.5,
        );
        await trigger.press('Escape');
      }
      const rects = await page.evaluate(() => {
        const f = document.querySelector('.library-filter').getBoundingClientRect(),
          s = document.querySelector('.library-search').getBoundingClientRect();
        return { filter: f.bottom, search: s.top };
      });
      assert.ok(rects.filter <= rects.search, 'Library and category precede search.');
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(
        await page
          .locator('.library-detail')
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
        true,
      );
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => window.setTheme(value), theme);
        await page.waitForTimeout(250);
        await assertTopControls();
        assert.equal(
          await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
          ),
          theme === 'dark' ? '#202020' : '#ffffff',
        );
        await page.screenshot({
          path: `test-results/library-chooser-ui/${kind}-${width}-${theme}.png`,
        });
      }
      await page
        .locator('.library-detail')
        .evaluate((node) => (node.scrollTop = node.scrollHeight));
      await page.screenshot({ path: `test-results/library-chooser-ui/${kind}-${width}-info.png` });
    }
    await page.setViewportSize({ width: 1120, height: 500 });
    await page.getByRole('button', { name: 'Maximize dialog' }).click();
    await assertTopControls();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: `test-results/library-chooser-ui/${kind}-maximized-short.png` });
    await page.getByRole('button', { name: 'Restore dialog' }).click();
  }
  await page.evaluate(() => window.setSource('JLCPCB'));
  for (const [kind, width] of [
    ['footprints', 1120],
    ['symbols', 360],
  ]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate((value) => window.setKind(value), kind);
    await page.evaluate((theme) => window.setTheme(theme), width > 600 ? 'light' : 'dark');
    await requestPreview();
    const source = page.getByRole('region', { name: 'CAD source', exact: true });
    await source
      .getByRole('heading', { name: 'JLCEDA/EasyEDA Official Library', exact: true })
      .waitFor();
    assert.equal(
      await source.evaluate((node) => node === node.parentElement.lastElementChild),
      true,
    );
    const jlc = source.getByRole('link', { name: 'JLCEDA official website', exact: true });
    const easyeda = source.getByRole('link', { name: 'EasyEDA official website', exact: true });
    assert.equal(await jlc.getAttribute('href'), 'https://lceda.cn/');
    assert.equal(await easyeda.getAttribute('href'), 'https://easyeda.com/');
    assert.equal(await source.getByRole('link').count(), 2);
    const summary = source.locator('summary[aria-label="Library terms"]');
    const text = source.locator('.library-cad-source-terms');
    assert.equal(await summary.textContent(), '');
    assert.equal(await text.isVisible(), false);
    assert.ok((await source.boundingBox()).height < 100);
    const packageCard = page.getByRole('region', { name: 'Package', exact: true });
    const cardStyle = (node) => {
      const style = getComputedStyle(node);
      return [style.border, style.borderRadius, style.padding];
    };
    assert.deepEqual(await source.evaluate(cardStyle), await packageCard.evaluate(cardStyle));
    assert.equal(
      await summary.evaluate((node) => {
        const arrow = node.getBoundingClientRect();
        const card = node.closest('.library-cad-source').getBoundingClientRect();
        return card.right - arrow.right <= 10 && card.right > arrow.right && arrow.top > card.top;
      }),
      true,
    );
    await source.screenshot({ path: `test-results/library-chooser-ui/${kind}-attribution.png` });
    assert.equal(
      await summary.evaluate((node) => {
        const key = new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        });
        return node.dispatchEvent(key);
      }),
      false,
    );
    await summary.press('Enter');
    assert.equal(await text.isVisible(), true);
    assert.deepEqual(await text.locator('strong').allTextContents(), ['Copyright', 'Link']);
    const displayedNotice = await text.textContent();
    assert.ok(displayedNotice.includes(copyright) && displayedNotice.includes(links));
    assert.doesNotMatch(displayedNotice, /\p{Script=Han}/u);
    assert.equal(await text.evaluate((node) => node.scrollHeight > node.clientHeight), true);
    assert.equal(await text.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    await summary.press('Enter');
    assert.equal(await text.isVisible(), false);
    await jlc.click();
    await easyeda.press('Enter');
    await page.evaluate(() => (window.failHomepage = true));
    await jlc.click();
    const failure = source.getByRole('status');
    await failure.waitFor();
    await page.evaluate(() => (window.failHomepage = false));
    await jlc.click();
    await failure.waitFor({ state: 'detached' });
  }
  assert.equal(modelReads, 0, 'Search and 2D previews do not fetch STEP meshes.');
  await page.getByRole('button', { name: 'Footprint', exact: true }).click();
  await page.locator('svg.footprint-preview').waitFor();
  assert.equal(modelReads, 0);
  const modelRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/library-model',
  );
  await page.getByRole('button', { name: '3D model', exact: true }).click();
  assert.equal(new URL((await modelRequest).url()).searchParams.get('id'), 'JLCPCB:C7593');
  assert.deepEqual(await page.evaluate(() => window.openedHomepages), [
    'jlceda',
    'easyeda',
    'jlceda',
    'jlceda',
    'easyeda',
    'jlceda',
  ]);
  assert.equal(await page.evaluate(() => window.placements), 1);
  assert.equal(page.context().pages().length, 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: categorized details, responsive filters, official links and collapsed copyright for symbols and footprints.',
  );
} finally {
  await browser.close();
}
