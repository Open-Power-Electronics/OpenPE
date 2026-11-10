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
      import FieldProperties from './components/FieldProperties';
      function App(){const [values,setValues]=useState({time:'0.000438592396388',temperature:'25',voltage:'12',power:'0.025',conductivity:'400'});const [length,setLength]=useState(25.4),[exact,setExact]=useState(25.41234567);
      const [fieldText,setFieldText]=useState('R1'),[fieldPosition,setFieldPosition]=useState({x:0,y:0}),[showField,setShowField]=useState(false);
      window.exactLength=exact;window.exactCommits??=0;
      window.quantityValues=values;window.quantityLength=length;window.quantityCommits??=0;window.quantityChanges??=0;
      window.voltageBlurCommits??=0;window.quantitySubmits??=0;
      window.fieldText=fieldText;window.fieldTextCommits??=0;window.fieldPosition=fieldPosition;window.fieldSaves??=0;
      window.showFieldProperties=()=>setShowField(true);
      window.setQuantityPower=value=>setValues(previous=>({...previous,power:value}));
      return <main><h2>Engineering values</h2><form onSubmit={event=>{event.preventDefault();window.quantitySubmits++;}}>{[['time','Delay','s'],['voltage','Voltage','V'],['power','Power','W'],['temperature','Ambient','°C'],['conductivity','Conductivity','W/m·K']].map(([key,label,unit])=><label className="demo-field" key={key}><span>{label}</span><QuantityInput aria-label={label} unit={unit} value={values[key]} autoScale={key==='time'||key==='power'} onBlur={key==='voltage'?()=>window.voltageBlurCommits++:undefined} onValueChange={value=>{window.quantityChanges++;setValues(previous=>({...previous,[key]:value}));}}/></label>)}<button type="submit" hidden/></form>
      <NumberField label="Length (mm)" value={length} onCommit={value=>{window.quantityCommits++;setLength(value);return true;}}/>
      <NumberField label="Exact length (mm)" value={exact} onCommit={value=>{window.exactCommits++;setExact(value);return true;}}/>
      <NumberField label="Loaded limit (mm)" value={20000.12345} min={0} max={1000} onCommit={()=>{throw Error('Untouched loaded values cannot commit')}}/>
      <button>Done</button><div className="power-panel"><AnalysisComponents visible items={[{id:'C1',reference:'C1'},{id:'C2',reference:'C2'}]} locateDescription="Locate footprint" onLocate={()=>true} renderControl={item=><QuantityInput aria-label={item.reference+' power'} unit="W" value="0" onValueChange={()=>{}}/>}/></div>
      {showField&&<FieldProperties field="Reference" text={fieldText} position={fieldPosition} onText={value=>{window.fieldTextCommits++;setFieldText(value);return true;}} onPosition={value=>{setFieldPosition(value);return true;}} onRequestSave={()=>window.fieldSaves++}/>}</main>};createRoot(document.getElementById('root')).render(<App/>);`,
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
  const power = page.getByRole('textbox', { name: 'Power', exact: true });
  const powerUnit = page.getByRole('combobox', { name: 'Power unit', exact: true });
  async function receivePower(value) {
    await page.evaluate(async (value) => {
      window.setQuantityPower(value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, value);
  }
  for (const [value, display, unit] of [
    ['0', '0', 'W'],
    ['0.003456', '3.456', 'mW'],
    ['0.0000023', '2.3', 'µW'],
    ['2500', '2.5', 'kW'],
    ['0.003456', '3.456', 'mW'],
  ]) {
    await receivePower(value);
    assert.equal(await power.inputValue(), display);
    assert.equal(await powerUnit.getAttribute('aria-description'), unit);
  }
  assert.equal(await page.evaluate(() => window.quantityChanges), 0);
  await power.fill('0.0023');
  assert.equal(await power.inputValue(), '0.0023');
  assert.equal(await powerUnit.getAttribute('aria-description'), 'mW', 'Typing holds the unit.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await power.inputValue(), '2.3');
  assert.equal(await powerUnit.getAttribute('aria-description'), 'µW');
  assert.equal(await page.evaluate(() => window.quantityValues.power), '0.0000023');
  await receivePower('0.003456');
  await power.fill('3.456789123');
  assert.equal(await power.inputValue(), '3.456789123');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await power.inputValue(), '3.4568');
  assert.equal(await page.evaluate(() => window.quantityValues.power), '0.003456789123');
  await power.focus();
  assert.equal(await power.inputValue(), '3.456789123', 'Refocusing restores the complete draft.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await receivePower('0.0000023');
  await power.fill('-');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await power.inputValue(), '-');
  assert.equal(await powerUnit.getAttribute('aria-description'), 'µW');
  await power.fill('');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await power.inputValue(), '');
  assert.equal(await powerUnit.getAttribute('aria-description'), 'µW');
  await receivePower('0.003456');
  await choose('Power', 'W');
  const changes = await page.evaluate(() => window.quantityChanges);
  await receivePower('0.0000023');
  assert.equal(
    await powerUnit.getAttribute('aria-description'),
    'W',
    'Manual units stay retained.',
  );
  assert.equal(await power.inputValue(), '0.0000023');
  assert.equal(await page.evaluate(() => window.quantityChanges), changes);
  await page.evaluate(() => {
    window.quantityChanges = 0;
  });
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
  assert.equal(await length.inputValue(), '1.00');
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
  assert.equal(await length.inputValue(), '2.00');
  assert.equal(await page.evaluate(() => window.quantityCommits), 1);
  const exact = page.getByRole('spinbutton', { name: 'Exact length (mm)', exact: true });
  assert.equal(await exact.inputValue(), '25.41');
  await exact.focus();
  await exact.press('Tab');
  await choose('Exact length (mm)', 'in');
  assert.equal(await exact.inputValue(), '1.00');
  await exact.focus();
  await exact.press('Tab');
  assert.equal(await page.evaluate(() => window.exactLength), 25.41234567);
  assert.equal(
    await page.evaluate(() => window.exactCommits),
    0,
    'Rounded display and unit changes preserve every untouched native digit.',
  );
  await exact.fill('1.234567');
  await exact.press('Enter');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await exact.inputValue(), '1.23');
  assert.ok(Math.abs((await page.evaluate(() => window.exactLength)) - 31.3580018) < 1e-10);
  assert.equal(await page.evaluate(() => window.exactCommits), 1);
  const loaded = page.getByRole('spinbutton', { name: 'Loaded limit (mm)', exact: true });
  assert.equal(await loaded.inputValue(), '20000.12');
  await loaded.focus();
  await loaded.press('Tab');
  assert.equal(await loaded.getAttribute('aria-invalid'), null);
  const voltage = page.getByRole('textbox', { name: 'Voltage', exact: true });
  await voltage.fill('-');
  await choose('Voltage', 'mV');
  assert.equal(await voltage.inputValue(), '-', 'Invalid drafts survive display-unit changes.');
  await voltage.fill('2500');
  assert.equal(await page.evaluate(() => window.quantityValues.voltage), '2.5');
  await voltage.dispatchEvent('compositionstart');
  await voltage.fill('3500');
  await voltage.press('Enter');
  assert.equal(
    await page.evaluate(() => window.quantitySubmits),
    0,
    'IME cannot submit a quantity form.',
  );
  await page.getByRole('combobox', { name: 'Voltage unit', exact: true }).click();
  assert.equal(await page.getByRole('listbox').count(), 0, 'IME cannot open a unit menu.');
  const voltageBlurCommits = await page.evaluate(() => window.voltageBlurCommits);
  const done = page.getByRole('button', { name: 'Done', exact: true });
  await done.focus();
  assert.equal(
    await page.evaluate(() => window.voltageBlurCommits),
    voltageBlurCommits,
    'Moving focus out of the quantity control cannot commit during composition.',
  );
  await voltage.focus();
  await voltage.dispatchEvent('compositionend');
  await done.focus();
  assert.equal(
    await page.evaluate(() => window.voltageBlurCommits),
    voltageBlurCommits + 1,
    'Moving focus out after composition restores ordinary blur validation.',
  );
  await choose('Voltage', 'V');
  assert.equal(await voltage.inputValue(), '3.5', 'Unit selection resumes after composition.');
  await voltage.press('Enter');
  assert.equal(await page.evaluate(() => window.quantitySubmits), 1);
  const menu = page.getByRole('combobox', { name: 'Voltage unit', exact: true });
  await menu.focus();
  await menu.press('ArrowDown');
  await menu.press('Escape');
  assert.equal(await page.getByRole('listbox').count(), 0);
  await page.evaluate(() => window.showFieldProperties());
  const reference = page.getByRole('textbox', { name: 'Reference text', exact: true });
  await reference.focus();
  await reference.dispatchEvent('compositionstart');
  await reference.fill('R99');
  await done.focus();
  assert.equal(await reference.inputValue(), 'R99', 'Composition retains the editable draft.');
  assert.equal(await page.evaluate(() => window.fieldText), 'R1');
  assert.equal(await page.evaluate(() => window.fieldTextCommits), 0);
  await reference.focus();
  await reference.dispatchEvent('compositionend');
  await done.focus();
  assert.equal(await page.evaluate(() => window.fieldText), 'R99');
  assert.equal(await page.evaluate(() => window.fieldTextCommits), 1);
  const x = page.getByRole('spinbutton', { name: 'Text X position', exact: true });
  await x.fill('2.54');
  await x.dispatchEvent('compositionstart');
  await x.press('Escape');
  await x.press('Control+s');
  assert.equal(await x.inputValue(), '2.54', 'IME Escape retains the coordinate draft.');
  assert.equal(await page.evaluate(() => window.fieldSaves), 0);
  assert.equal(await page.evaluate(() => window.fieldPosition.x), 0);
  await x.dispatchEvent('compositionend');
  await x.press('Enter');
  assert.equal(await page.evaluate(() => window.fieldPosition.x), 2.54);
  assert.deepEqual(errors, []);
  console.log(
    'Quantity input: compatible units, exact no-op display changes, temperature conversion, commit/Escape drafts, compact power fields, invalid input, keyboard and IME checks passed.',
  );
} finally {
  await browser.close();
}
