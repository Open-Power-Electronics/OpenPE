import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolated renderer and real document owner: no Electron, service, provider or solver.
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState, useSyncExternalStore} from 'react';
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
          <div className="panel"><PartProperties key={part.id + ':' + snapshot.project.id}
            part={part} spiceAvailable onSave={(reference, value, fields) => {
              update(reference, value, fields); setSaves(count => count + 1); return true;
            }}/></div>
        </>;
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
      '.panel{width:400px;padding:16px;margin:20px;border:1px solid #ddd;border-radius:16px}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const state = () => page.evaluate(() => window.propertiesState);
  const component = (snapshot) => JSON.parse(snapshot.source).schematic.components[0];
  const field = (name) => page.getByLabel(name, { exact: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const disclosure = page.locator('details.property-simulation');
  const ordinary = page.locator('.part-properties > .property-fields');
  const labels = {
    'OpenPE.InitialVoltage': 'Initial voltage (V)',
  };
  await field('Component value').waitFor();
  const original = await state();
  assert.equal(await disclosure.getAttribute('open'), null);
  for (const label of Object.values(labels)) {
    assert.equal(await ordinary.getByLabel(label, { exact: true }).count(), 0);
    assert.equal(await field(label).isVisible(), false);
  }
  await disclosure.locator('summary').click();
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

  await page.locator('.property-additional-fields > summary').click();
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
          element.clientHeight <= Math.ceil(line + padding) + 1 &&
          element.scrollWidth <= element.clientWidth + 1
        );
      }),
    );
  assert.ok(
    labelsFit,
    'Parameter names stay on one line at extra-large text size in compact Properties.',
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
  assert.deepEqual(errors, []);
  console.log(
    'Editable SPICE parameters, shared numeric limits, invalid retry, IME/Escape, edit/undo, labels/units, compact themes and Core refresh/reopen passed.',
  );
} finally {
  await browser.close();
}
