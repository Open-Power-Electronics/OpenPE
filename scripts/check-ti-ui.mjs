import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createLibraryService } from '../server/libraries.mjs';

// Isolated browser components and read-only bundled libraries; no Electron/workspace recovery.
const service = createLibraryService({ dataDir: 'test-results/ti-ui-cache' });
const bundle = await build({
  stdin: {
    contents: `
import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import LibraryChooser from './components/LibraryChooser';
import SimulationDialog from './components/SimulationDialog';
import {createTiExample} from './lib/ti-examples';
function App(){
 const [project,setProject]=useState(null); window.inspectFixture=()=>{window.exampleId="Regulator_Switching:LM2596S-5";setProject(createTiExample(window.exampleId));}; const anchor=useRef(null); const host=useRef(null);
 return <><div ref={anchor} className="simulation-settings-host" style={{height:750,width:280}}/><div ref={host}/>{project ? <SimulationDialog project={project} visible sourcePending={false} probe={null} settingsHost={anchor} waveformHost={host} onWaveformVisibilityChange={()=>{}}/> : <LibraryChooser kind="symbols" initialLibrary="ti-dcdc" onClose={()=>{}} onChoose={()=>{window.placed=true;}}/>}</>;
}
createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = (
  await Promise.all(['app/globals.css', 'app/workspace.css'].map((p) => readFile(p, 'utf8')))
).join('\n');
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1250, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/libraries/')) {
      try {
        return await route.fulfill({
          json: await service.request({
            action: 'detail',
            kind: url.pathname.split('/').at(-1),
            id: url.searchParams.get('id'),
          }),
        });
      } catch (e) {
        return await route.fulfill({ status: 422, json: { error: e.message } });
      }
    }
    if (url.pathname === '/api/library-model') {
      try {
        return await route.fulfill({
          json: await service.model(url.searchParams.get('id'), 0, new AbortController().signal),
        });
      } catch (e) {
        return await route.fulfill({ status: 422, json: { error: e.message } });
      }
    }
    if (url.pathname === '/api/simulation/status')
      return route.fulfill({ json: { available: true, version: 'UI fixture' } });
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: `<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
      });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('button', { name: 'Place', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open example', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Footprint', exact: true }).click();
  await page.locator('svg.footprint-preview').waitFor();
  await page.getByRole('button', { name: '3D model', exact: true }).click();
  await page.locator('.model-preview canvas').waitFor();
  await page.waitForFunction(() => !document.querySelector('.model-preview [role="status"]'));
  await mkdir('test-results/ti-validation', { recursive: true });
  await page.screenshot({ path: 'test-results/ti-validation/chooser.png' });
  await page.evaluate(() => window.inspectFixture());
  await page.getByRole('button', { name: 'Run', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Run', exact: true }).isEnabled(), true);
  assert.equal(await page.getByText('PWM frequency (kHz)', { exact: true }).count(), 0);
  assert.match(await page.evaluate(() => window.exampleId), /^Regulator_Switching:LM2596/);
  assert.equal(await page.locator('.simulation-error').count(), 0);
  await page.screenshot({ path: 'test-results/ti-validation/simulation.png' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: TI filter, official footprint/3D preview, internal fixture regulator simulation setup.',
  );
} finally {
  await browser.close();
  service.close();
}
