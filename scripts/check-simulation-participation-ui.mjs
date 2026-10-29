import assert from 'node:assert/strict';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readNativeProject } from './source-editor-test-helpers.mjs';

// Real workspace with isolated, bundled-library fixtures; no Electron or provider.
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Workspace from './components/DesktopWorkspace';
      import {createProject,serializeProject} from './lib/project';
      import {emptyCircuit, createPart, libraries} from './lib/circuit';
      import {createLibraryPart} from './lib/library';
      import {defaultAgentPreferences} from './lib/workspace-state';
      window.fixturePreferences = defaultAgentPreferences;
      const schematic = emptyCircuit();
      schematic.parts.push(createPart(schematic, 'GND', 0, 0));
      const voltageLibrary = libraries['Simulation_SPICE:VDC'];
      schematic.libraries['Simulation_SPICE:VDC'] = structuredClone(voltageLibrary);
      schematic.parts.push(createLibraryPart(schematic, voltageLibrary, 25.4, 0));
      for (const [index, reference] of ['C10', 'R10', 'C2', 'R2', 'C1'].entries()) {
        const part = createPart(schematic, reference.startsWith('C') ? 'C' : 'R', (index + 2) * 12.7, 12.7);
        part.ref = reference;
        schematic.parts.push(part);
      }
      window.fixtureSource = serializeProject(createProject(schematic));
      createRoot(document.getElementById('root')).render(<Workspace/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/simulation-participation-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const symbols = JSON.parse(await readFile('lib/kicad-starter-symbols.json', 'utf8'));
const entries = ['Connector_Generic:Conn_01x01', 'Device:R'].map((id) => ({
  id,
  library: id.split(':')[0],
  name: id.split(':')[1],
  description: '',
  keywords: '',
}));
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = {
      writeWorkspaceRecovery: async (content) => {
        await fetch('http://localhost/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      titleBarOverlay: false,
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      projectDirectory: async () => ({ entries: [], truncated: false }),
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() !== 'GET') return route.fulfill({ json: null });
      const source = await page.evaluate(() => window.fixtureSource);
      const id = crypto.randomUUID(),
        session = crypto.randomUUID();
      return route.fulfill({
        json: {
          version: 2,
          documents: [
            {
              id,
              source,
              dirty: false,
              sourceDraft: null,
              filename: 'participation.kicad_pro',
              sessions: [{ id: session, messages: [], draft: '' }],
              activeSessionId: session,
            },
          ],
          activeDocumentId: id,
          ...(await page.evaluate(() => window.fixturePreferences)),
        },
      });
    }
    if (url.pathname === '/api/libraries/symbols') {
      const id = url.searchParams.get('id');
      if (id)
        return route.fulfill({
          json: {
            ...entries.find((e) => e.id === id),
            symbol: symbols[id],
            units: 1,
            footprint: '',
          },
        });
      const query = (url.searchParams.get('q') || '').toLowerCase();
      const matches = entries.filter((e) => e.id.toLowerCase().includes(query));
      return route.fulfill({
        json: { entries: matches, total: matches.length, libraries: entries.map((e) => e.library) },
      });
    }
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/simulation/status')
      return route.fulfill({ json: { available: true, version: 'Isolated UI fixture' } });
    if (url.pathname === '/api/simulation/result') return route.fulfill({ json: { result: null } });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.getByTestId('schematic-canvas').waitFor();
  await button('Add component').click();
  assert.equal(await page.getByRole('switch').count(), 0, 'The chooser only places components.');
  await page.waitForFunction(
    () =>
      document.querySelector('.library-detail > strong')?.textContent ===
      'Connector_Generic:Conn_01x01',
  );
  await button('Place').click();
  await page.getByTestId('schematic-canvas').click({ position: { x: 380, y: 260 } });
  await page.keyboard.press('Escape');
  await button('Source').click();
  let saved = await readNativeProject(page);
  const part = saved.schematic.parts.find((part) => part.libId === 'Connector_Generic:Conn_01x01');
  const ground = saved.schematic.parts.find((part) => part.libId === 'power:GND');
  const voltage = saved.schematic.parts.find((part) => part.libId === 'Simulation_SPICE:VDC');
  const excluded = (project, id) =>
    project.schematic.parts
      .find((item) => item.id === id)
      .raw.some((node) => node[0] === 'exclude_from_sim' && node[1] === 'yes');
  assert.equal(saved.schematic.parts.length, 8);
  const nativeOrder = saved.schematic.parts.map((part) => part.ref);
  assert.equal(excluded(saved, part.id), true);
  await button('Schematic').click();
  await page
    .getByTestId('schematic-canvas')
    .locator('[data-selection-id="' + part.id + '"]')
    .first()
    .dblclick();
  assert.equal(await page.locator('.part-properties').getByRole('switch').count(), 0);
  assert.equal(
    await page.locator('.part-properties > .property-simulation').count(),
    1,
    'Every component exposes the SPICE model chooser even without simulation fields.',
  );
  await button('SPICE Simulation').click();
  const panel = page.getByRole('region', { name: 'Simulation settings', exact: true });
  const components = panel.getByRole('region', { name: 'Components', exact: true });
  const participation = components.getByRole('switch', {
    name: 'Include ' + part.ref + ' in SPICE simulation',
    exact: true,
  });
  const waitParticipation = (checked) =>
    components
      .getByRole('switch', {
        name: 'Include ' + part.ref + ' in SPICE simulation',
        exact: true,
        checked,
      })
      .waitFor();
  await waitParticipation(false);
  assert.equal(
    await participation.isEnabled(),
    true,
    'Unsupported circuits retain participation controls.',
  );
  assert.equal(await components.getByRole('switch').count(), 7);
  assert.deepEqual(
    await components.locator('.analysis-category-name').allTextContents(),
    ['Capacitors', 'Connectors', 'Resistors', 'Voltage sources'],
    'Components are grouped by reference prefix in alphabetical order.',
  );
  assert.deepEqual(
    await components
      .getByRole('switch')
      .evaluateAll((switches) => switches.map((element) => element.getAttribute('aria-label'))),
    ['C1', 'C2', 'C10', part.ref, 'R2', 'R10', voltage.ref].map(
      (reference) => 'Include ' + reference + ' in SPICE simulation',
    ),
    'Each category uses natural reference order, placing C2 before C10.',
  );
  assert.deepEqual(
    await components.locator('.analysis-component-locate').allTextContents(),
    ['C1', 'C2', 'C10', part.ref, 'R2', 'R10', voltage.ref],
    'Component cells show references without values.',
  );
  const capacitors = components.getByRole('group', { name: 'Capacitors (C)', exact: true });
  assert.equal(await capacitors.locator('summary').innerText(), 'Capacitors');
  const capacitorBounds = await capacitors.locator('.simulation-field').evaluateAll((items) =>
    items.map((item) => {
      const bounds = item.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width };
    }),
  );
  assert.ok(Math.abs(capacitorBounds[0].y - capacitorBounds[1].y) < 1);
  assert.ok(capacitorBounds[1].x > capacitorBounds[0].x + capacitorBounds[0].width);
  assert.ok(
    capacitorBounds[2].y > capacitorBounds[0].y &&
      Math.abs(capacitorBounds[2].x - capacitorBounds[0].x) < 1,
    'Cells wrap in naturally sorted rows of two.',
  );
  assert.equal(
    await components.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    'The compact component grid fits the sidebar.',
  );
  const capacitorHeading = capacitors.locator('summary');
  const firstCapacitor = capacitors.getByRole('switch', {
    name: 'Include C1 in SPICE simulation',
    exact: true,
  });
  assert.equal(await capacitors.getAttribute('open'), '', 'Categories start expanded.');
  await capacitorHeading.click();
  await capacitors.locator('.simulation-field').first().waitFor({ state: 'hidden' });
  const hiddenCapacitorSwitch = capacitors.getByRole('switch', { includeHidden: true }).first();
  assert.equal(await hiddenCapacitorSwitch.isDisabled(), true);
  await hiddenCapacitorSwitch.evaluate((element) => element.click());
  assert.equal(
    await hiddenCapacitorSwitch.getAttribute('aria-checked'),
    'true',
    'Collapsed controls cannot edit participation.',
  );
  assert.equal(
    await components.getByRole('switch').count(),
    4,
    'Collapsing hides only that category.',
  );
  assert.equal(await participation.isVisible(), true);
  await capacitorHeading.press('Enter');
  await firstCapacitor.waitFor();
  await capacitorHeading.press('Space');
  await capacitors.locator('.simulation-field').first().waitFor({ state: 'hidden' });
  await button('Close simulation settings').click();
  await button('SPICE Simulation').click();
  assert.equal(
    await capacitors.getAttribute('open'),
    null,
    'Reopening settings retains collapsed categories.',
  );
  await page.screenshot({ path: 'test-results/openpe-simulation-participation-collapsed.png' });
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    saved,
    'Category toggles do not change native design data.',
  );
  await button('Schematic').click();
  assert.equal(
    await capacitors.getAttribute('open'),
    null,
    'View changes retain collapsed categories.',
  );
  assert.deepEqual(
    await capacitorHeading.evaluate((element) => {
      return [
        { key: 'Enter', isComposing: true },
        { key: 'Enter', keyCode: 229 },
      ].map((input) => {
        const event = new KeyboardEvent('keydown', { ...input, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
    }),
    [true, true],
    'Composing keyboard events cannot toggle categories.',
  );
  await capacitorHeading.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.click();
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  assert.equal(
    await capacitors.getAttribute('open'),
    null,
    'Composition blocks category activation.',
  );
  await capacitorHeading.press('Enter');
  await firstCapacitor.waitFor();
  assert.equal(
    await components
      .getByRole('switch', { name: 'Include ' + ground.ref + ' in SPICE simulation' })
      .count(),
    0,
    'Ground markers have no participation controls.',
  );
  assert.equal(
    await components
      .getByRole('switch', { name: 'Include ' + voltage.ref + ' in SPICE simulation' })
      .count(),
    1,
    'Virtual voltage sources remain components.',
  );
  const row = participation.locator('..');
  const labelBounds = await row.locator('.analysis-component-locate').boundingBox();
  const switchBounds = await participation.boundingBox();
  const rowBounds = await row.boundingBox();
  assert.ok(switchBounds.x >= labelBounds.x + labelBounds.width);
  assert.ok(switchBounds.x + switchBounds.width <= rowBounds.x + rowBounds.width + 1);
  assert.ok(
    Math.abs(labelBounds.y + labelBounds.height / 2 - switchBounds.y - switchBounds.height / 2) <=
      1,
  );
  await page.screenshot({ path: 'test-results/openpe-simulation-participation-panel.png' });
  await components.screenshot({ path: 'test-results/spice-components-refined.png' });
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await components.screenshot({ path: 'test-results/spice-components-refined-dark.png' });
  await page.evaluate((theme) => {
    if (theme === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, originalTheme);
  const resistor2 = saved.schematic.parts.find((part) => part.ref === 'R2');
  await components.getByRole('button', { name: 'Locate R2', exact: true }).click();
  const resistorHighlight = page
    .getByTestId('schematic-canvas')
    .locator(`.part.is-selected[data-selection-id="${resistor2.id}"] [data-selection-only]`);
  await resistorHighlight.first().waitFor();
  assert.equal(await panel.isVisible(), true, 'Locating keeps the analysis panel open.');
  assert.equal(
    await participation.getAttribute('aria-checked'),
    'false',
    'Locating changes no participation setting.',
  );
  await components
    .getByRole('button', { name: 'Locate ' + part.ref, exact: true })
    .evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.click();
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
  assert.equal(
    (await resistorHighlight.count()) > 0,
    true,
    'Composition cannot locate a different component.',
  );
  await page.screenshot({ path: 'test-results/spice-component-highlight.png' });
  await components.getByRole('button', { name: 'Locate ' + part.ref, exact: true }).press('Enter');
  await page
    .getByTestId('schematic-canvas')
    .locator(`.part.is-selected[data-selection-id="${part.id}"] [data-selection-only]`)
    .first()
    .waitFor();
  await participation.click();
  await waitParticipation(true);
  await button('Source').click();
  saved = await readNativeProject(page);
  assert.equal(excluded(saved, part.id), false);
  assert.deepEqual(
    saved.schematic.parts.map((part) => part.ref),
    nativeOrder,
    'Display sorting preserves native component order.',
  );
  assert.deepEqual(
    saved.schematic.parts.find((part) => part.id === ground.id),
    ground,
    'Filtering markers preserves their native data.',
  );
  await button('Schematic').click();
  await button('Undo').click();
  await waitParticipation(false);
  await button('Source').click();
  saved = await readNativeProject(page);
  assert.equal(excluded(saved, part.id), true);
  await button('Schematic').click();
  for (const key of ['Space', 'Enter']) {
    await participation.focus();
    await participation.press(key);
    await waitParticipation(true);
    await button('Undo').click();
    await waitParticipation(false);
  }
  await participation.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.click();
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }),
    );
  });
  assert.equal(
    await participation.getAttribute('aria-checked'),
    'false',
    'IME cannot change participation.',
  );
  await button('Close simulation settings').click();
  await button('Add component').click();
  const dialog = page.getByRole('dialog', { name: 'Choose symbol', exact: true });
  assert.equal(await dialog.getByRole('switch').count(), 0);
  await page.getByRole('button', { name: 'R Device', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.library-detail > strong')?.textContent === 'Device:R',
  );
  await button('Place').click();
  await page.getByTestId('schematic-canvas').click({ position: { x: 480, y: 360 } });
  await page.keyboard.press('Escape');
  await button('Source').click();
  saved = await readNativeProject(page);
  const resistor = saved.schematic.parts.find((p) => p.ref === 'R1');
  assert.ok(resistor);
  assert.equal(excluded(saved, resistor.id), false);
  await button('Schematic').click();
  await button('SPICE Simulation').click();
  assert.equal(await components.getByRole('switch').count(), 8);
  assert.deepEqual(
    await components
      .getByRole('group', { name: 'Resistors (R)', exact: true })
      .locator('.analysis-component-locate')
      .allTextContents(),
    ['R1', 'R2', 'R10'],
    'New components enter the matching category in natural order.',
  );
  assert.equal(
    await components
      .getByRole('switch', { name: 'Include ' + resistor.ref + ' in SPICE simulation' })
      .getAttribute('aria-checked'),
    'true',
  );
  await page
    .getByTestId('schematic-canvas')
    .locator('[data-selection-id="' + part.id + '"]')
    .first()
    .click();
  await page
    .getByText(
      'This component is excluded from simulation. Enable it under Components in SPICE Simulation to inspect it.',
      { exact: true },
    )
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Simulation participation: collapsible retained categories, natural reference sorting, unchanged native data/order, retained virtual sources, pointer/keyboard/IME, native flags, one-step undo and excluded probes passed.',
  );
} finally {
  await browser.close();
}
