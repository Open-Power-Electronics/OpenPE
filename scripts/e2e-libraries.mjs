import { _electron as electron } from 'playwright';
import { readNativeProject } from './source-editor-test-helpers.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';
const { partFields } = await tsImport('../lib/library.ts', import.meta.url);
// Explicit opt-in desktop coverage. Never run as part of npm test.
const profile = path.resolve('test-results', `libraries-${Date.now()}`);
await mkdir(profile, { recursive: true });
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, OPENPE_TEST: '1', OPENPE_DATA_DIR: profile, OPENPE_DEV_URL: '' },
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.getByRole('button', { name: 'New project', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add component', exact: true }).click();
  await page.getByLabel('Search components', { exact: true }).fill('Device:R');
  await page.waitForFunction(() => !document.querySelector('.dialog-button.primary')?.disabled);
  await page.getByLabel('Search components', { exact: true }).press('Enter');
  const canvas = page.getByTestId('schematic-canvas'),
    bounds = await canvas.boundingBox();
  await page.mouse.click(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.45);
  await page.getByRole('button', { name: 'Browse footprints', exact: true }).click();
  await page
    .getByLabel('Search footprints', { exact: true })
    .fill('Resistor_SMD:R_0805_2012Metric');
  await page
    .locator('.library-results button')
    .filter({ has: page.getByText('R_0805_2012Metric', { exact: true }) })
    .click();
  await page.getByRole('button', { name: '3D model', exact: true }).click();
  await page.locator('.model-preview [role="status"]').waitFor({ state: 'hidden', timeout: 60000 });
  await page.locator('.model-preview canvas').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Assign footprint', exact: true }).click();
  assert.equal(
    await page.getByLabel('Footprint', { exact: true }).inputValue(),
    'Resistor_SMD:R_0805_2012Metric',
  );
  await page.getByLabel('Component value', { exact: true }).fill('4.7k');
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.locator('.property-field').last().locator('input').first().fill('Tolerance');
  await page.getByLabel('Tolerance', { exact: true }).fill('1%');
  await page.getByLabel('Tolerance', { exact: true }).press('Enter');
  const readProject = async () => {
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const project = await readNativeProject(page);
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    return project;
  };
  const saved = await readProject();
  assert.equal(saved.schematic.parts[0].libId, 'Device:R');
  assert.equal(partFields(saved.schematic.parts[0]).Tolerance, '1%');
  assert.equal(saved.schematic.parts[0].value, '4.7k');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal((await readProject()).schematic.parts[0].value, 'R');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Redo', exact: true }).click();
  assert.deepEqual(await readProject(), saved);
  await page.getByRole('button', { name: 'Wire', exact: true }).click();
  await page.mouse.click(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.7);
  await page.mouse.click(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.8);
  await page.keyboard.press('/');
  await page.mouse.click(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.7);
  await page.keyboard.press('Enter');
  const wired = await readProject();
  assert.ok(wired.schematic.wires.length >= 2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(
    (await readProject()).schematic.wires.length,
    0,
    'A continuous route is one transaction.',
  );
  console.log(
    'PASS: official symbol placement, bundled footprint search, independent STEP preview, fields, undo/redo and continuous wire routing.',
  );
} finally {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
  );
  await app.close();
}
