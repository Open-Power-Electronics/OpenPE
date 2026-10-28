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
      import {emptyCircuit} from './lib/circuit';
      window.fixtureSource = serializeProject(createProject(emptyCircuit()));
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
              filename: null,
              sessions: [{ id: session, messages: [], draft: '' }],
              activeSessionId: session,
            },
          ],
          activeDocumentId: id,
          provider: 'codex',
          effort: 'low',
          approvalMode: 'review',
          models: {},
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
  const participation = page.getByRole('switch', { name: 'Include in simulation', exact: true });
  const simulation = page.locator('.part-properties > .property-simulation');
  const assertParticipationHeader = async (included) => {
    await participation.waitFor();
    assert.equal(await participation.getAttribute('aria-checked'), String(included));
    assert.equal(
      await simulation.locator('summary').count(),
      0,
      'Components without simulation fields retain a plain Simulation header.',
    );
    assert.equal(await simulation.locator('.property-field').count(), 0);
    const heading = simulation.locator('.property-simulation-heading');
    const title = heading.getByText('Simulation', { exact: true });
    assert.equal(await heading.getByRole('switch').count(), 1);
    const [titleBounds, switchBounds, headingBounds] = await Promise.all([
      title.boundingBox(),
      participation.boundingBox(),
      heading.boundingBox(),
    ]);
    assert.ok(titleBounds && switchBounds && headingBounds);
    assert.ok(
      switchBounds.x >= titleBounds.x + titleBounds.width,
      'The participation switch sits to the right of Simulation.',
    );
    assert.ok(
      Math.abs(titleBounds.y + titleBounds.height / 2 - switchBounds.y - switchBounds.height / 2) <=
        1,
      'The Simulation title and participation switch share a vertically centered row.',
    );
    assert.ok(
      switchBounds.x + switchBounds.width <= headingBounds.x + headingBounds.width + 1,
      'The switch fits within the Simulation header.',
    );
  };
  await page.waitForFunction(
    () =>
      document.querySelector('.library-detail > strong')?.textContent ===
      'Connector_Generic:Conn_01x01',
  );
  assert.equal(
    await participation.count(),
    0,
    'Simulation participation is a Properties design setting.',
  );
  await button('Place').click();
  await page.getByTestId('schematic-canvas').click({ position: { x: 380, y: 260 } });
  await page.keyboard.press('Escape');
  await button('Source').click();
  let saved = await readNativeProject(page);
  const part = saved.schematic.parts[0];
  assert.equal(saved.schematic.parts.length, 1);
  assert.ok(part.raw.some((node) => node[0] === 'exclude_from_sim' && node[1] === 'yes'));
  await button('Schematic').click();
  await page
    .getByTestId('schematic-canvas')
    .locator(`[data-selection-id="${part.id}"]`)
    .first()
    .dblclick();
  await assertParticipationHeader(false);
  await participation.click();
  await assertParticipationHeader(true);
  await page.screenshot({ path: 'test-results/openpe-simulation-participation-properties.png' });
  await button('Source').click();
  saved = await readNativeProject(page);
  assert.ok(
    !saved.schematic.parts[0].raw.some(
      (node) => node[0] === 'exclude_from_sim' && node[1] === 'yes',
    ),
  );
  await button('Schematic').click();
  await button('Undo').click();
  await button('Source').click();
  saved = await readNativeProject(page);
  assert.ok(
    saved.schematic.parts[0].raw.some(
      (node) => node[0] === 'exclude_from_sim' && node[1] === 'yes',
    ),
  );
  await button('Schematic').click();
  await button('Add component').click();
  const dialog = page.getByRole('dialog', { name: 'Choose symbol', exact: true });
  assert.equal(await dialog.getByRole('checkbox').count(), 0);
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
  const resistor = saved.schematic.parts.find((p) => p.libId === 'Device:R');
  assert.ok(resistor);
  assert.ok(!(resistor.raw ?? []).some((n) => n[0] === 'exclude_from_sim' && n[1] === 'yes'));
  await button('Schematic').click();
  await page
    .getByTestId('schematic-canvas')
    .locator(`[data-selection-id="${resistor.id}"]`)
    .first()
    .dblclick();
  await assertParticipationHeader(true);
  await button('Simulation').click();
  await page
    .getByTestId('schematic-canvas')
    .locator(`[data-selection-id="${part.id}"]`)
    .first()
    .click();
  await page
    .getByText(
      'This component is excluded from simulation. Enable Include in simulation in Properties to inspect it.',
      { exact: true },
    )
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Simulation participation: connector/passive defaults, header switch without parameter fields, placement, native exclusion flags and undo passed.',
  );
} finally {
  await browser.close();
}
