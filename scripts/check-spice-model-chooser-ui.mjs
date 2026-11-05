import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readNativeProject } = require('../electron/native-project.cjs');
const { readSpiceModelFile } = require('../electron/spice-model-picker.cjs');
const emcFiles = await readNativeProject(path.resolve('recent/emc-flyback/emc-flyback.kicad_pro'));
const emcModels = await readSpiceModelFile(
  path.resolve('recent/emc-flyback/circuits/EMC_flyback_control.lib'),
);
const lm5001Files = await readNativeProject(
  path.resolve('examples/lm5001-soic8-boost/lm5001-soic8-boost.kicad_pro'),
);
const lm5001Models = await readSpiceModelFile(
  path.resolve('examples/lm5001-soic8-boost/circuits/LM5001.lib'),
);

// Isolated renderer and real Core; native dialogs and declaration discovery are mocked.
const bundle = await build({
  stdin: {
    contents: `
      import React, {useCallback, useState, useSyncExternalStore} from 'react';
      import {createRoot} from 'react-dom/client';
      import PartProperties from './components/PartProperties';
      import {ProjectCore} from './core/project-core';
      import {createPart, emptyCircuit, libraries} from './lib/circuit';
      import {partFields,createLibraryPart} from './lib/library';
      import {createProject} from './lib/project';
      import {projectFromNativeFiles} from './lib/kicad-project';
      const emcProject=projectFromNativeFiles(${JSON.stringify(emcFiles)});
      const lm5001Project=projectFromNativeFiles(${JSON.stringify(lm5001Files)});
      const circuit = emptyCircuit();
      const initial = createPart(circuit, 'R', 0, 0);
      initial.fields = {...partFields(initial), Description:'Retained device metadata',
        'OpenPE.ModelSource':'external', 'Sim.Device':'SUBCKT', 'Sim.Name':'RES_A',
        'Sim.Library':'circuits/vendor.lib', 'Sim.Pins':'1=+ 2=-'};
      const capacitor = createPart(circuit, 'C', 2.54, 0);
      const source=createLibraryPart(circuit,libraries['Simulation_SPICE:VDC'],5.08,0);
      circuit.libraries[source.libId]=structuredClone(libraries[source.libId]);
      circuit.parts.push(initial, capacitor, source);
      const core = new ProjectCore(createProject(circuit));
      const getRevision = () => core.getSnapshot().revision;
      window.modelPickerCalls=[];
      window.modelPickerMode='file';
      window.modelPickedPath='circuits/vendor.lib';
      window.modelIssues=[];
      window.modelInspectionResult=null;
      window.modelInspectionCalls=[];
      window.modelCatalog=[{name:'RES_A',kind:'subcircuit',pins:['+','-']},
        {name:'RES_B',kind:'subcircuit',pins:['+','-']}];
      window.openpe={inspectSpiceModel:async(fileId,library)=>{
        window.modelInspectionCalls.push({fileId,library});
        if(window.modelInspectionMode==='delayed')return new Promise(resolve=>{window.resolveModelInspection=resolve;});
        return window.modelInspectionResult;
      },chooseSpiceModel:async (fileId,currentLibrary)=>{
        window.modelPickerCalls.push({fileId,currentLibrary});
        if(window.modelPickerMode==='cancel') return null;
        if(window.modelPickerMode==='failure') throw new Error('Picker failed');
        if(window.modelPickerMode==='stale-host') return {path:window.modelPickedPath};
        if(window.modelPickerMode==='delayed') return new Promise(resolve=>{window.resolveModelPicker=resolve;});
        return {path:window.modelPickedPath,models:window.modelCatalog,issues:window.modelIssues};
      }};
      function Fixture(){
        const snapshot=useSyncExternalStore(core.subscribe,core.getSnapshot);
        const [active,setActive]=useState(true), [spice,setSpice]=useState(true);
        const [fileId,setFileId]=useState('project-grant'),[partIndex,setPartIndex]=useState(0);
        const [epoch,setEpoch]=useState(0);
        window.configureModelFixture=options=>{
          if(options.active!==undefined)setActive(options.active);
          if(options.spice!==undefined)setSpice(options.spice);
          if(options.fileId!==undefined)setFileId(options.fileId);
          if(options.partIndex!==undefined)setPartIndex(options.partIndex);
        };
        window.reopenModelProperties=()=>setEpoch(value=>value+1);
        window.invalidateModelRevision=()=>core.execute('schematic.move',{
          schematicId:circuit.id,ids:[initial.id],delta:{x:1.27,y:0},
        });
        window.undoModelEdit=()=>core.undo();
        const part=snapshot.project.schematic.parts[partIndex];
        window.modelState={fields:partFields(part),revision:snapshot.revision,
          undoDepth:snapshot.undoDepth,source:snapshot.source};
        const save=useCallback((reference,value,fields)=>{
          core.execute('part.properties',{schematicId:circuit.id,partId:part.id,
            reference,value,fields:Object.entries(fields).map(([name,value])=>({name,value}))});
          return true;
        },[part.id]);
        return <div className="panel"><PartProperties key={part.id+':'+epoch} part={part}
          circuit={snapshot.project.schematic} active={active} spiceAvailable={spice}
          fileId={fileId||undefined} getRevision={getRevision} onSave={save}/></div>;
      }
      const root=createRoot(document.getElementById('root'));
      window.openEmcModelFixture=(reference,active=true,spice=true)=>root.render(<PartProperties key={'emc:'+active+':'+spice}
        part={emcProject.schematic.parts.find(part=>part.ref===reference)} circuit={emcProject.schematic}
        active={active} spiceAvailable={spice} fileId="emc-grant" getRevision={()=>0}
        onSave={()=>{throw new Error('Inspection must never edit the component.');}}/>);
      window.openLmModelFixture=()=>root.render(<PartProperties key="lm5001"
        part={lm5001Project.schematic.parts.find(part=>part.ref==='U1')} circuit={lm5001Project.schematic}
        spiceAvailable fileId="lm5001-grant" getRevision={()=>0}
        onSave={()=>{throw new Error('Inspection must never edit the component.');}}/>);
      root.render(<Fixture/>);
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
  const page = await browser.newPage({ viewport: { width: 760, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: '.panel{width:320px;padding:12px;margin:24px}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const state = () => page.evaluate(() => window.modelState);
  const field = (name) => page.getByLabel(name, { exact: true });
  const browse = page.getByRole('button', { name: 'Browse SPICE models', exact: true });
  const model = page.getByRole('combobox', { name: 'Simulation model', exact: true });
  const fileModels = model;
  const filePopup = page.getByRole('listbox', { name: 'Simulation model', exact: true });
  const section = page.locator('details.property-simulation');
  const reference = field('Component reference');
  const externalFile = 'C:\\SPICE models\\Vendor\\long-controller-transient-library-name.lib';
  const resistanceCatalog = [
    { name: 'RES_A', kind: 'subcircuit', pins: ['+', '-'] },
    { name: 'RES_B', kind: 'subcircuit', pins: ['+', '-'] },
  ];
  const configure = async (options) => {
    await page.evaluate((options) => window.configureModelFixture(options), options);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  const choose = async (value, path, models) =>
    page.evaluate(
      ({ value, path, models }) => {
        window.modelPickerMode = value;
        if (path !== undefined) window.modelPickedPath = path;
        if (models !== undefined) window.modelCatalog = models;
      },
      { value, path, models },
    );
  const idle = () =>
    page.waitForFunction(
      () => !document.querySelector('[aria-label="Browse SPICE models"]')?.disabled,
    );
  const ensureOpen = async () => {
    if ((await section.getAttribute('open')) === null) await section.locator('summary').click();
  };
  const reopen = async () => {
    const previous = await section.elementHandle();
    await page.evaluate(() => window.reopenModelProperties());
    await page.waitForFunction((element) => !element.isConnected, previous);
    await previous.dispose();
    await ensureOpen();
  };
  const undoTo = async (depth) => {
    while ((await state()).undoDepth > depth) {
      const previous = (await state()).undoDepth;
      await page.evaluate(() => window.undoModelEdit());
      await page.waitForFunction((previous) => window.modelState.undoDepth < previous, previous);
    }
    assert.equal((await state()).undoDepth, depth);
  };
  await ensureOpen();
  await model.waitFor();

  const original = await state();
  const popup = page.getByRole('listbox', { name: 'Simulation model', exact: true });
  const pick = async (label) => {
    if (!(await popup.isVisible())) await model.click();
    await popup.getByRole('option', { name: new RegExp('^' + label + '(?:$| )') }).click();
  };
  const open = async (path = 'circuits/vendor.lib', models = resistanceCatalog) => {
    await choose('file', path, models);
    await browse.click();
    await idle();
  };
  assert.equal(await model.textContent(), 'RES_A');
  assert.equal(await fileModels.isDisabled(), false, 'Intrinsic models remain available.');
  const library = page.getByLabel('Model library', { exact: true });
  assert.equal(await library.inputValue(), 'vendor.lib');
  assert.equal(await library.getAttribute('readonly'), '');
  assert.equal(await library.getAttribute('title'), 'circuits/vendor.lib');
  const pathBounds = await library.boundingBox();
  const modelBounds = await model.boundingBox();
  assert.ok(pathBounds.y + pathBounds.height < modelBounds.y);
  assert.equal(await model.evaluate((element) => element.tagName), 'BUTTON');
  const count = await page.evaluate(() => window.modelPickerCalls.length);
  await pick('ngspice R');
  assert.equal(await model.textContent(), 'ngspice R');
  for (const key of ['Sim.Library', 'Sim.Name', 'Sim.Pins', 'Sim.Device', 'Description'])
    assert.equal((await state()).fields[key], original.fields[key]);
  await pick('RES_A');
  assert.equal((await state()).source, original.source);
  assert.equal(
    await page.evaluate(() => window.modelPickerCalls.length),
    count,
    'Model switches do not open native dialogs.',
  );
  await undoTo(0);
  await open();
  assert.equal((await state()).source, original.source);
  assert.equal(await page.getByLabel('Model library', { exact: true }).inputValue(), 'vendor.lib');
  assert.equal(
    await page.locator('.property-model-file[role="status"]').count(),
    0,
    'Library model counts do not add a caption between File and Model.',
  );
  await open('circuits/vendor.lib', [resistanceCatalog[1]]);
  assert.equal(
    (await state()).source,
    original.source,
    'Inspecting a library missing its assigned name cannot commit a replacement.',
  );
  assert.match(await page.getByRole('alert').textContent(), /does not contain model "RES_A"/);
  assert.equal(await model.textContent(), 'Choose model from file');
  await model.click();
  assert.equal(await popup.getByRole('option', { name: 'RES_A', exact: true }).count(), 0);
  await model.press('Escape');
  await open();
  await open('circuits/vendor.lib', [
    { name: 'RES_A', kind: 'model', device: 'UNSUPPORTED', pins: [] },
  ]);
  await fileModels.click();
  assert.equal(await filePopup.getByRole('option').count(), 2);
  assert.doesNotMatch(
    await filePopup.textContent(),
    /Incompatible|no supported pin|terminals|pins/,
  );
  assert.equal(await filePopup.locator('small').count(), 0);
  const unavailable = filePopup.getByRole('option', { name: 'RES_A', exact: true });
  assert.equal(await unavailable.getAttribute('aria-disabled'), 'true');
  assert.match(await unavailable.getAttribute('class'), /\bmuted\b/);
  const unavailableColour = await unavailable
    .locator('strong')
    .evaluate((element) => getComputedStyle(element).color);
  const availableColour = await filePopup
    .getByRole('option', { name: 'ngspice R', exact: true })
    .locator('strong')
    .evaluate((element) => getComputedStyle(element).color);
  assert.notEqual(unavailableColour, availableColour, 'Unavailable models remain visible in grey.');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/spice-file-models-incompatible.png' });
  await fileModels.press('Enter');
  assert.equal((await state()).source, original.source);
  await unavailable.click({ force: true });
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal((await state()).source, original.source);
  await model.press('Escape');
  await open();
  await open('circuits/empty.lib', []);
  assert.equal(await fileModels.textContent(), 'No models found');
  assert.equal(await fileModels.isDisabled(), false, 'Intrinsic models remain available.');
  await undoTo(0);
  await open('circuits/RES_A.lib', [resistanceCatalog[0]]);
  assert.equal((await state()).fields['Sim.Name'], undefined);
  assert.equal(await page.getByLabel('Model library', { exact: true }).inputValue(), 'RES_A.lib');
  await pick('RES_A');
  assert.equal((await state()).fields['Sim.Library'], 'circuits/RES_A.lib');
  assert.equal((await state()).fields['Sim.Name'], 'RES_A');
  await undoTo(0);
  await open();
  assert.deepEqual((await page.evaluate(() => window.modelPickerCalls)).at(-1), {
    fileId: 'project-grant',
    currentLibrary: 'circuits/vendor.lib',
  });
  await model.click();
  assert.equal(await popup.getByRole('option').first().textContent(), 'RES_A');
  await model.press('Escape');
  assert.equal(await popup.count(), 0);
  assert.equal(await model.evaluate((element) => document.activeElement === element), true);
  await open(externalFile);
  assert.equal((await state()).fields['Sim.Name'], undefined);
  const beforeFileChoice = await state();
  await fileModels.click();
  assert.equal(await filePopup.getByRole('option').count(), 3);
  assert.equal(
    await page.getByLabel('Model library', { exact: true }).inputValue(),
    'long-controller-transient-library-name.lib',
  );
  assert.equal(await library.getAttribute('title'), externalFile);
  assert.equal(await page.getByRole('combobox').count(), 1);
  await page.screenshot({ path: 'test-results/spice-file-models.png' });
  await fileModels.dispatchEvent('compositionstart');
  await filePopup.getByRole('option', { name: 'RES_B', exact: true }).click();
  assert.deepEqual(await state(), beforeFileChoice);
  await fileModels.dispatchEvent('compositionend');
  await fileModels.press('ArrowDown');
  await fileModels.press('End');
  await fileModels.press('Enter');
  assert.equal((await state()).fields['Sim.Name'], 'RES_B');
  assert.equal((await state()).undoDepth, 2);
  await reopen();
  assert.equal(await model.textContent(), 'RES_B');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({
    path: 'test-results/spice-model-path-external.png',
    animations: 'disabled',
  });
  await undoTo(0);
  for (const mode of ['cancel', 'failure', 'stale-host']) {
    await choose(mode);
    await browse.click();
    await idle();
    assert.equal((await state()).source, original.source);
  }
  await open(externalFile);
  await undoTo(0);
  await reference.fill('');
  await pick('ngspice R');
  await page.getByRole('alert').waitFor();
  assert.equal((await state()).source, original.source);
  await reference.press('Escape');
  const beforeIME = await state();
  await model.dispatchEvent('compositionstart');
  await pick('ngspice R');
  assert.deepEqual(await state(), beforeIME);
  await model.dispatchEvent('compositionend');
  const prevented = await model.evaluate((element) => {
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
  for (const change of [
    { revision: true },
    { active: false },
    { spice: false },
    { fileId: 'replacement-grant' },
  ]) {
    await choose('delayed');
    await page.evaluate(() => delete window.resolveModelPicker);
    await browse.click();
    await page.waitForFunction(() => typeof window.resolveModelPicker === 'function');
    if (change.revision) await page.evaluate(() => window.invalidateModelRevision());
    else await configure(change);
    const before = await state();
    await page.evaluate(
      ({ path, models }) => window.resolveModelPicker({ path, models, issues: [] }),
      { path: externalFile, models: resistanceCatalog },
    );
    await configure({ active: true, spice: true, fileId: 'project-grant' });
    await ensureOpen();
    await idle();
    assert.equal((await state()).source, before.source);
    await undoTo(0);
  }
  await configure({ partIndex: 1 });
  await ensureOpen();
  const capOriginal = await state();
  await open(externalFile, [{ name: 'CAP_A', kind: 'model', device: 'C', pins: ['1', '2'] }]);
  assert.equal(await model.textContent(), 'ngspice C');
  await pick('CAP_A');
  assert.equal(await field('Initial voltage (V)').isVisible(), true);
  await undoTo(0);
  await open(externalFile, [{ name: 'CUSTOM_C', kind: 'subcircuit', pins: ['ALPHA', 'BETA'] }]);
  const beforeMapping = await state();
  await pick('CUSTOM_C');
  assert.equal((await state()).source, beforeMapping.source);
  await field('Map ALPHA').selectOption('1');
  await field('Map BETA').selectOption('1');
  const apply = page.getByRole('button', { name: 'Apply model', exact: true });
  await apply.click();
  assert.equal((await state()).source, beforeMapping.source);
  await field('Map BETA').selectOption('2');
  await apply.click();
  assert.equal((await state()).fields['Sim.Pins'], '1=1 2=2');
  assert.equal(await field('Initial voltage (V)').count(), 0);
  await undoTo(0);
  assert.equal((await state()).source, capOriginal.source);
  await configure({ partIndex: 2 });
  await ensureOpen();
  const sourceOriginal = await state();
  assert.equal(await model.textContent(), 'DC voltage source');
  await pick('PULSE voltage source');
  assert.equal((await state()).fields['OpenPE.SourceType'], 'PULSE');
  assert.equal(await field('Period (s)').isVisible(), true);
  assert.equal((await state()).undoDepth, 1);
  await field('Pulsed voltage (V)').fill('24');
  await field('Pulsed voltage (V)').press('Enter');
  await pick('SIN voltage source');
  assert.equal(await field('Frequency (Hz)').isVisible(), true);
  assert.equal(await field('Amplitude (V)').inputValue(), '12.00');
  await reopen();
  assert.equal(await model.textContent(), 'SIN voltage source');
  await pick('DC voltage source');
  assert.equal(await field('Voltage (V)').inputValue(), '12.00');
  await undoTo(0);
  assert.equal((await state()).source, sourceOriginal.source);
  await model.click();
  assert.equal(await popup.getByRole('option').count(), 3);
  assert.equal(await popup.getByRole('option', { name: 'Choose model', exact: true }).count(), 0);
  await page.screenshot({ path: 'test-results/spice-model-menu.png', animations: 'disabled' });
  const assertMenuWidth = async () => {
    const bounds = await page.evaluate(() => {
      const menu = document.querySelector('.property-model-menu').getBoundingClientRect();
      const control = document
        .querySelector('.property-file-models .select-trigger')
        .getBoundingClientRect();
      return {
        width: menu.width,
        controlWidth: control.width,
        left: menu.left,
        controlLeft: control.left,
        right: menu.right,
      };
    });
    assert.ok(Math.abs(bounds.width - bounds.controlWidth) < 1);
    assert.ok(Math.abs(bounds.left - bounds.controlLeft) < 1);
    assert.ok(bounds.right <= 760);
  };
  await assertMenuWidth();
  for (const width of [260, 400, 320]) {
    await page
      .locator('.panel')
      .evaluate((element, width) => (element.style.width = width + 'px'), width);
    await page.waitForFunction(
      () =>
        Math.abs(
          document.querySelector('.property-model-menu').getBoundingClientRect().width -
            document.querySelector('.property-file-models .select-trigger').getBoundingClientRect()
              .width,
        ) < 1,
    );
    await assertMenuWidth();
  }
  await page.screenshot({ path: 'test-results/spice-model-menu.png', animations: 'disabled' });
  await model.press('Escape');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await model.click();
  await page.screenshot({ path: 'test-results/spice-model-menu-dark.png', animations: 'disabled' });
  await model.press('Escape');
  await page.evaluate((result) => {
    document.documentElement.dataset.theme = 'light';
    window.modelInspectionResult = { path: 'circuits/EMC_flyback_control.lib', ...result };
  }, emcModels);
  const beforeAutomatic = await page.evaluate(() => window.modelPickerCalls.length);
  for (const [reference, name] of [
    ['U1', 'UC3845B'],
    ['U4', 'LTV817'],
  ]) {
    await page.evaluate((reference) => window.openEmcModelFixture(reference), reference);
    await ensureOpen();
    await page.waitForFunction(
      (name) => document.querySelector('[aria-label="Simulation model"]')?.textContent === name,
      name,
    );
    await ensureOpen();
    assert.equal(await model.textContent(), name);
    await model.click();
    await page.waitForFunction(
      () => document.querySelectorAll('.property-model-menu [role="option"]').length === 3,
    );
    assert.equal(await popup.getByRole('option').count(), 3);
    assert.equal(await popup.locator('.select-option.muted').count(), 2);
    assert.equal(await popup.locator('[aria-disabled="true"]').count(), 2);
    assert.equal(await popup.locator('small').count(), 0);
    await page.screenshot({ path: `test-results/spice-model-auto-${reference}.png` });
    await model.press('Escape');
  }
  assert.equal(await page.evaluate(() => window.modelPickerCalls.length), beforeAutomatic);
  await page.evaluate((models) => {
    window.modelInspectionResult = { path: 'circuits/LM5001.lib', ...models };
    window.openLmModelFixture();
  }, lm5001Models);
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Model library"]')?.value === 'LM5001.lib' &&
      document.querySelector('[aria-label="Simulation model"]')?.textContent === 'LM5001_TRANS',
  );
  await ensureOpen();
  assert.equal(await model.textContent(), 'LM5001_TRANS');
  await model.click();
  assert.equal(await popup.getByRole('option').count(), 1);
  assert.equal(await popup.textContent(), 'LM5001_TRANS');
  await page.screenshot({ path: 'test-results/spice-model-lm5001-device.png' });
  await model.press('Escape');
  await page.evaluate((models) => {
    window.modelInspectionResult = { path: 'circuits/EMC_flyback_control.lib', ...models };
  }, emcModels);
  const inspections = await page.evaluate(() => window.modelInspectionCalls.length);
  for (const [active, spice] of [
    [false, true],
    [true, false],
  ]) {
    await page.evaluate(({ active, spice }) => window.openEmcModelFixture('U1', active, spice), {
      active,
      spice,
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await page.evaluate(() => window.modelInspectionCalls.length), inspections);
  }
  await page.evaluate(() => {
    window.modelInspectionMode = 'delayed';
    window.openEmcModelFixture('U1');
  });
  await page.waitForFunction(() => typeof window.resolveModelInspection === 'function');
  await page.evaluate(() => window.openEmcModelFixture('U4', false));
  await page.evaluate(() => window.resolveModelInspection(window.modelInspectionResult));
  await ensureOpen();
  assert.equal(
    await page.locator('.property-model-file').count(),
    0,
    'Late inspection cannot populate another component.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Themed model dropdown, source DC/PULSE/SIN conversion, parameter adaptation, geometry-preserving Core edits, undo/reopen, external models, pin mapping, keyboard/IME and stale origins passed.',
  );
} finally {
  await browser.close();
}
