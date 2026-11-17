import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolated library browsing fixtures; no desktop, provider or user data access.
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import LibraryChooser from './components/LibraryChooser';
      import PartProperties from './components/PartProperties';
      import {createPart, emptyCircuit} from './lib/circuit';
      import {quote} from './lib/sexpr';
      function Properties({footprint}) {
        const [part, setPart] = useState(() => ({
          ...createPart(emptyCircuit(), 'R', 0, 0),
          // Imported KiCad fields can live in raw instead of part.fields.
          raw: ['symbol', ['property', quote('Footprint'), quote(footprint)]],
        }));
        return <PartProperties part={part} onSave={(ref, value, fields) => {
          window.propertySaves.push({ref, value, fields});
          setPart(current => ({...current, ref, value, fields}));
          return true;
        }}/>;
      }
      const root = createRoot(document.getElementById('root'));
      let propertiesInvocation = 0;
      window.showProperties = footprint => {
        window.propertySaves = [];
        root.render(<Properties footprint={footprint} key={++propertiesInvocation}/>);
      };
      window.showModelChooser = () => {
        window.modelChosen = false;
        root.render(<LibraryChooser kind="footprints" initialPreview="3d" requireModel actionLabel="Use model" onClose={()=>{}} onChoose={()=>{window.modelChosen=true;}}/>);
      };
      root.render(<LibraryChooser kind="footprints" onClose={()=>{}} onChoose={detail=>window.chosen=detail.id}/>);
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const entries = Array.from({ length: 205 }, (_, index) => ({
  id: `Fixture:Footprint_${String(index).padStart(3, '0')}`,
  name: `Footprint_${String(index).padStart(3, '0')}`,
  library: 'Fixture',
  description: 'Test footprint',
}));
const libraryNames = [
  'Fixture',
  ...Array.from({ length: 80 }, (_, i) => `Library_${String(i).padStart(2, '0')}`),
];
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const errors = [];
  const offsets = [];
  let failNextPage = true;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/libraries/footprints') {
      if (url.searchParams.get('categories') === 'KiCad')
        return route.fulfill({
          json: { categories: libraryNames.map((name) => ({ id: name, name, children: [] })) },
        });
      const id = url.searchParams.get('id');
      if (id)
        return route.fulfill({
          json: {
            ...entries.find((entry) => entry.id === id),
            footprint: [
              'footprint',
              id,
              ['pad', '1', 'smd', 'rect', ['at', '0', '0'], ['size', '1', '1']],
            ],
            pads: ['1'],
            models: [],
          },
        });
      const offset = Number(url.searchParams.get('offset') || 0);
      const query = url.searchParams.get('q');
      offsets.push({ offset, query });
      if (offset === 100 && failNextPage) {
        failNextPage = false;
        return route.fulfill({ status: 503, json: { error: 'Fixture loading failure' } });
      }
      const matches = query ? entries.filter((entry) => entry.id.includes(query)) : entries;
      return route.fulfill({
        json: {
          entries: matches.slice(offset, offset + 100),
          total: matches.length,
          libraries: libraryNames,
        },
      });
    }
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const rows = page.locator('.library-results button');
  const list = page.locator('.library-results');
  const search = page.getByRole('textbox', { name: 'Search footprints' });
  const assign = page.getByRole('button', { name: 'Assign footprint', exact: true });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.library-results button').length === 100 &&
      !document.querySelector('.dialog-button.primary').disabled,
  );
  assert.equal(await page.locator('.library-pagination').count(), 0);
  const library = page.getByRole('combobox', { name: 'Category', exact: true });
  await library.click();
  const popup = page.getByRole('listbox', { name: 'Category', exact: true });
  await popup.waitFor();
  const popupBounds = await popup.boundingBox();
  assert.ok(popupBounds.height <= 280 && popupBounds.y + popupBounds.height <= 760);
  await library.press('End');
  await page.waitForFunction(() => document.querySelector('[role="listbox"]').scrollTop > 0);
  const lastOption = await popup.getByRole('option').last().boundingBox();
  assert.ok(
    lastOption.y >= popupBounds.y &&
      lastOption.y + lastOption.height <= popupBounds.y + popupBounds.height,
  );
  await library.press('Home');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/library-filter-compact.png' });
  await library.press('Escape');
  assert.equal(await library.getAttribute('aria-expanded'), 'false');
  assert.equal(await library.evaluate((element) => element === document.activeElement), true);
  assert.equal(
    await page.getByText(/numbered pads|linked 3D model|No 3D model assigned/).count(),
    0,
  );
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.getByRole('alert').filter({ hasText: 'Fixture loading failure' }).waitFor();
  assert.equal(await rows.count(), 100, 'A failed next page retains loaded entries.');
  await page.getByRole('button', { name: 'Retry loading results' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.library-results button').length === 200,
  );
  assert.equal(
    await rows.first().getAttribute('aria-pressed'),
    'true',
    'Appending preserves selection.',
  );
  await rows.nth(99).click();
  await rows.nth(99).press('ArrowDown');
  assert.equal(
    await rows.nth(100).getAttribute('aria-pressed'),
    'true',
    'Keyboard navigation crosses pages.',
  );
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.library-results button').length === 205,
  );
  assert.deepEqual(
    offsets.map((request) => request.offset),
    [0, 100, 100, 200],
  );
  await rows.last().click();
  await page.waitForFunction(() => !document.querySelector('.dialog-button.primary').disabled);
  await assign.click();
  assert.equal(await page.evaluate(() => window.chosen), entries.at(-1).id);
  await search.fill('Footprint_002');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.library-results button').length === 1 &&
      !document.querySelector('.dialog-button.primary').disabled,
  );
  assert.equal(await rows.first().getAttribute('aria-description'), entries[2].id);
  assert.equal(offsets.at(-1).offset, 0, 'New searches reset paging.');
  await search.fill('missing');
  await page.getByText('No matching footprints.', { exact: true }).waitFor();
  assert.equal(await assign.isEnabled(), false);
  await search.fill('');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.library-results button').length === 100 &&
      !document.querySelector('.dialog-button.primary').disabled,
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/library-scroll.png' });

  // Browse from the schematic inspector must start at its current assignment,
  // including fields retained in an imported symbol's raw KiCad properties.
  await page.evaluate((id) => window.showProperties(id), entries.at(-1).id);
  const footprint = page.getByRole('textbox', { name: 'Footprint', exact: true });
  const browse = page.getByRole('button', { name: 'Browse footprints', exact: true });
  await browse.click();
  assert.equal(await search.inputValue(), entries.at(-1).id);
  await page.waitForFunction(() => !document.querySelector('.dialog-button.primary').disabled);
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.first().getAttribute('aria-description'), entries.at(-1).id);
  assert.equal(await rows.first().getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.library-detail-id').textContent(), entries.at(-1).id);
  await page.getByRole('img', { name: 'Footprint preview' }).waitFor();
  assert.equal(await page.evaluate(() => window.propertySaves.length), 0);
  await search.press('Escape');
  assert.equal(await footprint.inputValue(), entries.at(-1).id);
  assert.equal(await browse.evaluate((element) => element === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.propertySaves.length), 0);

  await browse.click();
  await page.waitForFunction(() => !document.querySelector('.dialog-button.primary').disabled);
  await assign.click();
  assert.equal(
    await page.evaluate(() => window.propertySaves.length),
    0,
    'Reassigning the current footprint is a clean no-op.',
  );

  await browse.click();
  await search.fill('Footprint_002');
  await page.waitForFunction(() => !document.querySelector('.dialog-button.primary').disabled);
  await assign.click();
  assert.equal(await footprint.inputValue(), entries[2].id);
  assert.deepEqual(
    await page.evaluate(() => window.propertySaves.map((save) => save.fields.Footprint)),
    [entries[2].id],
    'A replacement is applied once.',
  );
  await browse.click();
  assert.equal(
    await search.inputValue(),
    entries[2].id,
    'Reopening follows the latest assignment.',
  );
  await search.press('Escape');

  await footprint.fill(entries[3].id);
  await browse.click();
  assert.equal(
    await search.inputValue(),
    entries[3].id,
    'Browse uses the current manually edited field.',
  );
  await search.press('Escape');

  await page.evaluate(() => window.showProperties('Fixture:Missing'));
  await browse.click();
  assert.equal(await search.inputValue(), 'Fixture:Missing');
  await page.getByText('No matching footprints.', { exact: true }).waitFor();
  assert.equal(await assign.isEnabled(), false);
  await search.press('Escape');
  assert.equal(await footprint.inputValue(), 'Fixture:Missing');
  assert.equal(await page.evaluate(() => window.propertySaves.length), 0);

  await page.evaluate(() => window.showProperties(''));
  await browse.click();
  assert.equal(await search.inputValue(), '');
  await page.waitForFunction(() => !document.querySelector('.dialog-button.primary').disabled);
  assert.equal(await rows.count(), 100, 'Unassigned components retain full catalog browsing.');

  // The inspector owns a genuinely dismissible chooser, unlike the initial
  // browsing-only fixture's no-op onClose callback.
  const chooser = page.getByRole('dialog', { name: 'Footprints', exact: true });
  const chooserState = () =>
    chooser.evaluate((dialog) => ({
      query: dialog.querySelector('input[aria-label="Search footprints"]').value,
      selected: dialog
        .querySelector('.library-results button[aria-pressed="true"]')
        ?.getAttribute('aria-description'),
      preview: dialog.querySelector('.library-detail-id')?.textContent,
      rowCount: dialog.querySelectorAll('.library-results button').length,
      scrollTop: dialog.querySelector('.library-results').scrollTop,
    }));
  const unchanged = await chooserState();
  for (const target of [search, rows.first()]) {
    await target.focus();
    for (const composing of [{ isComposing: true }, { keyCode: 229 }])
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
          { key, ...composing },
        );
        assert.equal(prevented, true, 'IME confirmation/cancellation suppresses browser defaults.');
        assert.equal(await chooser.isVisible(), true);
        assert.equal(await target.evaluate((node) => document.activeElement === node), true);
        assert.deepEqual(
          await chooserState(),
          unchanged,
          'IME keys retain query, selection and preview.',
        );
        assert.equal(await page.evaluate(() => window.propertySaves.length), 0);
      }
  }

  // Synthetic composition lifecycle plus real browser keys verifies the local
  // lifecycle guard and native Escape default. This does not emulate an OS IME.
  await search.focus();
  await search.dispatchEvent('compositionstart', { data: '' });
  for (const key of ['Enter', 'Escape']) {
    await page.keyboard.press(key);
    assert.equal(await chooser.isVisible(), true, 'Active composition keeps the chooser open.');
    assert.equal(await search.evaluate((node) => document.activeElement === node), true);
    assert.deepEqual(await chooserState(), unchanged);
    assert.equal(await page.evaluate(() => window.propertySaves.length), 0);
  }
  await search.dispatchEvent('compositionend', { data: '' });
  await page.keyboard.press('Escape');
  await chooser.waitFor({ state: 'detached' });
  assert.equal(await browse.evaluate((node) => document.activeElement === node), true);
  assert.equal(await footprint.inputValue(), '');
  assert.equal(await page.evaluate(() => window.propertySaves.length), 0);

  for (const surface of ['search', 'result']) {
    await page.evaluate(() => window.showProperties(''));
    await browse.click();
    assert.equal(await footprint.inputValue(), '', 'Each fixture invocation starts unassigned.');
    assert.equal(
      await search.inputValue(),
      '',
      'A fresh unassigned fixture starts with an empty query.',
    );
    await search.fill('Footprint_002');
    await page.waitForFunction(
      (id) =>
        document.querySelectorAll('.library-results button').length === 1 &&
        document.querySelector('.library-detail-id')?.textContent === id &&
        !document.querySelector('.dialog-button.primary').disabled,
      entries[2].id,
    );
    await (surface === 'search' ? search : rows.first()).focus();
    await page.keyboard.press('Enter');
    if (surface === 'search') {
      assert.equal(await chooser.isVisible(), true, 'Search Enter searches without assigning.');
      assert.equal(await page.evaluate(() => window.propertySaves.length), 0);
      await page.waitForFunction(
        (id) =>
          document.querySelectorAll('.library-results button').length === 1 &&
          document.querySelector('.library-detail-id')?.textContent === id &&
          !document.querySelector('.dialog-button.primary').disabled,
        entries[2].id,
      );
      await rows.first().press('Enter');
    }
    await chooser.waitFor({ state: 'detached' });
    assert.equal(await footprint.inputValue(), entries[2].id);
    assert.deepEqual(
      await page.evaluate(() => window.propertySaves.map((save) => save.fields.Footprint)),
      [entries[2].id],
      `Result Enter after ${surface} interaction confirms the current footprint exactly once.`,
    );
  }
  await page.evaluate(() => window.showModelChooser());
  await page.getByText('This footprint has no 3D model.', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Use model', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole('button', { name: '3D model', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('textbox', { name: 'Search footprints', exact: true }).press('Enter');
  assert.equal(
    await page.evaluate(() => window.modelChosen),
    false,
    'A footprint without models cannot be assigned as a model.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Library browsing: category scrolling, scroll loading, retries, keyboard paging, current footprint preview, reassignment, cancellation, empty-state protection, IME guards, search Enter and result Enter confirmation passed.',
  );
} finally {
  await browser.close();
}
