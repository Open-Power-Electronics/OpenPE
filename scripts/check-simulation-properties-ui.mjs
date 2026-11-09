import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { createPart, emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createExample } = await tsImport('../lib/examples.ts', import.meta.url);
const { createHomeExample } = await tsImport('../lib/create-home-example.ts', import.meta.url);

// Isolated renderer and real document owner: no Electron, service, provider or solver.
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState, useSyncExternalStore} from 'react';
      import {flushSync} from 'react-dom';
      import {createRoot} from 'react-dom/client';
      import PartProperties from './components/PartProperties';
      import {ProjectCore} from './core/project-core';
      import {createPart, emptyCircuit} from './lib/circuit';
      import {partFields} from './lib/library';
      import {createProject, parseProject} from './lib/project';
      function initialCore() {
        const schematic = emptyCircuit();
        const part = createPart(schematic, 'C', 0, 0);
        part.fields = {...partFields(part), 'OpenPE.SeriesResistance':'50m',
          'OpenPE.InitialVoltage':'1.2', 'OpenPE.Coupling':'0.98',
          'OpenPE.Note':'design note', Scratch:'2'};
        schematic.parts.push(part);
        return new ProjectCore(createProject(schematic));
      }
      function Fixture() {
        const [core, setCore] = useState(initialCore);
        const snapshot = useSyncExternalStore(core.subscribe, core.getSnapshot);
        const [saves, setSaves] = useState(0);
        const part = snapshot.project.schematic.parts[0];
        const update = (reference, value, fields) => core.execute('part.properties', {
          schematicId:snapshot.project.schematic.id, partId:part.id,
          reference, value, fields:Object.entries(fields).map(([name,value]) => ({name,value})),
        });
        window.changeSimulationField = (name, value) => update(part.ref, part.value, {
          ...partFields(part), [name]:value,
        });
        window.propertiesState = {source:snapshot.source, revision:snapshot.revision,
          undoDepth:snapshot.undoDepth, saves};
        return <>
          <button onClick={() => core.undo()}>Undo</button>
          <button onClick={() => setCore(new ProjectCore(parseProject(snapshot.source)))}>Reopen</button>
          <div className="panel inspector"><PartProperties key={part.id + ':' + snapshot.project.id}
            part={part} spiceAvailable onSave={(reference, value, fields) => {
              update(reference, value, fields); setSaves(count => count + 1); return true;
            }}/></div>
        </>;
      }
      const root = createRoot(document.getElementById('root'));
      root.render(<Fixture/>);
      let inspection = 0;
      window.showSpicePresentation = ({part, circuit}) => {
        let saves = 0;
        window.readSpicePresentation = () => ({part, circuit, saves});
        flushSync(() => root.render(<div className="panel inspector">
          <PartProperties key={++inspection} part={part} circuit={circuit} spiceAvailable
            onSave={() => { saves++; return true; }} />
        </div>));
      };
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
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div>',
    }),
  );
  await page.goto('http://localhost');
  for (const path of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(path, 'utf8') });
  await page.addStyleTag({
    content:
      '.panel.inspector{position:static;inset:auto;width:400px;max-width:none;max-height:none;overflow:visible;padding:16px;margin:20px;border:1px solid var(--line);border-radius:var(--radius)}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const state = () => page.evaluate(() => window.propertiesState);
  const component = (snapshot) => JSON.parse(snapshot.source).schematic.components[0];
  const field = (name) => page.getByLabel(name, { exact: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const general = page.getByRole('tab', { name: 'General', exact: true });
  const spice = page.getByRole('tab', { name: 'SPICE', exact: true });
  const disclosure = page.getByRole('tabpanel', { name: 'SPICE', exact: true });
  const ordinary = page.getByRole('tabpanel', { name: 'General', exact: true });
  const labels = {
    'OpenPE.InitialVoltage': 'Initial voltage (V)',
  };
  await field('Component value').waitFor();
  const tabLabelOpacity = (tab) =>
    tab.locator('.reveal-button-label').evaluate((label) => getComputedStyle(label).opacity);
  assert.equal(await tabLabelOpacity(general), '1', 'The default tab shows its name at rest.');
  assert.equal(await tabLabelOpacity(spice), '0', 'The inactive tab shows only its icon at rest.');
  const original = await state();
  assert.equal(await spice.getAttribute('aria-selected'), 'false');
  for (const label of Object.values(labels)) {
    assert.equal(await ordinary.getByLabel(label, { exact: true }).count(), 0);
    assert.equal(await field(label).isVisible(), false);
  }
  await general.press('ArrowRight');
  assert.equal(await spice.getAttribute('aria-selected'), 'true');
  await spice.blur();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.property-tabs [role="tab"]')].every((tab) => {
      const opacity = getComputedStyle(tab.querySelector('.reveal-button-label')).opacity;
      return opacity === (tab.getAttribute('aria-selected') === 'true' ? '1' : '0');
    }),
  );
  assert.equal(await field('Component value').isVisible(), false);
  const sharedFields = await disclosure.evaluate((section) => {
    const file = section.querySelector('.property-model-choice');
    const model = section.querySelector('.property-file-models .select-trigger');
    const parameter = section.querySelector('.property-simulation-value .quantity-input');
    const input = file.querySelector('input');
    const bounds = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, width: box.width, height: box.height };
    };
    return {
      file: bounds(file),
      model: bounds(model),
      parameter: bounds(parameter),
      inputBorder: getComputedStyle(input).borderTopWidth,
    };
  });
  for (const field of [sharedFields.model, sharedFields.parameter]) {
    assert.ok(Math.abs(field.left - sharedFields.file.left) <= 1);
    assert.ok(Math.abs(field.width - sharedFields.file.width) <= 1);
    assert.ok(Math.abs(field.height - sharedFields.file.height) <= 1);
  }
  assert.equal(sharedFields.inputBorder, '0px', 'SPICE library selection has one outer outline.');
  assert.equal(await field('Series resistance (Ω)').count(), 0);
  assert.equal(await field('Coupling (unitless)').count(), 0);
  assert.equal(
    await disclosure.locator('.property-simulation-parameter input').count(),
    1,
    'Numeric simulation parameters are editable without field-removal controls.',
  );
  for (const [name, value] of Object.entries({
    'OpenPE.InitialVoltage': '1.2',
  })) {
    assert.equal(await field(labels[name]).inputValue(), Number(value).toFixed(2));
    assert.equal(await field(labels[name]).isEditable(), true);
    assert.equal(component(original).fields?.[name], undefined);
  }
  assert.deepEqual(component(original).simulation, {
    seriesResistance: '50m',
    initialVoltage: '1.2',
    coupling: '0.98',
  });
  assert.equal(await field('OpenPE.Note').inputValue(), 'design note');
  assert.equal(await field('Scratch').inputValue(), '2');
  assert.deepEqual(await state(), original, 'Inspecting parameters stays clean.');

  assert.equal(await field('Scratch').isVisible(), false);
  await general.click();
  await field('Scratch').fill('3');
  await field('Scratch').press('Enter');
  const edited = await state();
  assert.equal(edited.saves, 1);
  assert.equal(edited.undoDepth, 1);
  assert.deepEqual(component(edited).simulation, component(original).simulation);
  assert.equal(component(edited).fields.Scratch, '3');
  await button('Undo').click();
  await page.waitForFunction(() => window.propertiesState.undoDepth === 0);
  assert.equal((await state()).source, original.source);

  await spice.click();
  for (const [label, key, value] of [['Initial voltage (V)', 'initialVoltage', '-5']]) {
    await field(label).fill(value);
    await field(label).press('Enter');
    assert.equal(component(await state()).simulation[key], value);
    assert.equal((await state()).undoDepth, 1);
    await button('Undo').click();
    await page.waitForFunction(() => window.propertiesState.undoDepth === 0);
    assert.equal((await state()).source, original.source);
  }
  await field('Initial voltage (V)').fill('invalid');
  await button('Undo').focus();
  await page.getByRole('alert').waitFor();
  assert.equal((await state()).source, original.source);
  await general.click();
  await spice.click();
  assert.equal(await field('Initial voltage (V)').inputValue(), 'invalid');
  await field('Initial voltage (V)').fill('2.5');
  await field('Initial voltage (V)').press('Enter');
  assert.equal(component(await state()).simulation.initialVoltage, '2.5');
  assert.equal(await page.getByRole('alert').count(), 0);
  await button('Undo').click();
  await page.waitForFunction(() => window.propertiesState.undoDepth === 0);
  await field('Initial voltage (V)').fill('8');
  await field('Initial voltage (V)').press('Escape');
  assert.equal(await field('Initial voltage (V)').inputValue(), '1.20');
  assert.equal((await state()).source, original.source);
  await field('Initial voltage (V)').dispatchEvent('compositionstart');
  await field('Initial voltage (V)').fill('6');
  await field('Initial voltage (V)').press('Enter');
  assert.equal((await state()).source, original.source, 'IME cannot commit a parameter draft.');
  await field('Initial voltage (V)').dispatchEvent('compositionend');
  const prevented = await field('Initial voltage (V)').evaluate((element) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, true);
  assert.equal((await state()).source, original.source);
  await field('Initial voltage (V)').press('Enter');
  assert.equal(component(await state()).simulation.initialVoltage, '6');
  await button('Undo').click();
  await page.waitForFunction(() => window.propertiesState.undoDepth === 0);

  await page.evaluate(() => window.changeSimulationField('OpenPE.InitialVoltage', '2.4'));
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Initial voltage (V)"]')?.value === '2.40',
  );
  assert.equal((await state()).undoDepth, 1, 'Inputs follow accepted Core edits.');
  await button('Undo').click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Initial voltage (V)"]')?.value === '1.20',
  );
  assert.equal((await state()).source, original.source);
  await button('Reopen').click();
  await spice.click();
  assert.equal((await state()).source, original.source);
  assert.equal(await field(labels['OpenPE.InitialVoltage']).inputValue(), '1.20');
  assert.equal(await disclosure.locator('.property-simulation-parameter input').count(), 1);

  const beforeAppearance = await state();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/simulation-properties.png' });
  await page.locator('.panel').evaluate((element) => {
    element.style.width = '320px';
  });
  const bounds = await disclosure
    .locator('.property-parameter-name, .property-simulation-value')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        text: element.textContent,
        width: element.clientWidth,
        contentWidth: element.scrollWidth,
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
      })),
    );
  for (const item of bounds)
    assert.ok(
      item.width > 0 &&
        item.height > 0 &&
        item.contentWidth <= item.width + 1 &&
        item.contentHeight <= item.height + 1,
      item.text + ' remains fully visible in compact Properties.',
    );
  await page.screenshot({ path: 'test-results/simulation-properties-compact.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.textSize = 'extra-large';
  });
  const labelsFit = await disclosure
    .locator('.property-simulation-parameter > .property-parameter-name')
    .evaluateAll((elements) =>
      elements.every((element) => {
        const style = getComputedStyle(element);
        const line = parseFloat(style.lineHeight);
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        return (
          element.clientHeight >= Math.floor(line + padding) &&
          element.scrollHeight <= element.clientHeight + 1 &&
          element.scrollWidth <= element.clientWidth + 1
        );
      }),
    );
  assert.ok(
    labelsFit,
    'Parameter names wrap without clipping at extra-large text size in compact Properties.',
  );
  await page.screenshot({ path: 'test-results/simulation-properties-compact-extra-large.png' });
  await page.evaluate(() => {
    delete document.documentElement.dataset.textSize;
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({
    path: 'test-results/simulation-properties-compact-dark.png',
    animations: 'disabled',
  });
  await page.locator('.panel').evaluate((element) => {
    element.style.width = '400px';
  });
  await page.screenshot({
    path: 'test-results/simulation-properties-dark.png',
    animations: 'disabled',
  });
  assert.deepEqual(await state(), beforeAppearance);
  assert.equal(
    await page.getByRole('switch').count(),
    0,
    'Participation belongs to SPICE settings.',
  );

  async function inspectSpice(part, verify, circuit = null) {
    await page.evaluate((fixture) => window.showSpicePresentation(fixture), { part, circuit });
    assert.equal(await spice.getAttribute('aria-selected'), 'false');
    assert.equal(await page.locator('.property-simulation').count(), 0);
    await spice.click();
    await disclosure.waitFor();
    await verify(await disclosure.innerHTML());
    assert.deepEqual(await page.evaluate(() => window.readSpicePresentation()), {
      part,
      circuit,
      saves: 0,
    });
  }

  const buck = createExample('kicad-buck').schematic;
  for (const [ref, label] of [
    ['V102', 'Voltage (V)'],
    ['V101', 'Pulsed voltage (V)'],
  ]) {
    await inspectSpice(
      buck.parts.find((part) => part.ref === ref),
      async (html) => {
        assert.equal(await disclosure.getByLabel(label, { exact: true }).isEditable(), true);
        assert.doesNotMatch(html, /aria-label="(?:Device|Type|Pins|Params)"/);
        assert.equal(await field('Component value').isVisible(), false);
      },
    );
  }

  const resistor = createPart(emptyCircuit(), 'R', 0, 0);
  for (const libId of [
    'Device:R',
    'Device:C',
    'Device:L',
    'Device:D',
    'power:GND',
    'Connector_Generic:Conn_01x02',
  ]) {
    await inspectSpice({ ...resistor, libId }, (html) => {
      assert.match(
        html,
        /role="combobox"[^>]*aria-label="Simulation model"|aria-label="Simulation model"[^>]*role="combobox"/,
      );
      assert.match(html, /aria-label="Browse SPICE models"/);
      assert.doesNotMatch(
        html,
        /<select|role="(?:radio|switch)"|>Basic<|>External<|Default model|placeholder="Default"/,
      );
      if (libId === 'Device:R')
        assert.doesNotMatch(html, /aria-label="Initial (?:voltage|current)/);
    });
  }

  const external = {
    ...resistor,
    fields: {
      ...resistor.fields,
      'Sim.Device': 'SUBCKT',
      'Sim.Name': 'OPENPE_DERIVED_LM2596_ADJ_TRANS',
      'Sim.Library': 'OpenPE:lm2596-adj-derived',
      'Sim.Pins': '1=1 2=2',
      'OpenPE.SeriesResistance': '50m',
    },
  };
  await inspectSpice(external, async (html) => {
    const file = disclosure.getByLabel('Model library', { exact: true });
    assert.equal(await file.inputValue(), 'LM2596-5.lib');
    assert.equal(await file.getAttribute('title'), 'circuits/LM2596-5.lib');
    assert.equal(await file.isEditable(), false);
    const model = disclosure.getByRole('combobox', { name: 'Simulation model', exact: true });
    assert.equal(await disclosure.getByRole('combobox').count(), 1);
    assert.match(await model.innerText(), /LM2596_ADJ_TRANS/);
    assert.match(html, /<span>File<\/span>.*<span>Model<\/span>/s);
    assert.doesNotMatch(
      html,
      /Models in file|Remove field|Series resistance|Coupling|SUBCKT|1=1 2=2|OpenPE:lm2596-adj-derived|aria-label="(?:Device|Pins)"/,
    );
    assert.doesNotMatch(html.replace(/<input\b[^>]*readonly=""[^>]*>/gi, ''), /<input/);
    assert.doesNotMatch(await disclosure.innerText(), /Sim\.(?:Device|Name|Pins)|OPENPE_DERIVED_/);
  });

  for (const [kind, key, label, other, value, display, unit] of [
    ['C', 'OpenPE.InitialVoltage', 'Initial voltage (V)', 'Initial current (A)', '2.5', 2.5, 'V'],
    ['L', 'OpenPE.InitialCurrent', 'Initial current (A)', 'Initial voltage (V)', '40m', 40, 'mA'],
  ]) {
    const part = createPart(emptyCircuit(), kind, 0, 0);
    const input = disclosure.getByLabel(label, { exact: true });
    await inspectSpice(part, async () => {
      assert.equal(await input.getAttribute('placeholder'), 'Computed');
      assert.equal(await input.isEditable(), true);
      assert.equal(await disclosure.getByLabel(other, { exact: true }).count(), 0);
    });
    const fields = {
      ...part.fields,
      'Sim.Device': kind,
      'Sim.Name': 'VENDOR_' + kind,
      'Sim.Library': 'circuits/storage.lib',
      'Sim.Pins': '1=+ 2=-',
      'OpenPE.ModelSource': 'external',
      [key]: value,
    };
    await inspectSpice({ ...part, fields }, async () => {
      assert.equal(Number(await input.inputValue()), display);
      assert.equal(await input.isEditable(), true);
      assert.equal(await disclosure.getByLabel(other, { exact: true }).count(), 0);
      assert.equal(
        await disclosure.getByRole('combobox', { name: label + ' unit' }).innerText(),
        unit,
      );
    });
    await inspectSpice(
      { ...part, fields: { ...fields, 'Sim.Device': 'SUBCKT', 'Sim.Pins': '1=1 2=2' } },
      (html) => assert.doesNotMatch(html, /aria-label="Initial (?:voltage|current) \([VA]\)"/),
    );
  }
  const emc = createHomeExample('emc-flyback-demo').schematic;
  await inspectSpice(
    emc.parts.find((part) => part.ref === 'C4'),
    async () => {
      const initial = disclosure.getByLabel('Initial voltage (V)', { exact: true });
      assert.equal(await initial.getAttribute('placeholder'), '24');
      assert.equal(Number(await initial.inputValue()), 24);
    },
    emc,
  );

  assert.deepEqual(errors, []);
  console.log(
    'SPICE tab activation, model and source controls, initial conditions, invalid retry, IME/Escape, edit/undo, compact themes and Core refresh/reopen passed.',
  );
} finally {
  await browser.close();
}
