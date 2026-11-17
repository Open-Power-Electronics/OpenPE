import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const { createProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { prepareThermalModel } = await tsImport(
  '../plugins/layout-thermal/domain/thermal.ts',
  import.meta.url,
);
const project = createProject();
project.name = 'Thermal UI fixture';
project.pcb = {
  id: randomUUID(),
  thickness: 1.6,
  layers: ['F.Cu', 'B.Cu'],
  nets: [],
  tracks: [],
  vias: [],
  zones: [],
  graphics: [
    {
      id: randomUUID(),
      kind: 'polygon',
      layer: 'Edge.Cuts',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 20 },
      points: [
        { x: 20, y: 0 },
        { x: 20, y: 20 },
      ],
      width: 0.05,
    },
  ],
  footprints: [
    {
      id: randomUUID(),
      reference: 'U1',
      value: 'Heater',
      symbolId: null,
      libraryId: 'Fixture:Heater',
      x: 10,
      y: 10,
      rotation: 0,
      side: 'front',
      graphics: [],
      pads: [
        {
          id: randomUUID(),
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 4, y: 4 },
          layers: ['F.Cu'],
          netId: null,
        },
      ],
    },
  ],
};
const originalSource = serializeProject(project);
await mkdir('test-results', { recursive: true });
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Thermal from './plugins/layout-thermal/renderer/ThermalSimulation';import{createCapabilityHost}from'./api/capabilities';import{loadWorkbenchPlugins}from'./lib/workbench-plugins';import{serializeProject}from'./lib/project';
      const initial=${JSON.stringify(project)};const host=createCapabilityHost();await loadWorkbenchPlugins();
      function Harness(){const[visible,setVisible]=useState(true);const[pending,setPending]=useState(false);const[spiceAvailable,setSpiceAvailable]=useState(true);const[generation,setGeneration]=useState(0);const[project,setProject]=useState(initial);window.thermalTest={host,setVisible,setPending,setSpiceAvailable,remount:()=>setGeneration(value=>value+1),changeSource:()=>setProject({...project,name:'Changed source'}),source:()=>serializeProject(project)};return <div style={{position:'relative',width:900,height:740,background:'#f7f7f7'}}><Thermal key={generation} fileId="00000000-0000-4000-8000-000000000001" project={project} visible={visible} sourcePending={pending} spiceAvailable={spiceAvailable} capabilityHost={host} onClose={()=>setVisible(false)}/></div>;}createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'test-results/thermal-ui.js',
  format: 'esm',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.thermalResultStages = [];
    new MutationObserver(() => {
      const stage = document
        .querySelector('[data-saved-result-loading]')
        ?.getAttribute('data-saved-result-loading');
      if (stage) window.thermalResultStages.push(stage);
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-saved-result-loading'],
    });
    window.thermalExports = [];
    window.thermalAborts = 0;
    window.spiceHeatAborts = 0;
    const originalFetch = window.fetch;
    window.fetch = (url, options) => {
      if (String(url).endsWith('/thermal/run'))
        options?.signal?.addEventListener('abort', () => window.thermalAborts++, { once: true });
      if (String(url).endsWith('/thermal/spice-sources'))
        options?.signal?.addEventListener('abort', () => window.spiceHeatAborts++, { once: true });
      return originalFetch(url, options);
    };
    window.openpe = {
      titleBarOverlay: false,
      connection: async () => ({ base: 'http://localhost', token: 'thermal-test' }),
      exportImage: async (image) => {
        window.thermalExports.push(image);
        return { name: `${image.name}.png` };
      },
    };
  });
  let requests = 0;
  let resultRequests = 0;
  let saved = null;
  let holdResult = false;
  const heldResults = [];
  let hold = false;
  let holdStatus = false;
  let heldStatus;
  const held = [];
  let spiceRequests = 0;
  let holdSpice = false;
  const heldSpice = [];
  const importedPower = 0.00375000123456;
  const spiceSources = {
    heatSources: [{ footprintId: project.pcb.footprints[0].id, powerW: importedPower }],
    spiceSource: {
      config: {
        inputId: 'input',
        pwmId: 'pwm',
        outputId: 'output',
        switchId: 'switch',
        currentId: 'current',
        voltage: 12,
        frequency: 100000,
        duty: 50,
        stop: 0.01,
        step: 0.0000002,
      },
      startS: 0.008,
      endS: 0.01,
      resultBasis: 'a'.repeat(64),
    },
    losses: [
      {
        footprintId: project.pcb.footprints[0].id,
        reference: 'U1',
        powerW: importedPower,
        method: 'fixture dissipative V·I',
      },
    ],
    assumptions: ['Explicit renderer fixture; no electrical solver was executed.'],
  };
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({
        json: {
          controlsVersion: 1,
          plugins: [{ id: 'pcb-thermal@openpe', installed: true, enabled: true }],
          actions: [],
          updatedAt: Date.now(),
        },
      });
    if (url.pathname === '/api/thermal/status') {
      if (holdStatus) {
        heldStatus = route;
        return;
      }
      return route.fulfill({
        json: { available: true, gmsh: 'fixture Gmsh', elmer: 'fixture Elmer', diagnostic: '' },
      });
    }
    if (url.pathname === '/api/thermal/result') {
      resultRequests++;
      assert.equal(
        await page.locator('[data-saved-result-loading="reading"]').isVisible(),
        true,
        'Thermal loading UI paints before the restore request.',
      );
      assert.equal(route.request().postDataJSON().fileId, '00000000-0000-4000-8000-000000000001');
      if (holdResult) {
        heldResults.push(route);
        return;
      }
      return route.fulfill({ json: saved ?? { result: null } });
    }
    if (url.pathname === '/api/thermal/spice-sources') {
      spiceRequests++;
      const payload = route.request().postDataJSON();
      assert.equal(payload.source, originalSource);
      assert.equal(payload.fileId, '00000000-0000-4000-8000-000000000001');
      if (holdSpice) {
        heldSpice.push(route);
        return;
      }
      return route.fulfill({ json: spiceSources });
    }
    if (url.pathname === '/api/thermal/run') {
      requests++;
      const payload = route.request().postDataJSON();
      if (requests === 1)
        assert.equal(payload.config.meshSizeMm, 1, 'Run submits the selected mesh resolution.');
      assert.equal(route.request().headers()['x-openpe-token'], 'thermal-test');
      assert.equal(payload.fileId, '00000000-0000-4000-8000-000000000001');
      assert.equal(
        payload.config.heatSources.find((item) => item.footprintId === project.pcb.footprints[0].id)
          ?.powerW,
        payload.config.spiceSource ? importedPower : 1,
      );
      if (hold) {
        held.push(route);
        return;
      }
      const basis = prepareThermalModel(project.pcb, payload.config).basis;
      const a = payload.config.ambientC;
      const points = [
        { x: 0, y: 0, z: 0.8, temperatureC: a + 5 },
        { x: 20, y: 0, z: 0.8, temperatureC: a + 20 },
        { x: 20, y: 20, z: 0.8, temperatureC: a + 30 },
        { x: 0, y: 20, z: 0.8, temperatureC: a + 10 },
        { x: 0, y: 0, z: -0.8, temperatureC: a + 4 },
        { x: 20, y: 0, z: -0.8, temperatureC: a + 18 },
        { x: 20, y: 20, z: -0.8, temperatureC: a + 25 },
        { x: 0, y: 20, z: -0.8, temperatureC: a + 9 },
      ];
      saved = {
        config: payload.config,
        result: {
          version: 1,
          status: 'completed',
          basis,
          solver: { gmsh: 'fixture Gmsh', elmer: 'fixture Elmer' },
          points,
          triangles: [
            [0, 1, 2],
            [0, 2, 3],
            [4, 5, 6],
            [4, 6, 7],
          ],
          statistics: {
            minC: a + 4,
            maxC: a + 30,
            meanC: points.reduce((sum, p) => sum + p.temperatureC, 0) / points.length,
            inputPowerW: payload.config.spiceSource ? importedPower : 1,
            outputPowerW: payload.config.spiceSource ? importedPower : 1,
            energyImbalanceRelative: 0,
            nodeCount: 8,
            elementCount: 6,
          },
          assumptions: ['Controlled renderer fixture, not a solver validation.'],
          diagnostics: [],
        },
      };
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
  await page.addStyleTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.css')).text,
  });
  const initialLookup = page.waitForResponse((response) =>
    response.url().endsWith('/thermal/result'),
  );
  await page.addScriptTag({
    type: 'module',
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const panel = page.getByRole('region', { name: 'Layout Thermal', exact: true });
  await panel.waitFor();
  await page.getByRole('button', { name: 'Run', exact: true }).waitFor();
  await page.waitForFunction(
    () => window.thermalTest?.host.catalog().find((entry) => entry.id === 'thermal.run')?.available,
  );
  assert.equal(requests, 0, 'Opening Thermal never runs a solver.');
  await initialLookup;
  assert.ok(resultRequests >= 1, 'Saved projects load previous results.');
  const resolution = page.getByRole('combobox', { name: 'Mesh resolution', exact: true });
  const meshSize = page.getByRole('textbox', { name: 'Mesh size (mm)', exact: true });
  assert.equal(await resolution.innerText(), 'Standard · 2 mm');
  await resolution.click();
  const popup = page.getByRole('listbox', { name: 'Mesh resolution', exact: true });
  const triggerBox = await resolution.boundingBox();
  const popupBox = await popup.boundingBox();
  assert.ok(Math.abs(triggerBox.width - popupBox.width) < 2, 'Mesh popup matches field width.');
  await page.screenshot({ path: 'test-results/thermal-mesh-settings-ui.png' });
  await page.getByRole('option', { name: 'Fine · 1 mm', exact: true }).click();
  await waitForAsync(
    page,
    async () => (await window.thermalTest.host.query('thermal.status')).settings?.meshSizeMm === 1,
  );
  assert.equal(await meshSize.inputValue(), '1');
  assert.equal(requests, 0, 'Selecting mesh resolution does not run a solver.');
  await meshSize.fill('0.75');
  await meshSize.blur();
  await waitForAsync(
    page,
    async () =>
      (await window.thermalTest.host.query('thermal.status')).settings?.meshSizeMm === 0.75,
  );
  assert.equal(await resolution.innerText(), 'Custom');
  await page.evaluate(() =>
    window.thermalTest.host.execute('thermal.configure', {
      config: { meshSizeMm: 0.5 },
    }),
  );
  assert.equal(await resolution.innerText(), 'Very fine · 0.5 mm');
  await resolution.focus();
  await resolution.press('ArrowDown');
  await resolution.press('Home');
  await resolution.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await meshSize.inputValue(), '0.5', 'IME Enter does not select a mesh preset.');
  await resolution.press('Escape');
  await page.evaluate(() => window.thermalTest.setPending(true));
  await waitForAsync(
    page,
    () => document.querySelector('[aria-label="Mesh resolution"]')?.disabled,
  );
  await page.evaluate(() => window.thermalTest.setPending(false));
  await waitForAsync(
    page,
    () => !document.querySelector('[aria-label="Mesh resolution"]')?.disabled,
  );
  await page.evaluate(() =>
    window.thermalTest.host.execute('thermal.configure', {
      config: { meshSizeMm: 1 },
    }),
  );
  const heatInput = page.getByRole('combobox', { name: 'Thermal heat input', exact: true });
  async function chooseHeatInput(value) {
    await heatInput.scrollIntoViewIfNeeded();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await heatInput.press('ArrowDown');
    await heatInput.press(value === 'manual' ? 'Home' : 'End');
    await heatInput.press('Enter');
  }
  assert.equal(await heatInput.innerText(), 'SPICE');
  assert.equal(spiceRequests, 0, 'Opening Thermal does not import or solve automatically.');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await waitForAsync(
    page,
    async () => !!(await window.thermalTest.host.query('thermal.status')).settings?.spiceSource,
  );
  await panel.getByRole('img', { name: /board temperature map/ }).waitFor();
  assert.equal(spiceRequests, 1, 'Default Run imports verified current SPICE heat sources.');
  assert.equal(requests, 1, 'Default Run starts Thermal after importing verified power.');
  assert.equal(
    await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).inputValue(),
    '3.75',
  );
  assert.equal(
    await page
      .getByRole('combobox', { name: 'U1 (W) unit', exact: true })
      .getAttribute('aria-description'),
    'mW',
    'SPICE import updates the initially zero-W control to a readable power unit.',
  );
  assert.equal(await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).isDisabled(), true);
  assert.match(
    await panel.getByText('Heat input', { exact: true }).getAttribute('aria-description'),
    /8 to 10 ms.*original sampling resolution/,
  );
  await page.screenshot({ path: 'test-results/thermal-spice-ui.png' });
  await panel.locator('.simulation-components').screenshot({
    path: 'test-results/thermal-component-power-units.png',
  });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await panel.getByRole('img', { name: /board temperature map/ }).waitFor();
  assert.equal(
    spiceRequests,
    2,
    'Every SPICE-powered run revalidates the completed electrical record.',
  );
  assert.equal(
    saved.config.heatSources[0].powerW,
    importedPower,
    'Run preserves unrounded imported power.',
  );
  assert.equal(saved.config.spiceSource.resultBasis, spiceSources.spiceSource.resultBasis);
  await chooseHeatInput('manual');
  await waitForAsync(
    page,
    async () => !(await window.thermalTest.host.query('thermal.status')).settings?.spiceSource,
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).isDisabled(),
    false,
    'Manual keeps the imported watts editable and clears electrical provenance.',
  );
  await chooseHeatInput('spice');
  await page.getByRole('button', { name: 'Load SPICE heat sources', exact: true }).click();
  await waitForAsync(
    page,
    async () => !!(await window.thermalTest.host.query('thermal.status')).settings?.spiceSource,
  );
  holdSpice = true;
  const pendingSpice = page.waitForRequest((request) =>
    request.url().endsWith('/thermal/spice-sources'),
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await pendingSpice;
  const beforeCancelledImport = requests;
  await page.evaluate(() => window.thermalTest.setSpiceAvailable(false));
  await page.waitForFunction(() => window.spiceHeatAborts >= 1);
  holdSpice = false;
  for (const route of heldSpice.splice(0))
    await route
      .fulfill({
        json: {
          ...spiceSources,
          spiceSource: { ...spiceSources.spiceSource, resultBasis: 'b'.repeat(64) },
        },
      })
      .catch(() => {});
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    (await page.evaluate(() => window.thermalTest.host.query('thermal.status'))).settings
      .spiceSource.resultBasis,
    spiceSources.spiceSource.resultBasis,
    'Disabled SPICE discards late imports.',
  );
  assert.equal(await page.getByRole('button', { name: 'Run', exact: true }).isDisabled(), true);
  assert.equal(
    requests,
    beforeCancelledImport,
    'Plugin disable during automatic import cannot start Thermal with old powers.',
  );
  await chooseHeatInput('manual');
  await page.evaluate(() => window.thermalTest.setSpiceAvailable(true));
  assert.equal(
    await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).isDisabled(),
    false,
  );
  assert.equal(
    await page.evaluate(() => window.thermalTest.source()),
    originalSource,
    'SPICE heat import remains outside design data.',
  );
  await page.getByRole('combobox', { name: 'U1 (W) unit', exact: true }).click();
  await page.getByRole('option', { name: 'W', exact: true }).click();
  await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).fill('1');
  await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).blur();
  await page.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).fill('40');
  await page.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).blur();
  assert.equal(
    (await page.evaluate(() => window.thermalTest.host.query('thermal.status'))).settings.ambientC,
    40,
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const map = panel.getByRole('img', { name: /board temperature map/ });
  await map.waitFor();
  assert.equal(
    await map.locator('[data-thermal-field]').getAttribute('data-thermal-surface'),
    'front',
  );
  assert.match(
    await map.locator('[data-thermal-raster]').getAttribute('href'),
    /^data:image\/png;base64,/,
    'Cloud paints the bounded native surface mesh.',
  );
  assert.match(await map.getAttribute('aria-label'), /70\.00 °C/);
  const box = await map.boundingBox();
  await map.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await waitForAsync(
    page,
    async () => !!(await window.thermalTest.host.query('thermal.status')).probe,
  );
  const state = await page.evaluate(() => window.thermalTest.host.query('thermal.status'));
  assert.equal(state.result.temperature, 'board');
  assert.equal(state.result.points, undefined, 'Agent status never exposes the full mesh.');
  assert.equal(state.result.hottest.temperatureC, 70);
  assert.ok([0, 1, 2, 3].includes(state.probe.node));
  assert.equal(
    await page.getByRole('button', { name: 'Export temperature map', exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.thermalTest.host.execute('thermal.exportImage'));
  await page.waitForFunction(() => window.thermalExports.length === 1);
  assert.equal(
    await page.evaluate(() =>
      window.thermalExports[0].dataUrl.startsWith('data:image/png;base64,'),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => window.thermalTest.source()),
    originalSource,
    'Thermal settings, results, probes and export never change project content.',
  );
  await page.screenshot({ path: 'test-results/thermal-ui.png' });

  assert.doesNotMatch(await panel.locator('header').innerText(), /Completed/);
  const completedRuns = requests;
  assert.equal(await page.locator('[data-saved-result-loading]').count(), 0);
  await page.evaluate(() => window.thermalTest.remount());
  await map.waitFor();
  assert.equal(requests, completedRuns, 'Restoring a result never starts a solver.');
  assert.equal(
    await resolution.innerText(),
    'Fine · 1 mm',
    'Saved mesh settings restore the preset.',
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).inputValue(),
    '40',
  );
  assert.equal(await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).inputValue(), '1');
  assert.match(await map.getAttribute('aria-label'), /70\.00 °C/);

  holdResult = true;
  const pendingLookup = page.waitForRequest((request) => request.url().endsWith('/thermal/result'));
  await page.evaluate(() => window.thermalTest.remount());
  await pendingLookup;
  await panel
    .locator('footer')
    .getByRole('progressbar', { name: 'Loading saved thermal results…', exact: true })
    .waitFor();
  const loadingBox = await page.locator('[data-saved-result-loading]').boundingBox();
  const runBox = await page.getByRole('button', { name: 'Run', exact: true }).boundingBox();
  assert.ok(loadingBox.x + loadingBox.width <= runBox.x, 'Thermal progress sits left of Run.');
  assert.ok(
    Math.abs(loadingBox.y + loadingBox.height / 2 - runBox.y - runBox.height / 2) < 2,
    'Thermal progress shares the Run row.',
  );
  await page.screenshot({ path: 'test-results/thermal-loading-saved.png' });
  await page.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).fill('55');
  await page.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).blur();
  assert.ok(heldResults.length);
  holdResult = false;
  for (const route of heldResults.splice(0)) await route.fulfill({ json: saved }).catch(() => {});
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await map.count(),
    0,
    'A stale lookup cannot restore a field after a settings edit.',
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).inputValue(),
    '55',
  );
  assert.equal(
    await page.locator('[data-saved-result-loading]').count(),
    0,
    'Editing cancels loading feedback together with its stale lookup.',
  );
  assert.ok((await page.evaluate(() => window.thermalResultStages)).includes('preparing'));
  await chooseHeatInput('manual');
  await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).fill('1');
  await page.getByRole('textbox', { name: 'U1 (W)', exact: true }).blur();
  await page.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).fill('40');
  await page.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).blur();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await map.waitFor();

  holdStatus = true;
  await page.getByRole('button', { name: 'Close Layout Thermal', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  await page.evaluate(() => window.thermalTest.setVisible(true));
  await waitForAsync(
    page,
    async () => (await window.thermalTest.host.query('thermal.status')).status === 'detecting',
  );
  const detectionRun = await page.evaluate(() =>
    window.thermalTest.host.execute('thermal.run').then(
      () => 'unexpected run',
      (error) => error.message,
    ),
  );
  assert.match(detectionRun, /detection is still running/);
  assert.equal(requests, completedRuns + 1, 'A pending solver recheck cannot race an Agent run.');
  assert.equal(
    (await page.evaluate(() => window.thermalTest.host.query('thermal.status'))).result.hottest
      .temperatureC,
    70,
    'Automatic solver detection on reopening preserves the completed field.',
  );
  assert.ok(heldStatus);
  holdStatus = false;
  await heldStatus.fulfill({
    json: { available: true, gmsh: 'fixture Gmsh', elmer: 'fixture Elmer' },
  });
  await waitForAsync(
    page,
    async () => (await window.thermalTest.host.query('thermal.status')).status === 'completed',
  );

  hold = true;
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await waitForAsync(
    page,
    async () => (await window.thermalTest.host.query('thermal.status')).status === 'running',
  );
  assert.equal(await resolution.isDisabled(), true, 'Mesh settings are locked during a run.');
  await page.evaluate(() => window.thermalTest.setPending(true));
  await page.waitForFunction(() => window.thermalAborts >= 1);
  assert.equal(await map.count(), 0, 'Pending Source clears old board-temperature evidence.');
  assert.equal(
    (await page.evaluate(() => window.thermalTest.host.query('thermal.status'))).result,
    null,
  );
  await page.evaluate(() => window.thermalTest.setPending(false));
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await waitForAsync(
    page,
    async () => (await window.thermalTest.host.query('thermal.status')).status === 'running',
  );
  await page.evaluate(() => window.thermalTest.setVisible(false));
  await page.waitForFunction(() => window.thermalAborts >= 2);
  await panel.waitFor({ state: 'detached' });
  await page.evaluate(() => window.thermalTest.setVisible(true));
  await panel.waitFor();
  await page.waitForFunction(
    () => window.thermalTest.host.catalog().find((entry) => entry.id === 'thermal.run')?.available,
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await waitForAsync(
    page,
    async () => (await window.thermalTest.host.query('thermal.status')).status === 'running',
  );
  await page.evaluate(() => window.thermalTest.host.suspend('The project is closing.'));
  await page.waitForFunction(() => window.thermalAborts >= 3);
  await page.evaluate(() => {
    window.thermalTest.host.resume();
    window.thermalTest.setVisible(false);
  });
  await panel.waitFor({ state: 'detached' });
  for (const route of held) await route.abort().catch(() => {});
  assert.deepEqual(errors, []);
  console.log(
    'Thermal UI: manual/SPICE heat inputs, exact imported powers, stale import cancellation, native mesh map/probe, PNG, saved-result/settings restoration, read-only project and cancellation passed.',
  );
  console.log(
    'Screenshot: test-results/thermal-ui.png (mocked renderer data; real solver validation is separate).',
  );
} finally {
  await browser.close();
}
