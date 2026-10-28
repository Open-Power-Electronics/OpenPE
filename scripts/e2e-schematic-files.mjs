import { projectFromNativeFiles } from '../server/project-format.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { fileMenuAction } from './file-menu-test-helpers.mjs';
// Opt-in desktop coverage. Build first; run only on explicit request.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  fillSource,
  readSource,
  readNativeFiles,
  readNativeProject,
  fillNativeProject,
  selectSourceFile,
} from './source-editor-test-helpers.mjs';

const dir = path.resolve('test-results', `schematic-files-${Date.now()}`);
await mkdir(dir, { recursive: true });
const nativeDir = path.join(dir, 'design');
await mkdir(nativeDir);
const file = path.join(nativeDir, 'multi-file.kicad_pro');
const exported = path.join(dir, 'secondary.kicad_sch');
const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DEV_URL: '',
    OPENPE_DATA_DIR: path.join(dir, 'profile'),
  },
});
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const button = (name) => page.getByRole('button', { name, exact: true });
  const tabs = () => page.getByRole('tablist', { name: 'Schematic files', exact: true });
  const projectTabs = () => page.getByRole('tablist', { name: 'Project', exact: true });
  const projects = () => page.getByRole('group', { name: 'Open projects', exact: true });
  await button('New project').click();
  await projectTabs().getByRole('tab', { name: 'Untitled project', exact: true }).waitFor();
  await button('Source').click();
  const blankNative = await readNativeFiles(page);
  assert.deepEqual(blankNative.files.map((file) => file.name).sort(), [
    'untitled.kicad_pcb',
    'untitled.kicad_pro',
    'untitled.kicad_sch',
  ]);
  const blankProject = projectFromNativeFiles(blankNative);
  assert.ok(blankProject.pcb);
  assert.deepEqual(blankProject.pcb.graphics, []);
  assert.deepEqual(blankProject.extensions['org.openpe.model-cad'], { version: 1, objects: [] });
  for (const [name, view] of [
    ['Layout', 'layout'],
    ['Model', '3d'],
    ['Source', 'source'],
  ]) {
    await button(name).click();
    await page.locator(`.editor[data-editor-view="${view}"]`).waitFor();
    assert.equal(await projectTabs().getByRole('tab').innerText(), 'Untitled project');
    if (view === '3d') {
      await page.locator('.pcb-model-preview canvas').waitFor();
      assert.equal(
        await page.getByText('No PCB layout in this project.', { exact: true }).count(),
        0,
      );
    }
    await button('Schematic').click();
    await page.getByTestId('schematic-canvas').waitFor();
    assert.equal(await page.locator('.editor').getAttribute('data-editor-view'), 'canvas');
  }
  const originalProjectId = await projects()
    .locator('[data-project-id]')
    .getAttribute('data-project-id');
  await button('New file').click();
  await tabs()
    .getByRole('tab', { name: /^Schematic 2,/ })
    .waitFor();
  assert.equal(await projects().getByRole('button').count(), 1);
  assert.equal(
    await projects().locator('[data-project-id]').getAttribute('data-project-id'),
    originalProjectId,
  );
  assert.equal(await tabs().getByRole('tab').count(), 2);
  await button('Source').click();
  const initialNative = await readNativeFiles(page);
  const secondaryFilename = initialNative.files.filter((item) =>
    item.name.endsWith('.kicad_sch'),
  )[1].name;
  const draft = await readNativeProject(page);
  draft.schematic.title = 'Input stage';
  draft.additionalSchematics[0].title = 'Output stage';
  const wireId = crypto.randomUUID();
  draft.additionalSchematics[0].wires.push({ id: wireId, a: { x: 0, y: 0 }, b: { x: 12.7, y: 0 } });
  await fillNativeProject(page, draft);
  await button('Apply').click();
  await selectSourceFile(page, secondaryFilename);
  const canonical = await readSource(page);
  await button('Schematic').click();
  await button('Zoom in').click();
  const secondView = await page.getByTestId('schematic-canvas').getAttribute('viewBox');
  await tabs()
    .getByRole('tab', { name: /^Input stage/ })
    .click();
  await tabs()
    .getByRole('tab', { name: /^Output stage/ })
    .click();
  assert.equal(await page.getByTestId('schematic-canvas').getAttribute('viewBox'), secondView);
  assert.equal(await projects().getByRole('button').count(), 1);
  await button('Source').click();
  assert.equal(await readSource(page), canonical);
  await fillSource(page, '{unfinished');
  await tabs()
    .getByRole('tab', { name: /^Output stage/ })
    .click();
  assert.equal(await page.locator('.editor').getAttribute('data-editor-view'), 'source');
  assert.equal(await readSource(page), '{unfinished');
  await tabs()
    .getByRole('tab', { name: /^Output stage/ })
    .hover();
  await tabs().getByRole('button', { name: 'Close Output stage', exact: true }).click();
  assert.equal(await tabs().getByRole('tab').count(), 2);
  assert.equal(await readSource(page), '{unfinished');
  await button('New file').click();
  assert.equal(await tabs().getByRole('tab').count(), 2);
  assert.equal(await readSource(page), '{unfinished');
  await tabs()
    .getByRole('tab', { name: /^Input stage/ })
    .click();
  assert.equal(await tabs().getByRole('tab', { selected: true }).innerText(), 'Output stage');
  assert.equal(await readSource(page), '{unfinished');
  await fillSource(page, canonical);
  await button('Schematic').click();
  await app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  }, file);
  await fileMenuAction(page, 'Save');
  await page.getByRole('status').filter({ hasText: 'Save project' }).waitFor();
  const diskFiles = async () => ({
    entry: 'multi-file.kicad_pro',
    files: await Promise.all(
      ['multi-file.kicad_pro', 'multi-file.kicad_sch', secondaryFilename].map(async (name) => ({
        name,
        source: await readFile(path.join(nativeDir, name), 'utf8'),
      })),
    ),
  });
  const savedFiles = await diskFiles();
  const saved = projectFromNativeFiles(savedFiles);
  assert.equal(saved.name, 'multi-file');
  assert.equal(saved.schematic.title, 'Input stage');
  assert.equal(saved.additionalSchematics[0].title, 'Output stage');
  assert.equal(saved.additionalSchematics[0].wires.length, 1);
  assert.equal(await tabs().locator('.dirty-dot').count(), 0);
  const outputTab = tabs().getByRole('tab', { name: 'Output stage', exact: true });
  await outputTab.hover();
  await tabs().getByRole('button', { name: 'Close Output stage', exact: true }).click();
  assert.equal(await tabs().getByRole('tab').count(), 1);
  assert.equal(await tabs().getByRole('tab', { selected: true }).innerText(), 'Input stage');
  assert.equal(await projects().locator('.dirty-dot').count(), 0);
  await page.getByRole('combobox', { name: 'Open file', exact: true }).click();
  await page.getByRole('option', { name: 'Output stage', exact: true }).click();
  assert.equal(await tabs().getByRole('tab').count(), 2);
  assert.equal(await projects().locator('.dirty-dot').count(), 0);
  await button('Source').click();
  await selectSourceFile(page, secondaryFilename);
  assert.equal(await readSource(page), canonical);
  await button('Schematic').click();
  await tabs().getByRole('tab', { name: 'Input stage', exact: true }).click();
  await tabs().getByRole('tab', { name: 'Output stage', exact: true }).click();
  assert.equal(
    await projects().locator('.dirty-dot').count(),
    0,
    'Switching files does not dirty the project.',
  );
  await button('New file').click();
  assert.equal(await tabs().getByRole('tab').count(), 3);
  await button('Undo').click();
  assert.equal(await tabs().getByRole('tab').count(), 2);
  assert.equal(await projects().locator('.dirty-dot').count(), 0);
  await button('Redo').click();
  assert.equal(await tabs().getByRole('tab').count(), 3);
  await button('Undo').click();
  await tabs().getByRole('tab', { name: 'Output stage', exact: true }).click();
  await waitForAsync(
    page,
    async (wireId) => {
      const c = await window.openpe.connection();
      const state = await (
        await fetch(c.base + '/api/state', {
          cache: 'no-store',
          headers: { 'X-OpenPE-Token': c.token },
        })
      ).json();
      const project = JSON.parse(state.documents[0].source);
      return (
        state.documents[0].filename === 'multi-file.kicad_pro' &&
        !state.documents[0].dirty &&
        project.schematic.name === 'Input stage' &&
        project.additionalSchematics[0].schematic.name === 'Output stage' &&
        JSON.stringify(project).includes(wireId) &&
        state.documents[0].activeSchematicId === project.additionalSchematics[0].schematic.id
      );
    },
    wireId,
  );
  await page.reload();
  await tabs().getByRole('tab', { name: 'Output stage', selected: true, exact: true }).waitFor();
  assert.equal(await projects().getByRole('button').count(), 1);
  assert.equal(await tabs().locator('.dirty-dot').count(), 0);
  await app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  }, exported);
  await fileMenuAction(page, 'Export');
  await page.getByText('Exported KiCad schematic', { exact: true }).waitFor();
  const native = await readFile(exported, 'utf8');
  assert.match(native, new RegExp(saved.additionalSchematics[0].id));
  assert.doesNotMatch(native, new RegExp(saved.schematic.id));
  await tabs().getByRole('button', { name: 'Close Input stage', exact: true }).click();
  await tabs().getByRole('button', { name: 'Close Output stage', exact: true }).click();
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  assert.deepEqual(
    await diskFiles(),
    savedFiles,
    'Closing the final tab retains the saved project and every schematic.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: native multi-schematic Source, independent tabs/viewports, draft gates, atomic undo, save/recovery, selected-sheet export and tab close preservation.',
  );
} catch (error) {
  const page = app.windows()[0];
  if (page) {
    await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
    await writeFile(path.join(dir, 'failure.txt'), await page.locator('body').innerText()).catch(
      () => {},
    );
  }
  throw error;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
