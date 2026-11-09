import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { projectFromNativeFiles, serializeProject } from '../server/project-format.mjs';

// Isolated browser with the actual native project and real Core; no Electron or solver.
const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const source = serializeProject(
  projectFromNativeFiles(await readNativeProject('project/emc-flyback/emc-flyback.kicad_pro')),
);
const bundle = await build({
  stdin: {
    contents: `
    import React,{useState,useSyncExternalStore} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ProjectCore} from './core/project-core';
    import {parseProject} from './lib/project';
    import {partFields} from './lib/library';
    import {defaultSchematicLayers} from './lib/schematic-layers';
    import {buildSpiceDeck,defaultTransient} from './lib/spice';
    import SchematicDrawing from './components/SchematicDrawing';
    import PartProperties from './components/PartProperties';
    const core=new ProjectCore(parseProject(window.testbenchSource));
    const refs=['V1','R21','V2','R22','I1'];
    function Fixture(){
      const snapshot=useSyncExternalStore(core.subscribe,core.getSnapshot);
      const [selected,setSelected]=useState('V1');
      const drawing=snapshot.project.schematic,part=drawing.parts.find(p=>p.ref===selected);
      window.testbenchState={fields:partFields(part),netlist:buildSpiceDeck(drawing,defaultTransient(drawing)).netlist};
      return <><svg className="bench" viewBox="5 -36 405 244"><SchematicDrawing drawing={drawing} libraries={drawing.libraries}
        junctions={drawing.junctions} selection={[]} layers={defaultSchematicLayers} hitPadding={0.5}
        offset={()=>({x:0,y:0})} onPointerDown={()=>{}} onPinPointerDown={()=>{}}/></svg>
        <nav>{refs.map(ref=><button key={ref} onClick={()=>setSelected(ref)}>Inspect {ref}</button>)}</nav>
        <div className="panel"><PartProperties part={part} circuit={drawing} spiceAvailable={true}
          onSave={(reference,value,fields)=>{core.execute('part.properties',{schematicId:drawing.id,partId:part.id,reference,value,
            fields:Object.entries(fields).map(([name,value])=>({name,value}))});return true;}}/></div></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((source) => {
    window.testbenchSource = source;
  }, source);
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'body{padding:12px}.bench{width:100%;height:850px;background:#fbfbfa;--symbol:#854d0e;--wire:#007106;--symbol-fill:#faf5e5}nav{display:flex;gap:12px}.panel{width:340px;padding:12px}.bench text{font-family:Arial,sans-serif}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const ref of ['V1', 'R21', 'V2', 'R22', 'I1'])
    assert.equal(
      await page.getByTestId(`part-${ref}`).locator('[data-symbol-role="virtual"]').count(),
      1,
    );
  const open = async (ref) => {
    await page.getByRole('button', { name: `Inspect ${ref}`, exact: true }).click();
    const spice = page.getByRole('tab', { name: 'SPICE', exact: true });
    if ((await spice.getAttribute('aria-selected')) !== 'true') await spice.click();
  };
  await open('I1');
  assert.equal(
    Number(await page.getByLabel('Initial current (A)', { exact: true }).inputValue()),
    500,
  );
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Initial current (A) unit', exact: true })
      .textContent(),
    'mA',
  );
  assert.equal(
    Number(await page.getByLabel('Pulsed current (A)', { exact: true }).inputValue()),
    0,
  );
  await mkdir('test-results', { recursive: true });
  const text = await page.locator('svg.bench').textContent();
  assert.match(text, /SIMULATION TESTBENCH \(virtual\)/);
  assert.doesNotMatch(text, /7\. DATASHEETS/);
  await page
    .locator('svg.bench')
    .screenshot({ path: 'test-results/emc-flyback-testbench.png', animations: 'disabled' });
  for (const [ref, label, value, expected] of [
    ['V1', 'Voltage (V)', '30', '^V1 \\w+ 0 DC 30$'],
    ['V2', 'Voltage (V)', '13', '^V2 \\w+ 0 DC 13$'],
    ['I1', 'Initial current (A)', '750', '^I1 \\w+ 0 PULSE\\(0\\.75 '],
  ]) {
    await open(ref);
    const field = page.getByLabel(label, { exact: true });
    await field.fill(value);
    await field.press('Enter');
    await page.waitForFunction(
      (expected) => new RegExp(expected, 'm').test(window.testbenchState.netlist),
      expected,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    'Actual native EMC virtual testbench rendering, explicit source/load connectivity and current/voltage Properties edits passed.',
  );
} finally {
  await browser.close();
}
