// Isolated renderer QA; no Electron launch, recovery writes or real solver.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import manifest from '../resources/example-catalog/manifest.json' with { type: 'json' };
import { parseProject } from '../server/project-format.mjs';
import { buildSpiceDeck } from '../plugins/spice-simulation/host/spice-format.mjs';
import { simulationModelDefinitions } from '../server/simulation-model-format.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
const bundle = await build({
  stdin: {
    contents: `
import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
import SimulationDialog from './plugins/spice-simulation/renderer/SimulationDialog';import SymbolGraphic from './components/SymbolGraphic';
import {createReferenceExample} from './lib/reference-examples';
import {serializeProject} from './lib/project';
import {loadWorkbenchPlugins} from './lib/workbench-plugins';
function App(){const [project,setProject]=useState(createReferenceExample('reference-lm2596-to220-5-buck'));const [probe,setProbe]=useState(null);const host=useRef(null),wave=useRef(null);
window.projectSource=serializeProject(project);
window.chooseExample=id=>{setProbe(null);setProject(createReferenceExample(id));};
window.prepareModelReferenceRun=()=>{const p=createReferenceExample('reference-lm2596-to220-5-buck');delete p.simulationModels;setProject(p);setProbe({kind:'voltage',id:p.schematic.labels.find(label=>label.text==='VOUT').id});};
const specimens=[['reference-lm2598-to220-7-buck','V1'],['reference-lm2598-to220-7-buck','V1',true],['reference-lm2596-to220-5-buck','V1']];
return <><div ref={host} className="simulation-settings-host" style={{width:280,height:720}}/><div ref={wave}/>
<SimulationDialog project={project} fileId="00000000-0000-4000-8000-000000000001" visible sourcePending={false} probe={probe} settingsHost={host} waveformHost={wave} onWaveformVisibilityChange={()=>{}} onStoreModels={(models,expectedSource)=>{if(expectedSource!==serializeProject(project))return false;window.storedModelReferences=models;setProject({...project,simulationModels:models});return true;}}/>
<div id="source-specimens" style={{position:'absolute',left:320,top:40,width:760,background:'white',padding:20}}><h2>Voltage source symbols</h2>
{specimens.map(([id,ref,pulse])=>{const d=createReferenceExample(id).schematic,p=d.parts.find(p=>p.ref===ref);if(pulse)p.fields={...p.fields,'Sim.Type':'PULSE','OpenPE.SourceType':'PULSE','Sim.Params':'y1=0 y2=15 td=20n tr=20n tf=20n tw=25u per=50u'};return <div key={id+ref+!!pulse} style={{display:'flex'}}>{[0,90,180,270].map(angle=><svg key={angle} width="170" height="160" viewBox="-7 -7 14 14"><g transform={'rotate('+(-angle)+')'}><SymbolGraphic library={d.libraries[p.libId]} part={p} orientation={{rotation:angle}} showPinNames={false} showPinNumbers={false}/></g></svg>)}</div>})}</div></>}
loadWorkbenchPlugins().then(()=>createRoot(document.getElementById('root')).render(<App/>));`,
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
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
  });
  let simulationRequests = 0;
  let convergenceFixture = false;
  let convergenceRequests = 0;
  await page.route('http://localhost/**', async (route) => {
    if (route.request().url().endsWith('/api/workbench-plugins'))
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (route.request().url().endsWith('/api/simulation/status'))
      return route.fulfill({ json: { available: true, version: 'UI fixture' } });
    if (route.request().url().endsWith('/api/simulation/result'))
      return route.fulfill({ json: { result: null } });
    if (route.request().url().endsWith('/api/simulation/transient')) {
      simulationRequests++;
      const payload = route.request().postDataJSON();
      assert.equal(payload.fileId, '00000000-0000-4000-8000-000000000001');
      const project = parseProject(payload.source);
      assert.ok(Array.isArray(project.simulationModels) || project.simulationModels === undefined);
      const deck = buildSpiceDeck(project.schematic, payload.config);
      if (convergenceFixture && deck.stop === 0.02) {
        convergenceRequests++;
        const message =
          'The solver could not converge at 1.76724 ms. Try a shorter duration or review the circuit and model.';
        if (convergenceRequests > 1)
          return route.fulfill({
            status: 422,
            json: { error: message, code: 'OPENPE_SPICE_CONVERGENCE' },
          });
        return route.fulfill({
          contentType: 'text/event-stream',
          body: `data: ${JSON.stringify({ type: 'error', code: 'OPENPE_SPICE_CONVERGENCE', message: 'The solver could not converge at 1.76724 ms. Try a shorter duration or review the circuit and model.' })}\n\n`,
        });
      }
      const ids = new Set([...(deck.modelIds ?? []), ...(deck.modelId ? [deck.modelId] : [])]);
      return route.fulfill({
        json: {
          version: 'UI fixture',
          log: 'Controlled fixture, not real solver output.',
          time: Array.from({ length: 11 }, (_, i) => (deck.stop * i) / 10),
          traces: deck.traces.map((trace) => ({
            ...trace,
            values: Array.from({ length: 11 }, (_, i) => i / 2),
          })),
          simulationModels: simulationModelDefinitions.filter((model) => ids.has(model.id)),
        },
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<div id="root"></div><style>${css}</style><script>${bundle.outputFiles[0].text}</script>`,
    });
  });
  await page.goto('http://localhost/');
  await page.waitForFunction(() => typeof window.chooseExample === 'function');
  for (const entry of manifest.examples) {
    await page.evaluate((id) => window.chooseExample(id), entry.id);
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === 'Run',
      );
      return b && !b.disabled;
    });
    assert.equal(await page.getByRole('alert').count(), 0, entry.id);
    assert.equal(await page.locator('input').count(), 2, entry.id);
    if (entry.id.startsWith('reference-')) {
      assert.equal(
        await page.getByRole('textbox', { name: 'Duration (ms)', exact: true }).inputValue(),
        ['reference-lm27761-wson8-pump', 'reference-tps61046-bga6-boost'].includes(entry.id) ? '2' : '10',
        `${entry.id}: Home duration matches the real-solver verification window.`,
      );
      assert.equal(
        await page.getByRole('textbox', { name: 'Max. time step (µs)', exact: true }).inputValue(),
        entry.id === 'reference-lm5001-soic8-boost' ? '0.01' : '0.2',
        `${entry.id}: Home maximum step matches its verified profile.`,
      );
    }
  }
  assert.equal(await page.locator('[data-source-mark="voltage"]').count(), 12);
  await page.evaluate(() => window.prepareModelReferenceRun());
  await page.waitForFunction(() => !JSON.parse(window.projectSource).simulationModels);
  const duration = page.getByRole('textbox', { name: 'Duration (ms)', exact: true });
  const step = page.getByRole('textbox', { name: 'Max. time step (µs)', exact: true });
  await duration.fill('10');
  await step.fill('0.5');
  await page.getByRole('alert').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Run', exact: true }).click({ trial: true });
  await step.fill('0');
  await page.getByRole('alert').filter({ hasText: 'greater than 0 µs' }).waitFor();
  await step.fill('0.5');
  await duration.fill('0');
  await page.getByRole('alert').filter({ hasText: 'greater than 0 ms' }).waitFor();
  await duration.fill('30');
  await page.getByRole('alert').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForFunction(() => window.storedModelReferences?.length === 1);
  await page.getByRole('group', { name: 'Waveform controls' }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  const saved = JSON.parse(await page.evaluate(() => window.projectSource));
  assert.deepEqual(saved.simulationModels, [
    simulationModelDefinitions.find((model) => model.id === 'lm2596-5'),
  ]);
  assert.equal(
    await page.locator('.simulation-waveform').count(),
    1,
    'Adding model references preserves the completed probed waveform.',
  );
  await mkdir('test-results', { recursive: true });
  await page
    .locator('#source-specimens')
    .screenshot({ path: 'test-results/voltage-source-symbols.png' });
  convergenceFixture = true;
  await page.evaluate(() => window.chooseExample('reference-lm2735-msop8-sepic'));
  await page.waitForFunction(() =>
    JSON.parse(window.projectSource).project.name.includes('LM2735'),
  );
  const before = await page.evaluate(() => window.projectSource);
  await duration.fill('20');
  await step.fill('0.2');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'could not converge at 1.76724 ms' }).waitFor();
  assert.equal(
    await duration.inputValue(),
    '20',
    'A failure never silently shortens the requested run.',
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'could not converge at 1.76724 ms' }).waitFor();
  await page
    .getByRole('button', { name: 'Use default timing (10 ms, 0.2 µs)', exact: true })
    .waitFor();
  await page.screenshot({ path: 'test-results/lm2735-convergence-recovery.png' });
  const requests = simulationRequests;
  await page
    .getByRole('button', { name: 'Use default timing (10 ms, 0.2 µs)', exact: true })
    .click();
  assert.equal(await duration.inputValue(), '10');
  assert.equal(await step.inputValue(), '0.2');
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(
    simulationRequests,
    requests,
    'Restoring timing never launches a solver implicitly.',
  );
  assert.equal(
    await page.evaluate(() => window.projectSource),
    before,
    'Timing recovery leaves all design data unchanged.',
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.getAttribute('aria-label') === 'Run' && !b.disabled,
    ),
  );
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(simulationRequests, requests + 1);
  assert.equal(await page.evaluate(() => window.projectSource), before);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: nine Home setup panels, 12 voltage source orientations, model-reference storage and explicit convergence recovery without design changes or implicit runs.',
  );
} finally {
  await browser.close();
}
