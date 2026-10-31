// Isolated renderer checks: no Electron, services or native design writes.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import QuantityInput from './components/QuantityInput';
      import {NumberField} from './components/LayoutPropertyFields';
      import AnalysisComponents from './components/AnalysisComponents';
      function App(){const [values,setValues]=useState({time:'0.000438592396388',temperature:'25',voltage:'12',power:'0.025',conductivity:'400'});const [length,setLength]=useState(25.4);
      window.quantityValues=values;window.quantityLength=length;window.quantityCommits??=0;window.quantityChanges??=0;
      return <main><h2>Engineering values</h2>{[['time','Delay','s'],['voltage','Voltage','V'],['power','Power','W'],['temperature','Ambient','°C'],['conductivity','Conductivity','W/m·K']].map(([key,label,unit])=><label className="demo-field" key={key}><span>{label}</span><QuantityInput aria-label={label} unit={unit} value={values[key]} autoScale={key==='time'||key==='power'} onValueChange={value=>{window.quantityChanges++;setValues(previous=>({...previous,[key]:value}));}}/></label>)}
      <NumberField label="Length (mm)" value={length} onCommit={value=>{window.quantityCommits++;setLength(value);return true;}}/>
      <button>Done</button><div className="power-panel"><AnalysisComponents visible items={[{id:'C1',reference:'C1'},{id:'C2',reference:'C2'}]} locateDescription="Locate footprint" onLocate={()=>true} renderControl={item=><QuantityInput aria-label={item.reference+' power'} unit="W" value="0" onValueChange={()=>{}}/>}/></div></main>};createRoot(document.getElementById('root')).render(<App/>);`,
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
  const page = await browser.newPage({ viewport: { width: 540, height: 650 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'body{padding:24px;background:var(--panel);color:var(--text)}main{padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}h2{font-size:16px;margin-bottom:16px}.demo-field,.layout-field{display:grid;grid-template-columns:140px minmax(0,1fr);gap:12px;align-items:center;margin:10px 0}.demo-field>span:first-child,.layout-field>span:first-child{color:var(--muted)}main>button{margin-top:12px;padding:6px 12px;background:var(--tint);border-radius:8px}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.addStyleTag({
    content:
      '.power-panel{width:276px;max-width:100%;margin-top:12px}.power-panel .simulation-components{margin-top:0}',
  });
  const delay = page.getByRole('textbox', { name: 'Delay', exact: true });
  await delay.waitFor();
  assert.equal(await delay.inputValue(), '438.59');
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Delay unit', exact: true })
      .getAttribute('aria-description'),
    'µs',
  );
  await mkdir('test-results', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.screenshot({
      path: `test-results/quantity-input-${theme}.png`,
      animations: 'disabled',
    });
  }
  for (const reference of ['C1', 'C2']) {
    const power = page.getByRole('textbox', { name: reference + ' power', exact: true });
    assert.equal(await power.inputValue(), '0');
    assert.ok(
      (await power.boundingBox()).width >= 36,
      'Two-column component power keeps a usable numeric input.',
    );
    const control = power.locator('..');
    assert.ok(await control.getByRole('combobox').isVisible());
    assert.equal(
      await power
        .locator('..')
        .locator('..')
        .evaluate((el) => getComputedStyle(el).borderTopWidth),
      '0px',
    );
  }
  async function choose(label, unit) {
    await page.getByRole('combobox', { name: label + ' unit', exact: true }).click();
    await page.getByRole('option', { name: unit, exact: true }).click();
  }
  await choose('Delay', 'ms');
  assert.equal(await delay.inputValue(), '0.43859');
  assert.equal(await page.evaluate(() => window.quantityChanges), 0);
  assert.equal(await page.evaluate(() => window.quantityValues.time), '0.000438592396388');
  await choose('Ambient', 'K');
  assert.equal(
    await page.getByRole('textbox', { name: 'Ambient', exact: true }).inputValue(),
    '298.15',
  );
  assert.equal(await page.evaluate(() => window.quantityValues.temperature), '25');
  await page.getByRole('textbox', { name: 'Ambient', exact: true }).fill('300');
  assert.ok(
    Math.abs(Number(await page.evaluate(() => window.quantityValues.temperature)) - 26.85) < 1e-10,
  );
  const length = page.getByRole('spinbutton', { name: 'Length (mm)', exact: true });
  await length.focus();
  await choose('Length (mm)', 'in');
  assert.equal(await length.inputValue(), '1');
  assert.equal(
    await page.evaluate(() => window.quantityCommits),
    0,
    'Unit selection cannot commit a native edit.',
  );
  await length.fill('2');
  await length.press('Enter');
  assert.equal(await page.evaluate(() => window.quantityLength), 50.8);
  assert.equal(await page.evaluate(() => window.quantityCommits), 1);
  await length.fill('3');
  await length.press('Escape');
  assert.equal(await length.inputValue(), '2');
  assert.equal(await page.evaluate(() => window.quantityCommits), 1);
  const voltage = page.getByRole('textbox', { name: 'Voltage', exact: true });
  await voltage.fill('-');
  await choose('Voltage', 'mV');
  assert.equal(await voltage.inputValue(), '-', 'Invalid drafts survive display-unit changes.');
  await voltage.fill('2500');
  assert.equal(await page.evaluate(() => window.quantityValues.voltage), '2.5');
  await voltage.dispatchEvent('compositionstart');
  await page.getByRole('combobox', { name: 'Voltage unit', exact: true }).click();
  assert.equal(await page.getByRole('listbox').count(), 0, 'IME cannot open a unit menu.');
  await voltage.dispatchEvent('compositionend');
  const menu = page.getByRole('combobox', { name: 'Voltage unit', exact: true });
  await menu.focus();
  await menu.press('ArrowDown');
  await menu.press('Escape');
  assert.equal(await page.getByRole('listbox').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'Quantity input: compatible units, exact no-op display changes, temperature conversion, commit/Escape drafts, compact power fields, invalid input, keyboard and IME checks passed.',
  );
} finally {
  await browser.close();
}
