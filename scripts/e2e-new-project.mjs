// Opt-in desktop coverage. Build first; launch only with explicit user authorization.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { projectFromNativeFiles } from '../server/project-format.mjs';
import { fileMenuAction } from './file-menu-test-helpers.mjs';
import {
  exerciseNewProjectDesign,
  assertNewProjectDesign,
  captureReopenedDesign,
} from './new-project-design-test-helpers.mjs';
import {
  fillSource,
  readNativeFiles,
  readSource,
  selectSourceFile,
} from './source-editor-test-helpers.mjs';

const dir = path.resolve('test-results', `new-project-${Date.now()}`);
const design = path.join(dir, 'design');
const copy = path.join(dir, 'copy');
await mkdir(design, { recursive: true });
await mkdir(copy);
const destination = path.join(design, 'New circuit.kicad_pro');
const copyDestination = path.join(copy, 'Copied circuit.kicad_pro');
const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DEV_URL: '',
    OPENPE_DATA_DIR: path.join(dir, 'profile'),
  },
});
const evidence = { directory: dir, steps: [] };
let freshApp;
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const button = (name) => page.getByRole('button', { name, exact: true });
  const clean = async () =>
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  const changed = async () =>
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  const source = async () => {
    await button('Source').click();
    return readNativeFiles(page);
  };
  const disk = async (bundle, directory) => ({
    entry: bundle.entry,
    files: await Promise.all(
      bundle.files.map(async (file) => ({
        name: file.name,
        source: await readFile(path.join(directory, file.name), 'utf8'),
      })),
    ),
  });
  const picker = async (file) =>
    app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () =>
        filePath ? { canceled: false, filePath } : { canceled: true };
    }, file);
  const save = async (action = 'Save') => {
    await fileMenuAction(page, action);
    await page.getByRole('status').filter({ hasText: 'Save project' }).waitFor();
    await clean();
  };
  const open = async (file) => {
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, file);
    await button('Open project').click();
    await page.getByTestId('schematic-canvas').waitFor();
  };
  const close = async () => {
    await fileMenuAction(page, 'Close project');
    await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  };
  const step = (name) => {
    evidence.steps.push(name);
    console.log(`PASS: ${name}`);
  };

  await button('New project').click();
  await page.getByTestId('schematic-canvas').waitFor();
  await clean();
  const blank = await source();
  assert.deepEqual(blank.files.map((file) => file.name).sort(), [
    'untitled.kicad_pcb',
    'untitled.kicad_pro',
    'untitled.kicad_sch',
  ]);
  const initial = projectFromNativeFiles(blank);
  assert.equal(initial.name, 'Untitled project');
  assert.equal(initial.schematic.parts.length, 0);
  assert.ok(initial.pcb);
  assert.deepEqual(initial.extensions['org.openpe.model-cad'], { version: 1, objects: [] });
  for (const name of ['Layout', 'Model', 'Source']) {
    await button(name).click();
    await clean();
  }
  assert.deepEqual(await readNativeFiles(page), blank);
  step('Create a complete clean blank project; view switches preserve native files');

  await button('Schematic').click();
  await button('Add component').click();
  await page.getByLabel('Search components', { exact: true }).fill('Device:R');
  await page
    .locator('.library-results button')
    .filter({ has: page.getByText('R', { exact: true }) })
    .click();
  await button('Place').click();
  const canvas = await page.getByTestId('schematic-canvas').boundingBox();
  assert.ok(canvas);
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.keyboard.press('Escape');
  await page.getByTestId('part-R1').click();
  const value = page.getByLabel('Component value', { exact: true });
  await value.fill('4.7k');
  await value.press('Enter');
  await changed();
  await button('Undo').click();
  await button('Redo').click();
  await exerciseNewProjectDesign(page, step);
  const edited = await source();
  assert.equal(projectFromNativeFiles(edited).schematic.parts[0].value, '4.7k');
  step('Place a library resistor on the blank canvas, edit its value, undo and redo');

  await picker(null);
  await fileMenuAction(page, 'Save');
  await changed();
  assert.deepEqual(await readNativeFiles(page), edited);
  await picker(destination);
  await save();
  const saved = await readNativeFiles(page);
  assert.equal(saved.entry, 'New circuit.kicad_pro');
  assert.deepEqual(await disk(saved, design), saved);
  step('Cancel first Save without losing edits, then save the complete native file set');

  await close();
  await open(destination);
  await clean();
  assert.deepEqual(await source(), saved);
  assertNewProjectDesign(projectFromNativeFiles(saved));
  await button('Schematic').click();
  await open(destination);
  assert.equal(await page.locator('.project-navigation .project-folder').count(), 1);
  await page.getByTestId('part-R1').click();
  await value.fill('10k');
  await value.press('Enter');
  // An existing destination must save without invoking a new picker.
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => {
      throw new Error('Unexpected Save picker');
    };
  });
  await save();
  const resaved = await source();
  assert.equal(projectFromNativeFiles(resaved).schematic.parts[0].value, '10k');
  assert.deepEqual(await disk(resaved, design), resaved);
  step('Close and reopen exact saved files, deduplicate repeated Open, edit and Save in place');

  await selectSourceFile(page, 'New circuit.kicad_sch');
  const valid = await readSource(page);
  await fillSource(page, '(kicad_sch (unfinished');
  await fileMenuAction(page, 'Save');
  await page
    .getByRole('status')
    .filter({ hasText: 'Fix the source errors before saving' })
    .waitFor();
  assert.deepEqual(await disk(resaved, design), resaved);
  await changed();
  await fillSource(page, valid);
  await button('Schematic').click();
  await clean();
  step('Invalid native Source blocks Save and preserves the previously saved files');

  await picker(copyDestination);
  await save('Save as');
  const copied = await source();
  assert.equal(copied.entry, 'Copied circuit.kicad_pro');
  assert.deepEqual(await disk(copied, copy), copied);
  assert.deepEqual(await disk(resaved, design), resaved);
  await close();
  await open(copyDestination);
  await clean();
  assert.deepEqual(await source(), copied);
  assert.equal(projectFromNativeFiles(copied).schematic.parts[0].value, '10k');
  evidence.design = await captureReopenedDesign(page, dir, copied);
  step(
    'Reopen every saved design view and retain exact wires, package poses, routed copper, outline and Model parameters',
  );
  await page.screenshot({ path: path.join(dir, 'reopened-source.png') });
  await close();
  assert.deepEqual(errors, []);
  step('Save as a separate native project and reopen it without changing the original');

  await app.evaluate(({ app }) => app.exit(0));
  await app.close();
  freshApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPENPE_TEST: '1',
      OPENPE_DEV_URL: '',
      OPENPE_DATA_DIR: path.join(dir, 'fresh-profile'),
    },
  });
  const freshPage = await freshApp.firstWindow();
  freshPage.setDefaultTimeout(30_000);
  const freshErrors = [];
  freshPage.on('pageerror', (error) => freshErrors.push(error.message));
  await freshApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await freshPage.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  assert.equal(await freshPage.locator('.project-navigation .project-folder').count(), 0);
  await freshApp.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, copyDestination);
  await freshPage.getByRole('button', { name: 'Open project', exact: true }).click();
  await freshPage.getByTestId('schematic-canvas').waitFor();
  assert.deepEqual(await captureReopenedDesign(freshPage, dir, copied), evidence.design);
  assert.equal(await freshPage.locator('.project-navigation .dirty-dot').count(), 0);
  assert.deepEqual(freshErrors, []);
  step(
    'A fresh Electron process and empty profile reopen the complete native design without recovery or old editor caches',
  );
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error.stack;
  const page = freshApp?.windows()[0] ?? app.windows()[0];
  if (page) {
    await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
    await writeFile(path.join(dir, 'failure.txt'), await page.locator('body').innerText()).catch(
      () => {},
    );
  }
  throw error;
} finally {
  await writeFile(path.join(dir, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  if (freshApp) {
    await freshApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await freshApp.close().catch(() => {});
  }
  console.log(`Evidence: ${dir}`);
}
