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
        part.fields = {
          ...partFields(part),
          'OpenPE.SeriesResistance': '50m',
          'OpenPE.InitialVoltage': '1.2',
          'OpenPE.Coupling': '0.98',
          'OpenPE.Note': 'design note',
          Scratch: '2',
        };
        schematic.parts.push(part);
        return new ProjectCore(createProject(schematic));
      }
      function Fixture() {
        const [core, setCore] = useState(initialCore);
        const snapshot = useSyncExternalStore(core.subscribe, core.getSnapshot);
        const [saves, setSaves] = useState(0);
        const part = snapshot.project.schematic.parts[0];
        window.propertiesState = {
          source: snapshot.source, revision: snapshot.revision,
          undoDepth: snapshot.undoDepth, saves,
        };
        return <>
          <button onClick={() => core.undo()}>Undo</button>
          <button onClick={() => setCore(new ProjectCore(parseProject(snapshot.source)))}>Reopen</button>
          <div className="panel"><PartProperties key={part.id + ':' + snapshot.project.id}
            part={part} spiceAvailable onSave={(reference, value, fields, includeInSimulation) => {
              core.execute('part.properties', {
                schematicId: snapshot.project.schematic.id, partId: part.id,
                reference, value,
                fields: Object.entries(fields).map(([name, value]) => ({name, value})),
              });
              if (includeInSimulation !== !part.excludeFromSimulation)
                core.execute('part.participation', {
                  schematicId: snapshot.project.schematic.id, partId: part.id,
                  included: includeInSimulation,
                });
              setSaves(count => count + 1);
              return true;
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
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const path of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(path, 'utf8') });
  await page.addStyleTag({
    content:
      '.panel {width:400px; padding:16px; margin:20px; border:1px solid #ddd; border-radius:16px;}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const state = () => page.evaluate(() => window.propertiesState);
  const component = (snapshot) => JSON.parse(snapshot.source).schematic.components[0];
  const field = (name) => page.getByLabel(name, { exact: true });
  const labels = {
    'OpenPE.SeriesResistance': 'Series resistance (Ω)',
    'OpenPE.InitialVoltage': 'Initial voltage (V)',
    'OpenPE.Coupling': 'Coupling (unitless)',
  };
  const waitFieldValue = (name, value) =>
    page.waitForFunction(
      ({ name, value }) =>
        [...document.querySelectorAll('input')].find(
          (input) => input.getAttribute('aria-label') === name,
        )?.value === value,
      { name, value },
    );
  const disclosure = page.locator('details.property-simulation');
  const ordinary = page.locator('.part-properties > .property-fields');
  const button = (name) => page.getByRole('button', { name, exact: true });
  await field('Component value').waitFor();
  const original = await state();
  assert.equal(await disclosure.getAttribute('open'), null, 'Simulation starts collapsed');
  for (const [name, label] of Object.entries(labels)) {
    assert.equal(await ordinary.getByLabel(label, { exact: true }).count(), 0);
    assert.equal(await disclosure.getByLabel(label, { exact: true }).count(), 1);
    assert.equal(await field(label).isVisible(), false);
    assert.equal(component(original).fields?.[name], undefined);
  }
  assert.deepEqual(component(original).simulation, {
    seriesResistance: '50m',
    initialVoltage: '1.2',
    coupling: '0.98',
  });
  assert.equal(
    await ordinary.getByLabel('OpenPE.Note', { exact: true }).inputValue(),
    'design note',
  );
  assert.equal(await ordinary.getByLabel('Scratch', { exact: true }).inputValue(), '2');
  assert.equal(await button('Add field').isVisible(), true);

  await disclosure.locator('summary').click();
  for (const label of Object.values(labels)) {
    const row = disclosure.locator('.property-field').filter({ has: field(label) });
    const name = row.locator('.property-parameter-name');
    assert.equal(await name.textContent(), label, 'parameter names show their unit');
    assert.equal(await name.getAttribute('title'), null);
    assert.equal(await name.evaluate((element) => element.isContentEditable), false);
    assert.equal(
      await row.locator('.property-field-name').count(),
      0,
      'known parameter names are fixed labels',
    );
    const bounds = await name.evaluate((element) => ({
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
    }));
    assert.ok(bounds.width > 0 && bounds.height > 0);
    assert.ok(
      bounds.contentWidth <= bounds.width + 1 && bounds.contentHeight <= bounds.height + 1,
      `${label} remains fully visible, including its unit`,
    );
    assert.equal(
      await button('Remove field ' + label).getAttribute('aria-label'),
      'Remove field ' + label,
    );
    await field(label).focus();
    await field(label).press('Tab');
  }
  const simulationPresentation = await disclosure.evaluate((element) =>
    [
      element.innerText,
      ...[...element.querySelectorAll('input')].map((input) => input.value),
      ...[...element.querySelectorAll('[aria-description]')].map((node) =>
        node.getAttribute('aria-description'),
      ),
      ...[...element.querySelectorAll('[aria-label]')].map((node) =>
        node.getAttribute('aria-label'),
      ),
    ].join('\n'),
  );
  assert.doesNotMatch(
    simulationPresentation,
    /OpenPE\.(?:SeriesResistance|InitialVoltage|Coupling)/,
    'committed native parameter names stay out of visible labels and accessibility text',
  );
  assert.deepEqual(await state(), original, 'unchanged simulation blurs stay clean');

  await field(labels['OpenPE.SeriesResistance']).fill('75m');
  await field(labels['OpenPE.SeriesResistance']).press('Enter');
  let edited = await state();
  assert.equal(edited.saves, 1);
  assert.equal(edited.revision, original.revision + 1);
  assert.equal(edited.undoDepth, 1, 'one parameter edit creates one undo transaction');
  assert.equal(component(edited).simulation.seriesResistance, '75m');
  assert.equal(component(edited).simulation.initialVoltage, '1.2');
  assert.equal(component(edited).simulation.coupling, '0.98');
  assert.equal(component(edited).fields['OpenPE.Note'], 'design note');
  await button('Undo').click();
  await waitFieldValue(labels['OpenPE.SeriesResistance'], '50m');
  assert.equal((await state()).source, original.source);
  assert.equal((await state()).undoDepth, 0);
  assert.equal(await field(labels['OpenPE.SeriesResistance']).inputValue(), '50m');

  const beforeRemoval = await state();
  await button('Remove field ' + labels['OpenPE.InitialVoltage']).click();
  const removed = await state();
  assert.equal(removed.saves, beforeRemoval.saves + 1);
  assert.equal(removed.undoDepth, 1, 'field removal creates one undo transaction');
  assert.equal(removed.revision, beforeRemoval.revision + 1);
  assert.equal(component(removed).simulation.initialVoltage, undefined);
  assert.equal(await field(labels['OpenPE.InitialVoltage']).count(), 0);

  const scratchNameLabel = await ordinary
    .locator('.property-field')
    .filter({ has: field('Scratch') })
    .locator('.property-field-name')
    .getAttribute('aria-label');
  const scratchName = field(scratchNameLabel);
  assert.equal(
    await scratchName.evaluate((input) => input.readOnly),
    false,
    'custom field names remain editable',
  );
  await scratchName.fill('OpenPE.InitialVoltage');
  assert.equal(
    await ordinary.getByLabel('OpenPE.InitialVoltage', { exact: true }).count(),
    1,
    'typing a simulation name keeps the row in its original group',
  );
  assert.equal(
    await scratchName.inputValue(),
    'OpenPE.InitialVoltage',
    'draft names keep their literal text until committed',
  );
  assert.equal(await scratchName.evaluate((input) => input.readOnly), false);
  assert.equal(
    await field(labels['OpenPE.InitialVoltage']).count(),
    0,
    'draft names do not adopt the parameter display label',
  );
  assert.deepEqual(await state(), removed, 'typing a field name is still an uncommitted draft');
  await scratchName.press('Enter');
  await disclosure.getByLabel(labels['OpenPE.InitialVoltage'], { exact: true }).waitFor();
  edited = await state();
  assert.equal(edited.saves, removed.saves + 1);
  assert.equal(edited.undoDepth, removed.undoDepth + 1);
  assert.equal(edited.revision, removed.revision + 1);
  assert.equal(
    await ordinary.getByLabel(labels['OpenPE.InitialVoltage'], { exact: true }).count(),
    0,
  );
  assert.equal(
    await field('OpenPE.InitialVoltage').count(),
    0,
    'committed native names are replaced by the unit-bearing label',
  );
  assert.equal(
    await disclosure.getByLabel(labels['OpenPE.InitialVoltage'], { exact: true }).inputValue(),
    '2',
  );
  assert.equal(component(edited).simulation.initialVoltage, '2');
  assert.equal(component(edited).fields.Scratch, undefined);

  await button('Undo').click();
  await ordinary.getByLabel('Scratch', { exact: true }).waitFor();
  assert.equal(
    (await state()).source,
    removed.source,
    'undo restores the previous field placement and canonical content',
  );
  assert.equal(await ordinary.getByLabel('Scratch', { exact: true }).inputValue(), '2');
  await button('Undo').click();
  await disclosure.getByLabel(labels['OpenPE.InitialVoltage'], { exact: true }).waitFor();
  assert.equal(
    (await state()).source,
    original.source,
    'undo restores a removed simulation parameter',
  );
  assert.equal(
    await disclosure.getByLabel(labels['OpenPE.InitialVoltage'], { exact: true }).inputValue(),
    '1.2',
  );

  await button('Reopen').click();
  assert.equal(
    (await state()).source,
    original.source,
    'canonical reopening preserves parameter values',
  );
  for (const [name, value] of [
    ['SeriesResistance', '50m'],
    ['InitialVoltage', '1.2'],
    ['Coupling', '0.98'],
  ])
    assert.equal(
      await disclosure.getByLabel(labels['OpenPE.' + name], { exact: true }).inputValue(),
      value,
    );
  assert.equal(
    await ordinary.getByLabel('OpenPE.Note', { exact: true }).inputValue(),
    'design note',
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/simulation-properties.png' });
  const beforeAppearance = await state();
  await page.locator('.panel').evaluate((element) => {
    element.style.width = '320px';
  });
  const compactLabels = await disclosure
    .locator('.property-parameter-name')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        text: element.textContent,
        width: element.clientWidth,
        contentWidth: element.scrollWidth,
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
      })),
    );
  assert.equal(compactLabels.length, 3);
  for (const bounds of compactLabels)
    assert.ok(
      bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.contentWidth <= bounds.width + 1 &&
        bounds.contentHeight <= bounds.height + 1,
      `${bounds.text} remains fully visible at a 320px panel width`,
    );
  assert.equal(
    await disclosure.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    'compact parameter rows do not overflow their disclosure',
  );
  await page.screenshot({ path: 'test-results/simulation-properties-compact.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: 'test-results/simulation-properties-compact-dark.png' });
  await page.locator('.panel').evaluate((element) => {
    element.style.width = '400px';
  });
  await page.screenshot({ path: 'test-results/simulation-properties-dark.png' });
  assert.deepEqual(
    await state(),
    beforeAppearance,
    'theme presentation does not mutate the document',
  );

  // Participation stays independent of the native disclosure for pointer and keyboard input.
  const participation = page.getByRole('switch', {
    name: 'Include in SPICE simulation',
    exact: true,
  });
  const waitForParticipation = (checked) =>
    page
      .getByRole('switch', { name: 'Include in SPICE simulation', exact: true, checked })
      .waitFor();
  const beforeParticipation = await state();
  assert.equal(await participation.getAttribute('aria-checked'), 'true');
  assert.equal(await disclosure.getAttribute('open'), '');
  await participation.click();
  assert.equal(await participation.getAttribute('aria-checked'), 'false');
  assert.equal(await disclosure.getAttribute('open'), '', 'switch leaves parameters expanded');
  assert.equal(component(await state()).simulation.excluded, true);
  assert.equal((await state()).undoDepth, beforeParticipation.undoDepth + 1);
  await button('Undo').click();
  await waitForParticipation(true);
  assert.equal((await state()).source, beforeParticipation.source);
  assert.equal(await participation.getAttribute('aria-checked'), 'true');

  await disclosure.locator('summary').click();
  assert.equal(await disclosure.getAttribute('open'), null);
  assert.equal(await participation.isVisible(), true);
  assert.equal((await state()).source, beforeParticipation.source);
  for (const key of ['Space', 'Enter']) {
    await participation.focus();
    await participation.press(key);
    assert.equal(await participation.getAttribute('aria-checked'), 'false');
    assert.equal(await disclosure.getAttribute('open'), null, `${key} leaves parameters collapsed`);
    assert.equal(component(await state()).simulation.excluded, true);
    assert.equal((await state()).undoDepth, beforeParticipation.undoDepth + 1);
    await button('Undo').click();
    await waitForParticipation(true);
    assert.equal((await state()).source, beforeParticipation.source);
    assert.equal(await participation.getAttribute('aria-checked'), 'true');
  }
  await page.screenshot({ path: 'test-results/simulation-properties-collapsed-switch.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Simulation parameter labels/units, grouping, stable name drafts, canonical reopen, no-op blur and atomic edit/remove/undo passed.',
  );
} finally {
  await browser.close();
}
