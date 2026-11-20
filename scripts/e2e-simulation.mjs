import { tsImport } from 'tsx/esm/api';
const { switchingStageSource } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const { buildSpiceDeck } = await tsImport(
  '../plugins/spice-simulation/domain/spice.ts',
  import.meta.url,
);
// Run only when desktop testing is explicitly requested. Waveforms here are test fixtures.
import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  readNativeFiles,
  readNativeProject,
  selectSourceFile,
  readSource,
  fillSource,
} from './source-editor-test-helpers.mjs';

const directory = path.resolve('test-results', `simulation-${Date.now()}`);
const designDirectory = path.join(directory, 'design');
await mkdir(designDirectory, { recursive: true });
const fixturePath = path.join(designDirectory, 'switching-stage.kicad_sch');
await writeFile(fixturePath, switchingStageSource());
const application = await electron.launch({
  ...(process.env.OPENPE_EXECUTABLE
    ? { executablePath: process.env.OPENPE_EXECUTABLE, args: [] }
    : { args: ['.'] }),
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DATA_DIR: path.join(directory, 'profile'),
    OPENPE_DEV_URL: '',
  },
});
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, fixturePath);
  await button('Open project').click();
  await button('Source').click();
  const beforeFiles = await readNativeFiles(page);
  const beforeProject = await readNativeProject(page);
  await selectSourceFile(
    page,
    beforeFiles.files.find((file) => file.name.endsWith('.kicad_sch')).name,
  );
  const before = await readSource(page);
  await fillSource(page, '{invalid');
  await button('Schematic').click();
  assert.equal(await page.getByTestId('schematic-canvas').isVisible(), false);
  await fillSource(page, before);
  if (await button('Apply').isEnabled()) await button('Apply').click();
  await button('Schematic').click();
  await page.route('**/api/simulation/status', (route) =>
    route.fulfill({ json: { available: true, version: 'test fixture' } }),
  );
  await page.route('**/api/simulation/result', (route) =>
    route.fulfill({ json: { result: null } }),
  );
  let requests = 0;
  await page.route('**/api/simulation/transient', async (route) => {
    const payload = route.request().postDataJSON();
    assert.equal(payload.config.duty, 50);
    requests++;
    const deck = buildSpiceDeck(parseProject(payload.source).schematic, payload.config);
    assert.deepEqual(
      deck,
      buildSpiceDeck(beforeProject.schematic, payload.config),
      'The request compiles the circuit read from the native Source files.',
    );
    await route.fulfill({
      json: {
        version: 'test fixture',
        time: [0, 0.001, 0.002],
        traces: deck.traces.map((trace) => ({
          ...trace,
          values: trace.unit === 'V' ? [0, 12, 11.8] : [0, 1.3, 1.2],
        })),
        log: 'Controlled UI test fixture; not solver output.',
      },
    });
  });
  await button('SPICE Simulation').click();
  const settings = page.getByRole('region', { name: 'Simulation settings' });
  await settings.waitFor();
  await button('Run').click();
  assert.equal(await settings.isVisible(), true);
  const waveforms = page.getByRole('region', { name: 'Simulation waveforms' });
  assert.equal(await waveforms.count(), 0);
  await page.getByTestId('symbol-hit-L1').click({ force: true });
  await waveforms.getByText('I(L1)', { exact: true }).waitFor();
  assert.equal(requests, 1);
  const cursor = waveforms.getByRole('slider', { name: /cursor A$/ }).first();
  const cursorB = waveforms.getByRole('slider', { name: /cursor B$/ }).first();
  assert.equal(await waveforms.getByRole('slider').count(), 0);
  await waveforms.getByRole('button', { name: 'Cursor A', exact: true }).click();
  assert.equal(await cursorB.count(), 0);
  await waveforms.getByRole('button', { name: 'Cursor B', exact: true }).click();
  const initialB = await cursorB.getAttribute('aria-valuenow');
  await cursor.focus();
  await cursor.press('Home');
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), initialB);
  await cursorB.press('Home');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0');
  await cursorB.press('End');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), initialB);
  await button('SPICE Simulation').click();
  await page.getByLabel('Duration (ms)', { exact: true }).fill('0');
  assert.equal(await cursor.count(), 1, 'Changing settings retains completed waveforms.');
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), initialB);
  assert.equal(await button('Run').isDisabled(), true);
  assert.equal(await settings.locator('.simulation-settings-footer [role="alert"]').count(), 1);
  await button('Interaction mode').click();
  assert.equal(await settings.isVisible(), true);
  await button('Close simulation settings').click();
  assert.equal(await settings.isVisible(), false);
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    beforeFiles,
    'Simulation leaves project data unchanged.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Simulation UI: source validation, request snapshot, cursor, setup-edit result retention, footer validation errors, mode switching and project preservation passed.',
  );
} finally {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    })
    .catch(() => {});
  await application.close();
}
