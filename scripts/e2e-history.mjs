// Opt-in desktop coverage. Run only at the user's explicit request, after build.
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileMenuAction } from './file-menu-test-helpers.mjs';
import { readSource, fillSource, projectHistory } from './source-editor-test-helpers.mjs';
import { parseProject, projectFromNativeFiles, projectNativeFiles } from '../server/project-format.mjs';
import { formatTestProjectSource } from './format-test-project.mjs';

const dir = path.resolve('test-results', 'history-' + Date.now());
await mkdir(dir, { recursive: true });
const nativeDir = path.join(dir, 'design');
await mkdir(nativeDir);
const names = ['circuit.kicad_pro', 'circuit.kicad_sch', 'circuit.kicad_pcb'];
const fixture = parseProject(formatTestProjectSource());
for (const footprint of fixture.pcb.footprints) {
  const part = fixture.schematic.parts.find((part) => part.id === footprint.symbolId);
  (part.fields ??= {}).Footprint = footprint.libraryId;
}
for (const net of fixture.pcb.nets) {
  if (net.name === '/IN' || net.name === '/OUT') net.name = net.name.slice(1);
}
const initialFiles = Object.fromEntries(
  projectNativeFiles(fixture, names[0]).files.map(({ name, source }) => [name, source]),
);
initialFiles[names[0]] = JSON.stringify({
  ...JSON.parse(initialFiles[names[0]]),
  text_variables: { NOTE: 'Retain this setting' },
}) + '\n';
const nativeProject = (files) =>
  projectFromNativeFiles({
    entry: names[0],
    files: Object.entries(files).map(([name, source]) => ({ name, source })),
  });
nativeProject(initialFiles);
await Promise.all(
  Object.entries(initialFiles).map(([name, source]) =>
    writeFile(path.join(nativeDir, name), source),
  ),
);
const file = path.join(nativeDir, names[0]);
const diskFiles = async () =>
  Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(path.join(nativeDir, name), 'utf8')]),
    ),
  );
const application = await electron.launch({
  ...(process.env.OPENPE_EXECUTABLE
    ? { executablePath: process.env.OPENPE_EXECUTABLE, args: [] }
    : { args: ['.'] }),
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DATA_DIR: path.join(dir, 'profile'),
    OPENPE_DEV_URL: '',
  },
});
try {
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const button = (name) => page.getByRole('button', { name, exact: true });
  const history = page.getByRole('region', { name: 'Git', exact: true });
  const selectFile = async (name) =>
    page
      .getByRole('navigation', { name: 'Project files', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
  const sourceFiles = async () => {
    const files = {};
    for (const name of names) {
      await selectFile(name);
      files[name] = await readSource(page);
    }
    return files;
  };
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await button('Open project').click();
  await page.getByTestId('schematic-canvas').waitFor();
  await button('Git').click();
  await history.getByText('No versions yet.', { exact: true }).waitFor();
  await history.getByLabel('Commit message').fill('Initial design');
  await button('Commit').click();
  await history.getByText('Version created.', { exact: true }).waitFor();
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  if (await history.isVisible())
    await page
      .getByRole('dialog', { name: 'Git', exact: true })
      .getByRole('button', { name: 'Close dialog' })
      .click();
  await button('Source').click();
  const first = await sourceFiles();
  assert.deepEqual(first, initialFiles, 'Opening native files preserves their original bytes.');
  const next = {
    ...first,
    [names[0]]:
      JSON.stringify(
        { ...JSON.parse(first[names[0]]), text_variables: { NOTE: 'Complete project revision' } },
        null,
        2,
      ) + '\n',
    [names[1]]: first[names[1]].replace('(property "Value" "1k"', '(property "Value" "4.7k"'),
    [names[2]]: first[names[2]].replace('(thickness 1.6)', '(thickness 2)'),
  };
  const expected = nativeProject(next);
  assert.equal(expected.schematic.parts.find((part) => part.ref === 'R1').value, '4.7k');
  assert.equal(expected.pcb.thickness, 2);
  for (const name of names) {
    await selectFile(name);
    await fillSource(page, next[name]);
  }
  await button('Apply').click();
  const applied = await sourceFiles();
  await button('Git').click();
  await history
    .getByRole('navigation', { name: 'Changed files' })
    .getByRole('button')
    .first()
    .waitFor();
  await history.getByLabel('Commit message').fill('Tune resistor');
  await button('Commit').click();
  await history.getByText('Version created.', { exact: true }).waitFor();
  assert.deepEqual(
    await diskFiles(),
    initialFiles,
    'Creating a version never writes the native destination.',
  );
  await history
    .getByRole('navigation', { name: 'Project versions', exact: true })
    .getByRole('button')
    .filter({ hasText: 'Initial design' })
    .click();
  await history.getByRole('button', { name: `Modified · ${names[1]}`, exact: true }).hover();
  await button(`Restore ${names[1]}`).click();
  await history.getByText('File restored. Save to write it to disk.', { exact: true }).waitFor();
  if (await history.isVisible())
    await page
      .getByRole('dialog', { name: 'Git', exact: true })
      .getByRole('button', { name: 'Close dialog' })
      .click();
  await button('Source').click();
  assert.deepEqual(await sourceFiles(), { ...applied, [names[1]]: first[names[1]] });
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  await projectHistory(page, 'Undo');
  assert.deepEqual(await sourceFiles(), applied, 'One undo reverses the selected file restoration.');
  await selectFile(names[1]);
  await fillSource(page, '(kicad_sch (unfinished');
  await button('Git').click();
  assert.equal(await history.isVisible(), false);
  assert.equal(await button('Source').getAttribute('aria-pressed'), 'true');
  assert.equal(await readSource(page), '(kicad_sch (unfinished');
  await fillSource(page, applied[names[1]]);
  if (await button('Apply').isEnabled()) await button('Apply').click();
  await fileMenuAction(page, 'Save');
  await page.getByRole('status').filter({ hasText: 'Save project' }).waitFor();
  assert.deepEqual(await diskFiles(), applied);
  await fileMenuAction(page, 'Close project');
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  await button('Open project').click();
  await page.getByTestId('schematic-canvas').waitFor();
  await button('Git').click();
  await history.getByLabel('0 changed files', { exact: true }).waitFor();
  assert.equal(await history.locator('.history-entries > button').count(), 3);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: actual Git, native KiCad grants and bytes, complete multi-file restore/undo, draft protection, explicit save and reopened history.',
  );
} catch (error) {
  const page = application.windows()[0];
  if (page) {
    await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
    await writeFile(path.join(dir, 'failure.txt'), await page.locator('body').innerText()).catch(
      () => {},
    );
  }
  throw error;
} finally {
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await application.close().catch(() => {});
}
