import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolated shared selector fixtures. No Electron, network, projects or providers.
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import Select from './components/Select';
      const catalog = [
        {value:'all',label:'All categories'},
        {value:'analog',label:'Analog',children:[
          {value:'disabled-category',label:'Unavailable category',disabled:true,children:[
            {value:'not-selectable',label:'Never selectable'}
          ]},
          {value:'amplifiers',label:'Amplifiers',children:[
            {value:'disabled-leaf',label:'Unavailable amplifier',disabled:true},
            {value:'opamp',label:'Operational amplifiers'},
            {value:'comparator',label:'Comparators'},
          ]},
          {value:'converters',label:'Converters'},
        ]},
      ];
      window.fixture = {changes:[],expands:[],closedEscapes:0};
      function App() {
        const [value,setValue] = useState('local:R');
        const [lazy,setLazy] = useState(false);
        const [loaded,setLoaded] = useState(false);
        const [label,setLabel] = useState(undefined);
        const [disabled,setDisabled] = useState(false);
        const [flat,setFlat] = useState(false);
        const [long,setLong] = useState(false);
        const [actionLabel,setActionLabel] = useState('');
        window.configure = config => {
          if ('lazy' in config) {setLazy(config.lazy);setLoaded(false);}
          if ('loaded' in config) setLoaded(config.loaded);
          if ('value' in config) setValue(config.value);
          if ('label' in config) setLabel(config.label);
          if ('disabled' in config) setDisabled(config.disabled);
          if ('flat' in config) setFlat(config.flat);
          if ('long' in config) setLong(config.long);
          if ('actionLabel' in config) setActionLabel(config.actionLabel);
        };
        const options = flat ? [
          {value:'first',label:'First'},
          {value:'disabled-flat',label:'Disabled',disabled:true},
          {value:'last',label:'Last'},
        ] : [
          {value:'source:KiCad',label:'KiCad',children: long ? Array.from({length:50},(_,index)=>({
            value:'local:'+index,label:'Category '+String(index).padStart(2,'0'),
            children:[{value:'long:'+index,label:'Leaf '+index}],
          })) : [
            {value:'local:R',label:'Device'},
            {value:'local:Switching',label:'Regulator Switching',separatorBefore:true},
          ]},
          {value:'source:NextPCB',label:'NextPCB',children:lazy && !loaded ? [
            {value:'loading',label:'Loading categories',disabled:true},
          ] : catalog},
        ];
        return <><Select label="Library" options={options} value={value}
          selectedLabel={label} disabled={disabled} popupMaxHeight={180}
          onChange={next=>{window.fixture.changes.push(next);setValue(next);}}
          onExpand={next=>window.fixture.expands.push(next)}
          onClosedEscape={()=>window.fixture.closedEscapes++}/>
          {actionLabel && <>
            <Select label="Length unit" value="mm" showChevron={false}
              options={[{value:'mm',label:'mm'},{value:'mil',label:'mil'}]} onChange={()=>{}}/>
            <Select label="Actions" value="" popupMatchWidth="content"
              options={[{value:'action',label:actionLabel}]} onChange={()=>{}}/>
          </>}
          <button id="outside">Outside</button></>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
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
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    route.request().url() === 'http://localhost/'
      ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto('http://localhost/');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      '#root {position:fixed;right:24px;bottom:24px;display:flex;gap:16px}.select-trigger{width:200px}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const trigger = page.getByRole('combobox', { name: 'Library', exact: true });
  const popup = (label) => page.getByRole('listbox', { name: label, exact: true });
  const row = (label, name) => popup(label).getByRole('option', { name, exact: true });
  const count = () => page.getByRole('listbox').count();
  const close = async () => {
    await page.mouse.click(2, 2);
    assert.equal(await count(), 0);
  };
  const configure = async (config) => page.evaluate((next) => window.configure(next), config);

  assert.equal(
    await trigger.textContent(),
    'Device',
    'A selected child supplies the trigger label.',
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.expands), []);
  await trigger.click();
  assert.ok(
    Math.abs((await popup('Library').boundingBox()).width - (await trigger.boundingBox()).width) <
      0.5,
  );
  await trigger.evaluate((node) => (node.style.width = '360px'));
  await page.waitForFunction(
    () =>
      Math.abs(document.querySelector('[role="listbox"]').getBoundingClientRect().width - 360) <
      0.5,
  );
  await trigger.evaluate((node) => (node.style.width = '200px'));
  await page.waitForFunction(
    () =>
      Math.abs(document.querySelector('[role="listbox"]').getBoundingClientRect().width - 200) <
      0.5,
  );
  await row('Library', 'NextPCB').hover();
  await popup('NextPCB').waitFor();
  await row('NextPCB', 'Analog').hover();
  await popup('Analog').waitFor();
  await row('Analog', 'Amplifiers').hover();
  await popup('Amplifiers').waitFor();
  assert.equal(await count(), 4);
  assert.deepEqual(await page.evaluate(() => window.fixture.expands), [
    'source:NextPCB',
    'analog',
    'amplifiers',
  ]);
  await row('Amplifiers', 'Unavailable amplifier').dispatchEvent('click');
  assert.deepEqual(await page.evaluate(() => window.fixture.changes), []);
  assert.equal(await count(), 4, 'Disabled leaves do not select or collapse their branch.');
  await row('Amplifiers', 'Operational amplifiers').click();
  assert.equal(await count(), 0);
  assert.equal(await trigger.textContent(), 'Operational amplifiers');
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);

  await trigger.click();
  await trigger.press('ArrowRight');
  await trigger.press('ArrowDown');
  await trigger.press('ArrowRight');
  await trigger.press('ArrowRight');
  await popup('Amplifiers').waitFor();
  assert.equal(
    await trigger.getAttribute('aria-activedescendant'),
    await row('Amplifiers', 'Operational amplifiers').getAttribute('id'),
  );
  for (const event of [
    { key: 'Enter', isComposing: true },
    { key: 'Escape', isComposing: true },
    { key: 'Enter', keyCode: 229 },
    { key: 'Escape', keyCode: 229 },
  ])
    await trigger.dispatchEvent('keydown', event);
  assert.equal(await count(), 4);
  assert.deepEqual(await page.evaluate(() => window.fixture.changes), ['opamp']);
  await trigger.press('Escape');
  assert.equal(await count(), 3, 'Escape returns one level.');
  await trigger.press('ArrowLeft');
  assert.equal(await count(), 2, 'Left returns one level.');
  await trigger.press('Escape');
  assert.equal(await count(), 1);
  await trigger.press('Escape');
  assert.equal(await count(), 0);
  await trigger.press('Escape');
  assert.equal(await page.evaluate(() => window.fixture.closedEscapes), 1);

  // Keyboard typeahead stays inside the currently open branch at every depth.
  await trigger.click();
  await trigger.press('ArrowRight');
  await trigger.press('a');
  await trigger.press('n');
  await trigger.press('ArrowRight');
  await trigger.press('a');
  await trigger.press('ArrowRight');
  await trigger.press('End');
  await trigger.press('Enter');
  assert.equal(await trigger.textContent(), 'Comparators');
  assert.deepEqual(await page.evaluate(() => window.fixture.changes), ['opamp', 'comparator']);
  await configure({ label: 'NextPCB / Analog / Comparators' });
  await page.waitForFunction(
    () => document.querySelector('.select-value').textContent === 'NextPCB / Analog / Comparators',
  );

  // Lazy provider children can replace a disabled loading row in the open menu.
  await configure({ lazy: true, label: undefined });
  await trigger.click();
  const expansionCount = await page.evaluate(() => window.fixture.expands.length);
  await row('Library', 'NextPCB').hover();
  await row('NextPCB', 'Loading categories').waitFor();
  await row('Library', 'NextPCB').hover();
  assert.equal(await page.evaluate(() => window.fixture.expands.length), expansionCount + 1);
  await row('NextPCB', 'Loading categories').dispatchEvent('click');
  assert.equal(await count(), 2);
  await configure({ loaded: true });
  await row('NextPCB', 'Analog').waitFor();
  assert.equal(await count(), 2);
  await row('NextPCB', 'Analog').hover();
  await row('Analog', 'Unavailable category').hover();
  assert.equal(await count(), 3);
  await row('Analog', 'Unavailable category').dispatchEvent('click');
  assert.equal(await count(), 3, 'A disabled branch never opens its children.');
  await row('Analog', 'Amplifiers').hover();
  await popup('Amplifiers').waitFor();
  const cascadeBounds = await page.getByRole('listbox').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }),
  );
  for (let index = 1; index < cascadeBounds.length; index++) {
    const parent = cascadeBounds[index - 1],
      child = cascadeBounds[index];
    assert.ok(
      child.right <= parent.left || child.left >= parent.right,
      'Roomy cascades keep ancestor menus accessible instead of doubling back over them.',
    );
  }
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/select-tree-ui.png' });
  await close();

  // Cascades remain inside the viewport and flip left at the right edge.
  await page.setViewportSize({ width: 520, height: 360 });
  await trigger.click();
  await trigger.press('End');
  await trigger.press('ArrowRight');
  await trigger.press('ArrowDown');
  await trigger.press('ArrowRight');
  await trigger.press('ArrowRight');
  await popup('Amplifiers').waitFor();
  const bounds = await page.getByRole('listbox').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  for (const box of bounds) {
    assert.ok(
      box.left >= 7.5 && box.right <= 512.5 && box.top >= 7.5 && box.bottom <= 352.5,
      JSON.stringify(box),
    );
  }
  await page.screenshot({ path: 'test-results/select-tree-narrow-ui.png' });
  await close();

  // Scrolling a parent closes its descendants, while scrolling elsewhere does not.
  await configure({ long: true, value: 'local:0' });
  await trigger.click();
  await trigger.press('Home');
  await trigger.press('ArrowRight');
  await row('KiCad', 'Category 00').hover();
  await popup('Category 00').waitFor();
  await popup('KiCad').evaluate((node) => {
    node.scrollTop = 50;
  });
  await page.waitForFunction(() => document.querySelectorAll('[role="listbox"]').length === 2);
  assert.equal(await popup('KiCad').count(), 1);
  await configure({ disabled: true });
  await page.waitForFunction(() => document.querySelectorAll('[role="listbox"]').length === 0);
  assert.equal(await trigger.isDisabled(), true);

  // Flat selectors retain their ordinary keyboard and disabled-choice behavior.
  await configure({ disabled: false, flat: true, value: 'first' });
  await trigger.click();
  await trigger.press('ArrowDown');
  await trigger.press('Enter');
  assert.equal(await count(), 1);
  await trigger.press('End');
  await trigger.press('Enter');
  assert.equal(await trigger.textContent(), 'Last');

  await page.setViewportSize({ width: 1120, height: 760 });
  const longAction = 'Restore archived conversation '.repeat(12).trim();
  await configure({ actionLabel: longAction });
  const unit = page.getByRole('combobox', { name: 'Length unit', exact: true });
  await unit.evaluate((element) => (element.style.width = '30px'));
  await unit.click();
  assert.equal((await popup('Length unit').boundingBox()).width, 30);
  const unitLabel = row('Length unit', 'mm').locator('strong');
  assert.ok(await unitLabel.evaluate((label) => label.scrollWidth <= label.clientWidth));
  assert.equal(await row('Length unit', 'mm').getAttribute('aria-selected'), 'true');
  await unit.press('Escape');
  const actions = page.getByRole('combobox', { name: 'Actions', exact: true });
  await actions.click();
  const actionLabel = row('Actions', longAction).locator('strong');
  assert.equal(await actionLabel.getAttribute('title'), longAction);
  assert.ok(await actionLabel.evaluate((label) => label.scrollWidth > label.clientWidth));
  assert.equal(await actionLabel.evaluate((label) => getComputedStyle(label).whiteSpace), 'nowrap');
  assert.ok((await popup('Actions').boundingBox()).width <= 352);
  await actions.press('Escape');
  await configure({ actionLabel: 'Find' });
  await actions.click();
  assert.equal((await popup('Actions').boundingBox()).width, 140);
  await actions.press('Escape');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: recursive Select pointer/keyboard menus, lazy expansion, descendant labels, IME, disabled branches, viewport bounds and flat controls.',
  );
} finally {
  await browser.close();
}
