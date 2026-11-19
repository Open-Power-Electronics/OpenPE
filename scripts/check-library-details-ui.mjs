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
    footprintPreview: '2d',
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
      detail.footprintPreview = '2d-and-3d';
    } else {
      detail.models = [{ path: 'JLCPCB:fixture.step' }];
      const pad = detail.footprint.find((node) => Array.isArray(node) && node[0] === 'pad');
      detail.pads[0] = 'MH1';
      pad[1] = '"MH1"';
      pad[2] = 'np_thru_hole';
      pad[3] = 'oval';
      pad.find((node) => Array.isArray(node) && node[0] === 'size')[1] = '1.5';
      pad.find((node) => Array.isArray(node) && node[0] === 'layers').splice(1, 3, '"*.Mask"');
      pad
        .find((node) => Array.isArray(node) && node[0] === 'at')
        .splice(1, 2, '0.15', '-0.125', '90');
      pad.push(['drill', 'oval', '0.75', '0.4', ['offset', '-0.125', '-0.15']]);
      const shaped = detail.footprint.filter((node) => Array.isArray(node) && node[0] === 'pad')[1];
      shaped[3] = 'roundrect';
      shaped.push(['roundrect_rratio', '0'], ['chamfer_ratio', '0.25'], ['chamfer', 'top_left']);
      detail.footprint.push(
        [
          'pad',
          '"2"',
          'smd',
          'custom',
          ['at', '3', '-2', '30'],
          ['size', '0.0001', '0.0001'],
          ['layers', '"F.Cu"', '"F.Paste"', '"F.Mask"'],
          ['options', ['clearance', 'outline'], ['anchor', 'rect']],
          [
            'primitives',
            [
              'gr_poly',
              [
                'pts',
                ['xy', '-1', '-0.5'],
                ['xy', '1', '-0.5'],
                ['xy', '1', '1'],
                ['xy', '0.5', '1'],
                ['xy', '0.5', '0.5'],
                ['xy', '-1', '0.5'],
              ],
              ['width', '0'],
              ['fill', 'yes'],
            ],
          ],
        ],
        [
          'fp_poly',
          ['pts', ['xy', '0', '2'], ['xy', '1', '2'], ['xy', '1', '3'], ['xy', '0', '3']],
          ['fill', 'yes'],
          ['layer', '"F.Mask"'],
        ],
        [
          'fp_poly',
          ['pts', ['xy', '2', '2'], ['xy', '3', '2'], ['xy', '3', '3'], ['xy', '2', '3']],
          ['fill', 'none'],
          ['layer', '"Edge.Cuts"'],
        ],
      );
    }
    return [kind, detail];
  }),
);
const localSymbol = structuredClone(symbol);
localSymbol[1] = '"Device:Fixture"';
localSymbol.find((node) => node[0] === 'property' && node[1] === '"Footprint"')[2] =
  '"Package_SO:Fixture"';
const kicadEntries = {
  symbols: {
    id: 'Device:Fixture',
    name: 'Fixture',
    library: 'Device',
    description: 'Bundled fixture symbol.',
    keywords: 'fixture symbol',
    symbol: localSymbol,
    units: 1,
  },
  footprints: {
    ...entries.footprints,
    id: 'Package_SO:Fixture',
    name: 'Fixture',
    library: 'Package_SO',
    manufacturer: undefined,
  },
};
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';
  import{createRoot}from'react-dom/client';import Chooser from './components/LibraryChooser';
  import{defaultAppearance,appearanceVariables}from'./lib/appearance';
  window.setTheme=value=>{document.documentElement.dataset.theme=value;
    for(const[key,color]of Object.entries(appearanceVariables(defaultAppearance,value)))document.documentElement.style.setProperty(key,color)};
  function App(){const[kind,setKind]=useState('symbols');window.setKind=setKind;
    const[source,setSource]=useState('NextPCB');window.setSource=setSource;return <Chooser key={source+kind}
    kind={kind==='models'?'footprints':kind} requireModel={kind==='models'}
    actionLabel={kind==='models'?'Use model':undefined}
    initialLibrary={source} initialSearch="Fixture" onClose={()=>{}} onChoose={()=>{window.placements=(window.placements||0)+1}}/>}createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'preview-frame-probe',
    setup(build) {
      build.onResolve({ filter: /^three$/ }, ({ importer }) => {
        if (importer.endsWith('ModelPreview.tsx'))
          return { path: 'renderer', namespace: 'preview-frame-probe' };
      });
      build.onLoad({ filter: /renderer/, namespace: 'preview-frame-probe' }, () => ({
        resolveDir: process.cwd(),
        contents: `
          export * from 'three';
          export class WebGLRenderer {
            domElement = document.createElement('canvas');
            frame = 0;
            setPixelRatio() {}
            setSize(width,height) {
              this.domElement.width=width;
              this.domElement.height=height;
            }
            render(scene,camera) {
              this.domElement.previewPose=[...camera.position.toArray(),...camera.quaternion.toArray()];
            }
            setAnimationLoop(render) {
              cancelAnimationFrame(this.frame);
              this.domElement.previewRunning=!!render;
              if (render) {
                const tick=()=>{render();this.frame=requestAnimationFrame(tick);};
                this.frame=requestAnimationFrame(tick);
              }
            }
            dispose() {this.setAnimationLoop(null);}
          }`,
      }));
    },
  }],
});
await mkdir('test-results/library-chooser-ui', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
const unavailableCode = 'OPENPE_LIBRARY_ASSET_UNAVAILABLE';
const pasteWarning = 'Footprint unavailable: EasyEDA CAD: Unsupported front paste region path.';
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const initialDetail = Promise.withResolvers();
  let refreshHeld = false,
    releaseRefresh,
    searches = 0,
    modelReads = 0,
    packageReads = 0,
    renderModels = false,
    modelMissing = false,
    multipleModels = false,
    unsupportedPackage = false;
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/library-model') {
      modelReads++;
      if (renderModels)
        return route.fulfill({
          json: {
            meshes: [{
              attributes: { position: { array: [0, 0, 0, 2, 0, 0, 0, 1, 0] } },
              index: { array: [0, 1, 2] },
            }],
          },
        });
      return route.fulfill({
        status: 422,
        json: modelMissing
          ? { error: 'The linked STEP model is unavailable.', code: unavailableCode }
          : { error: 'The preview request timed out.' },
      });
    }
    if (url.pathname.startsWith('/api/libraries/')) {
      const kind = url.pathname.split('/').at(-1);
      const categorySource = url.searchParams.get('categories');
      if (categorySource === 'KiCad') {
        const namespace = kicadEntries[kind].library;
        return route.fulfill({
          json: { categories: [{ id: namespace, name: namespace, children: [] }] },
        });
      }
      if (categorySource)
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
      if (url.searchParams.has('id')) await initialDetail.promise;
      if (!url.searchParams.has('id')) {
        searches++;
        if (refreshHeld)
          await new Promise((resolve) => {
            releaseRefresh = resolve;
          });
      }
      const library = url.searchParams.get('id')?.split(':')[0] ?? url.searchParams.get('library');
      const jlc = library === 'JLCPCB';
      let entry = (jlc ? jlcEntries : library === 'NextPCB' ? entries : kicadEntries)[kind];
      if (url.searchParams.has('id')) {
        if (kind === 'footprints') {
          packageReads++;
          if (jlc && unsupportedPackage)
            return route.fulfill({
              status: 422,
              json: { error: pasteWarning, code: unavailableCode },
            });
          if (jlc && multipleModels)
            entry = { ...entry, models: [...entry.models, { path: 'JLCPCB:alternate.step' }] };
        } else if (jlc && unsupportedPackage) {
          entry = { ...entry, footprintPreview: 'unavailable', warning: pasteWarning };
        }
      }
      if (url.searchParams.has('id')) return route.fulfill({ json: entry });
      const result = { entries: [entry], libraries: [entry.library], total: 1, nextOffset: null };
      if (route.request().headers().accept === 'application/x-ndjson')
        return route.fulfill({
          contentType: 'application/x-ndjson',
          body: JSON.stringify({ type: 'result', result }) + '\n',
        });
      return route.fulfill({ json: result });
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
  const modelTab = page.getByRole('button', { name: '3D model', exact: true });
  const footprintTab = page.getByRole('button', { name: 'Footprint', exact: true });
  async function assertPlanarCamera(kind) {
    const label = kind === 'symbol' ? 'Symbol preview' : 'Footprint preview';
    const preview = page.getByRole('img', { name: label, exact: true });
    const fit = page.getByRole('button', { name: `Fit ${kind} preview`, exact: true });
    await preview.scrollIntoViewIfNeeded();
    const fitted = await preview.getAttribute('viewBox');
    const geometry = await preview.innerHTML();
    const bounds = await preview.boundingBox();
    const point = {
      x: Math.round(bounds.x + bounds.width * 0.57),
      y: Math.round(bounds.y + bounds.height * 0.46),
    };
    const worldPoint = () =>
      preview.evaluate((svg, { x, y }) => {
        const world = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
        return { x: world.x, y: world.y };
      }, point);
    const previous = await worldPoint();
    const scrollOffset = () => preview.evaluate((svg) => svg.closest('.library-detail').scrollTop);
    const scrollBefore = await scrollOffset();
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -180);
    await page.waitForFunction(
      ({ label, fitted }) =>
        document.querySelector(`svg[aria-label="${label}"]`).getAttribute('viewBox') !== fitted,
      { label, fitted },
    );
    const magnified = (await preview.getAttribute('viewBox')).split(' ').map(Number);
    assert.ok(magnified[2] < Number(fitted.split(' ')[2]));
    const anchored = await worldPoint();
    assert.ok(
      Math.hypot(previous.x - anchored.x, previous.y - anchored.y) < 1e-4,
      `Wheel zoom preserves the world point under the pointer: ${JSON.stringify({ previous, anchored })}`,
    );
    assert.equal(await scrollOffset(), scrollBefore, 'Wheel zoom stays inside the preview.');
    await page.mouse.down();
    await page.mouse.move(point.x + 36, point.y + 22, { steps: 3 });
    await page.mouse.up();
    const panned = (await preview.getAttribute('viewBox')).split(' ').map(Number);
    assert.ok(panned[0] < magnified[0] && panned[1] < magnified[1]);
    assert.equal(panned[2], magnified[2]);
    await preview.dispatchEvent('keydown', { key: 'ArrowLeft', keyCode: 229, isComposing: true });
    assert.equal(await preview.getAttribute('viewBox'), panned.join(' '));
    await preview.press('ArrowLeft');
    assert.notEqual(await preview.getAttribute('viewBox'), panned.join(' '));
    await fit.click();
    assert.equal(await preview.getAttribute('viewBox'), fitted);
    assert.equal(await preview.innerHTML(), geometry, 'The view changes never rewrite geometry.');
    if (kind === 'symbol') {
      const touch = await page.context().newCDPSession(page);
      const area = await preview.boundingBox();
      const touchPoints = (radius) =>
        [-radius, radius].map((offset, id) => ({
          id,
          x: Math.round(area.x + area.width / 2 + offset),
          y: Math.round(area.y + area.height / 2),
        }));
      try {
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: touchPoints(24),
        });
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: touchPoints(46),
        });
        await page.waitForFunction(
          ({ label, fitted }) =>
            document.querySelector(`svg[aria-label="${label}"]`).getAttribute('viewBox') !== fitted,
          { label, fitted },
        );
        assert.ok(
          Number((await preview.getAttribute('viewBox')).split(' ')[2]) <
            Number(fitted.split(' ')[2]),
          'A two-finger pinch also zooms the preview.',
        );
      } finally {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await touch.detach();
      }
      await fit.click();
      assert.equal(await preview.getAttribute('viewBox'), fitted);
    }
  }
  const sourceField = page.getByRole('combobox', { name: 'Library source', exact: true });
  const subcategory = page.getByRole('combobox', { name: 'Category level 2', exact: true });
  const selectSource = async (source, id) => {
    await sourceField.click();
    await page
      .getByRole('listbox', { name: 'Library source', exact: true })
      .getByRole('option', { name: source, exact: true })
      .click();
    await page.locator('.library-detail-id').filter({ hasText: id }).waitFor();
  };
  const geometry = () =>
    page.evaluate(() =>
      [
        '.library-source-filters > button',
        '.library-search',
        '.library-results',
        '.library-results button[data-index]',
        '.library-detail',
        '.preview-tabs',
        '.symbol-detail-preview, .library-preview-stage',
      ].map((selector) =>
        [...document.querySelectorAll(selector)].slice(0, 3).map((node) => {
          const { width, height } = node.getBoundingClientRect();
          return [width, height];
        }),
      ),
    );
  await page.getByRole('status', { name: 'Loading preview', exact: true }).waitFor();
  assert.equal(await place.isDisabled(), true);
  initialDetail.resolve();
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
    }
    await page.waitForFunction(
      (expected) => document.querySelector('.library-detail-id')?.textContent === expected,
      entries[kind].id,
    );
    await page.locator('.library-info-section').first().waitFor();
    assert.equal(
      await modelTab.isDisabled(),
      true,
      'Known missing models are disabled immediately.',
    );
    assert.equal(await footprintTab.isEnabled(), true);
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
      await section('Symbol details').waitFor();
      assert.equal(await section('Symbol details').count(), 1);
      assert.equal(pairs.Units, '1');
      assert.equal(pairs.Prefix, 'R');
    } else {
      assert.equal(await section('3D models').count(), 1);
      assert.equal(pairs.Pads, '2');
    }
    for (const width of [1120, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await selectSource('JLCPCB', jlcEntries[kind].id);
      const reference = await geometry();
      await selectSource('KiCad', kicadEntries[kind].id);
      await assertTopControls();
      assert.equal(await subcategory.isDisabled(), true);
      assert.equal(await subcategory.textContent(), 'No subcategories');
      assert.deepEqual(await geometry(), reference, 'KiCad uses the JLCPCB chooser layout.');
      if (kind === 'symbols') {
        assert.deepEqual(await page.locator('.library-result-columns > button').allTextContents(), [
          'Name',
          'Package',
          'Footprint',
          'Model',
        ]);
        const assetColumns = page.locator('.library-result-columns > [data-asset-column]');
        const sortFootprint = assetColumns.first();
        const textStart = () =>
          sortFootprint.locator('span').evaluate((label) => label.getBoundingClientRect().left);
        const initialStart = await textStart();
        await sortFootprint.click();
        assert.equal(
          await textStart(),
          initialStart,
          'The sort indicator does not move the title.',
        );
        assert.ok(
          await assetColumns.evaluateAll((columns) =>
            columns.every((column) => {
              const label = column.querySelector('span');
              return label.scrollWidth <= label.clientWidth;
            }),
          ),
          'Asset column headings fit at both dialog widths.',
        );
        const list = page.locator('.library-component-results');
        const columnOffsets = await list.evaluate((node) => {
          const center = (element) => {
            const { left, width } = element.getBoundingClientRect();
            return left + width / 2;
          };
          const headers = node.querySelectorAll('[data-asset-column]');
          const indicators = node.querySelectorAll('button[data-index] .library-result-asset svg');
          return [...headers].map((header, index) =>
            Math.abs(center(header) - center(indicators[index])),
          );
        });
        assert.ok(
          columnOffsets.every((offset) => offset < 1),
          'Checkboxes align with their headers.',
        );
        await sortFootprint.click();
        await sortFootprint.click();
        assert.equal(
          await page.getByRole('button', { name: 'Symbol', exact: true }).isEnabled(),
          true,
        );
        assert.equal(await footprintTab.isEnabled(), true);
        if (width === 1120) await assertPlanarCamera('symbol');
        const readsBefore = packageReads;
        await footprintTab.press('Enter');
        await page.locator('svg.footprint-preview').waitFor();
        assert.equal(packageReads, readsBefore + 1);
        assert.equal(await modelTab.isDisabled(), true);
        assert.deepEqual(
          await geometry(),
          reference,
          'Switching geometry keeps the same preview frame.',
        );
        if (width === 1120) await assertPlanarCamera('footprint');
      } else if (width === 1120) {
        await assertPlanarCamera('footprint');
      }
      await selectSource('NextPCB', entries[kind].id);
      assert.deepEqual(await geometry(), reference, 'NextPCB uses the JLCPCB chooser layout.');
      assert.ok(
        await page.locator('.preview-tabs > button').evaluateAll((buttons) =>
          buttons.every((button) => {
            const label = document.createRange();
            label.selectNodeContents(button);
            return label.getClientRects().length === 1;
          }),
        ),
        'Preview labels fit on one line in the tested window sizes.',
      );
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
  await footprintTab.click();
  const footprintSvg = page.locator('svg.footprint-preview');
  await footprintSvg
    .locator(
      'path[d="M -0.25 -0.5 L 0.5 -0.5 L 0.5 -0.5 L 0.5 0.5 L 0.5 0.5 L -0.5 0.5 L -0.5 0.5 L -0.5 -0.25 L -0.25 -0.5 Z"]',
    )
    .waitFor();
  await footprintSvg
    .locator(
      'g[transform="translate(3 -2) rotate(-30)"] path[d="M -1 -0.5 L 1 -0.5 L 1 1 L 0.5 1 L 0.5 0.5 L -1 0.5 Z"]',
    )
    .waitFor();
  const mask = footprintSvg.locator('polygon[points="0,2 1,2 1,3 0,3"]');
  const cutout = footprintSvg.locator('polygon[points="2,2 3,2 3,3 2,3"]');
  await mask.waitFor();
  await cutout.waitFor();
  assert.equal(await mask.getAttribute('fill-opacity'), '0.22');
  assert.equal(await cutout.evaluate((node) => getComputedStyle(node).fill), 'none');
  const drill = page.locator('svg.footprint-preview rect[fill="var(--canvas)"]');
  await drill.waitFor();
  assert.deepEqual(
    await drill.evaluate((node) => ({
      x: node.x.baseVal.value,
      y: node.y.baseVal.value,
      width: node.getAttribute('width'),
      height: node.getAttribute('height'),
      radius: node.getAttribute('rx'),
      pose: node.parentElement.getAttribute('transform'),
      landX: node.previousElementSibling.getAttribute('x'),
      landY: node.previousElementSibling.getAttribute('y'),
      number: node.nextElementSibling.textContent,
    })),
    {
      x: -0.375,
      y: Math.fround(-0.2),
      width: '0.75',
      height: '0.4',
      radius: '0.2',
      pose: 'translate(0.15 -0.125) rotate(-90)',
      landX: '-0.875',
      landY: '-0.65',
      number: 'MH1',
    },
  );
  assert.equal(modelReads, 0);
  const modelRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/library-model',
  );
  assert.equal(
    await modelTab.evaluate((button) =>
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
  );
  await modelTab.press('Enter');
  assert.equal(new URL((await modelRequest).url()).searchParams.get('id'), 'JLCPCB:C7593');
  const retryModel = page.getByRole('button', { name: 'Retry preview', exact: true });
  await retryModel.waitFor();
  assert.equal(await modelTab.isEnabled(), true, 'A temporary failure leaves the 3D tab enabled.');
  modelMissing = true;
  await retryModel.click();
  await page.getByText('The linked STEP model is unavailable.', { exact: true }).waitFor();
  assert.equal(await modelTab.isDisabled(), true);
  assert.equal(await footprintTab.getAttribute('aria-pressed'), 'true');
  assert.equal(await retryModel.count(), 0);
  assert.equal(modelReads, 2);

  unsupportedPackage = true;
  let readsBefore;
  for (const kind of ['footprints', 'symbols']) {
    await page.evaluate((value) => window.setKind(value), kind);
    await page
      .getByRole('dialog', { name: kind === 'symbols' ? 'Components' : 'Footprints', exact: true })
      .getByRole('button', { name: 'Footprint', exact: true })
      .waitFor();
    for (const tab of [footprintTab, modelTab]) {
      assert.equal(await tab.isDisabled(), true);
      assert.equal(await tab.getAttribute('title'), pasteWarning);
    }
    assert.equal(await page.getByText(pasteWarning, { exact: true }).count(), 0);
    if (kind === 'footprints') readsBefore = packageReads;
  }
  assert.equal(await place.isEnabled(), true);
  assert.equal(packageReads, readsBefore, 'Known unsupported CAD needs no extra request.');

  unsupportedPackage = false;
  multipleModels = true;
  await page.setViewportSize({ width: 1120, height: 800 });
  const useModel = page.getByRole('button', { name: 'Use model', exact: true });
  const modelSelector = page.getByRole('combobox', { name: '3D model', exact: true });
  const modelOptions = page.getByRole('listbox', { name: '3D model', exact: true });
  const unavailableOption = modelOptions
    .getByRole('option')
    .filter({ hasText: 'JLCPCB:fixture.step' });
  for (const kind of ['models', 'symbols']) {
    modelMissing = true;
    await page.evaluate((value) => window.setKind(value), kind);
    await modelTab.click();
    await page.getByText('The linked STEP model is unavailable.', { exact: true }).waitFor();
    if (kind === 'models') assert.equal(await useModel.isDisabled(), true);
    assert.equal(await modelTab.isEnabled(), true, 'Another model keeps the 3D tab available.');
    await modelSelector.press('Enter');
    assert.equal(await unavailableOption.isDisabled(), true);
    modelMissing = false;
    await modelSelector.press('End');
    await Promise.all([
      page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/library-model' && url.searchParams.get('index') === '1';
      }),
      modelSelector.press('Enter'),
    ]);
    if (kind === 'models') assert.equal(await useModel.isEnabled(), true);
  }
  renderModels = true;
  multipleModels = false;
  const symbolTab = page.getByRole('button', { name: 'Symbol', exact: true });
  const symbolPreview = page.getByRole('img', { name: 'Symbol preview', exact: true });
  const footprintPreview = page.getByRole('img', { name: 'Footprint preview', exact: true });
  const fit = (kind) => page.getByRole('button', { name: `Fit ${kind} preview`, exact: true });
  const cameraAfterFrames = (canvas) =>
    canvas.evaluate(
      (node) =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(node.previewPose))),
        ),
    );
  function assertSamePose(actual, expected) {
    assert.ok(
      actual.every((coordinate, index) => Math.abs(coordinate - expected[index]) < 1e-7),
      'The model retains its position, zoom and orientation.',
    );
  }
  for (const kind of ['footprints', 'symbols']) {
    await page.evaluate((value) => window.setKind(value), kind);
    let symbolFit;
    let symbolPose;
    if (kind === 'symbols') {
      await symbolPreview.waitFor();
      symbolFit = await symbolPreview.getAttribute('viewBox');
      await symbolPreview.press('ArrowUp');
      await symbolPreview.press('=');
      symbolPose = await symbolPreview.getAttribute('viewBox');
      assert.notEqual(symbolPose, symbolFit);
      await footprintTab.click();
    }
    await footprintPreview.waitFor();
    const footprintFit = await footprintPreview.getAttribute('viewBox');
    await footprintPreview.press('ArrowLeft');
    await footprintPreview.press('-');
    const footprintPose = await footprintPreview.getAttribute('viewBox');
    assert.notEqual(footprintPose, footprintFit);
    const iconSize = (kind) =>
      fit(kind).locator('svg').evaluate((node) => {
        const { width, height } = node.getBoundingClientRect();
        return [width, height];
      });
    assert.deepEqual(await iconSize('footprint'), [16, 16]);
    const beforeRender = modelReads;
    await modelTab.click();
    await fit('model').waitFor();
    assert.deepEqual(await iconSize('model'), [16, 16]);
    const canvas = page.locator('.model-preview canvas');
    const fittedModel = await cameraAfterFrames(canvas);
    await canvas.evaluate((node) => (window.retainedModelCanvas = node));
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -190);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(bounds.x + bounds.width / 2 + 32, bounds.y + bounds.height / 2 + 14);
    await page.mouse.up({ button: 'right' });
    const movedModel = await cameraAfterFrames(canvas);
    assert.notDeepEqual(movedModel, fittedModel);
    if (kind === 'symbols') {
      await symbolTab.click();
      assert.deepEqual(await iconSize('symbol'), [16, 16]);
      assert.equal(await symbolPreview.getAttribute('viewBox'), symbolPose);
      await fit('symbol').click();
      assert.equal(await symbolPreview.getAttribute('viewBox'), symbolFit);
    }
    await footprintTab.click();
    assert.equal(await footprintPreview.getAttribute('viewBox'), footprintPose);
    assert.equal(await canvas.isVisible(), false);
    assert.equal(await canvas.evaluate((node) => node.previewRunning), false);
    const hiddenPose = await cameraAfterFrames(canvas);
    assertSamePose(await cameraAfterFrames(canvas), hiddenPose);
    await modelTab.click();
    await fit('model').waitFor();
    assert.equal(await canvas.evaluate((node) => node === window.retainedModelCanvas), true);
    assert.equal(modelReads, beforeRender + 1, 'Returning to the model does not read it again.');
    assertSamePose(await cameraAfterFrames(canvas), hiddenPose);
    await fit('model').click();
    assertSamePose(await cameraAfterFrames(canvas), fittedModel);
    await footprintTab.click();
    assert.equal(await footprintPreview.getAttribute('viewBox'), footprintPose);
    await fit('footprint').click();
    assert.equal(await footprintPreview.getAttribute('viewBox'), footprintFit);
  }
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
    'PASS: categorized details, responsive filters, attribution and asset availability for symbols and footprints.',
  );
} finally {
  await browser.close();
}
