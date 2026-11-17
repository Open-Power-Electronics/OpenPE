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
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';
  import{createRoot}from'react-dom/client';import Chooser from './components/LibraryChooser';
  import{defaultAppearance,appearanceVariables}from'./lib/appearance';
  window.setTheme=value=>{document.documentElement.dataset.theme=value;
    for(const[key,color]of Object.entries(appearanceVariables(defaultAppearance,value)))document.documentElement.style.setProperty(key,color)};
  function App(){const[kind,setKind]=useState('symbols');window.setKind=setKind;return <Chooser key={kind}
    kind={kind} initialLibrary="NextPCB" initialSearch="Fixture" onClose={()=>{}} onChoose={()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);`,
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
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/libraries/')) {
      const kind = url.pathname.split('/').at(-1);
      return route.fulfill({
        json: url.searchParams.has('id')
          ? entries[kind]
          : { entries: [entries[kind]], libraries: ['NextPCB'], total: 1 },
      });
    }
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.evaluate(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  async function assertTopControls() {
    const layout = await page.evaluate(() => {
      const header = document.querySelector('.dialog-header').getBoundingClientRect();
      const filters = document.querySelector('.library-filter').getBoundingClientRect();
      const count = document.querySelector('.library-filter [role="status"]');
      const rect = count.getBoundingClientRect();
      return { gap: filters.top - header.bottom, width: rect.width, height: rect.height };
    });
    assert.ok(layout.gap >= 12, 'Filters have clear space below the header.');
    assert.ok(
      layout.width <= 1 && layout.height <= 1,
      'The result count remains visually clipped.',
    );
  }
  for (const kind of ['symbols', 'footprints']) {
    if (kind === 'footprints') await page.evaluate(() => window.setKind('footprints'));
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
    assert.equal(pairs.Manufacturer, 'Example Semiconductor');
    assert.equal(pairs.Package, 'SOP-8');
    if (kind === 'symbols') {
      assert.equal(await section('Symbol details').count(), 1);
      assert.equal(pairs.Units, '1');
      assert.equal(pairs['Reference prefix'], 'R');
    } else {
      assert.equal(await section('3D models').count(), 1);
      assert.equal(pairs.Pads, '2');
    }
    for (const width of [1120, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await assertTopControls();
      for (const name of ['Library source', 'Category']) {
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
  assert.deepEqual(errors, []);
  console.log(
    'PASS: categorized symbol and footprint details, real values and responsive filter/search order.',
  );
} finally {
  await browser.close();
}
