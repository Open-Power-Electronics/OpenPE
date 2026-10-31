// Opt-in desktop coverage. Run only at the user's explicit request, after build.
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileMenuAction } from './file-menu-test-helpers.mjs';
import { readSource, fillSource, projectHistory } from './source-editor-test-helpers.mjs';
import { projectFromNativeFiles } from '../server/project-format.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { observeWorkspaceRecovery } from './workspace-recovery-test-helpers.mjs';

const dir = path.resolve('test-results', 'project-' + Date.now());
await mkdir(dir, { recursive: true });
const nativeDir = path.join(dir, 'design');
await mkdir(nativeDir);
const names = ['combined.kicad_pro', 'combined.kicad_sch', 'combined.kicad_pcb'];
const initialFiles = {
  [names[0]]:
    '{"meta":{"filename":"combined.kicad_pro"},"text_variables":{"NOTE":"Preserve native settings"}}\n',
  [names[1]]: await readFile('tests/fixtures/rc-filter.kicad_sch', 'utf8'),
  [names[2]]: await readFile('tests/fixtures/rc-filter.kicad_pcb', 'utf8'),
};
const nativeProject = (files, entry = names[0]) =>
  projectFromNativeFiles({
    entry,
    files: Object.entries(files).map(([name, source]) => ({ name, source })),
  });
const initial = nativeProject(initialFiles);
await Promise.all(
  Object.entries(initialFiles).map(([name, source]) =>
    writeFile(path.join(nativeDir, name), source),
  ),
);
const file = path.join(nativeDir, names[0]);
const diskFiles = async (directory = nativeDir, stem = 'combined') =>
  Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const target = name.replace('combined', stem);
        return [target, await readFile(path.join(directory, target), 'utf8')];
      }),
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
const recoveryTrace = [];
let recoveryObserver;
try {
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  recoveryObserver = await observeWorkspaceRecovery(application, page, path.join(dir, 'profile'));
  const button = (name) => page.getByRole('button', { name, exact: true });
  const toast = (text) => page.getByRole('status').filter({ hasText: text }).waitFor();
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
  await toast('Project opened');
  await button('Source').click();
  assert.deepEqual(
    await sourceFiles(),
    initialFiles,
    'Native opening retains every original text file byte-for-byte.',
  );
  await button('Schematic').click();
  await page.getByTestId('part-R1').click();
  await page.getByLabel('Component value', { exact: true }).fill('2k');
  await page.getByLabel('Component value', { exact: true }).press('Enter');
  await button('Source').click();
  const beforeSource = await sourceFiles();
  assert.equal(
    nativeProject(beforeSource).schematic.parts.find((part) => part.ref === 'R1').value,
    '2k',
  );
  assert.equal(beforeSource[names[0]], initialFiles[names[0]]);
  await projectHistory(page, 'Undo');
  assert.deepEqual(await sourceFiles(), initialFiles);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await projectHistory(page, 'Redo');
  assert.deepEqual(await sourceFiles(), beforeSource);
  await selectFile(names[1]);
  const editor = page.getByRole('textbox', { name: 'Project file source', exact: true });
  await editor.focus();
  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('End');
  // Both ends of the short version pair remain in CodeMirror's rendered viewport.
  await page.locator('.cm-matchingBracket').first().waitFor();
  assert.equal(await page.locator('.cm-matchingBracket').count(), 2);
  await editor.press('Home');
  await editor.press('Tab');
  assert.equal(
    (await readSource(page)).split('\n')[1],
    '  ' + beforeSource[names[1]].split('\n')[1],
  );
  await editor.press('Control+z');
  assert.equal(await readSource(page), beforeSource[names[1]]);
  const fromSource = {
    ...beforeSource,
    [names[1]]: beforeSource[names[1]].replace('(property "Value" "2k"', '(property "Value" "3k"'),
    [names[2]]: beforeSource[names[2]].replace('(thickness 1.6)', '(thickness 2)'),
  };
  assert.equal(
    nativeProject(fromSource).schematic.parts.find((part) => part.ref === 'R1').value,
    '3k',
  );
  for (const name of [names[1], names[2]]) {
    await selectFile(name);
    await fillSource(page, fromSource[name]);
  }
  await button('Apply').click();
  const applied = await sourceFiles();
  assert.equal(nativeProject(applied).pcb.thickness, 2);
  await projectHistory(page, 'Undo');
  assert.deepEqual(
    await sourceFiles(),
    beforeSource,
    'Multi-file Apply is one whole-project undo edit.',
  );
  await projectHistory(page, 'Redo');
  assert.deepEqual(await sourceFiles(), applied);
  await projectHistory(page, 'Undo');
  for (const invalid of [
    '(kicad_sch (unfinished',
    beforeSource[names[1]].replace('(version 20260306)', '(version 99999999)'),
  ]) {
    await selectFile(names[1]);
    await fillSource(page, invalid);
    await selectFile(names[0]);
    assert.equal(
      await readSource(page),
      beforeSource[names[0]],
      'Another file remains inspectable while a draft is invalid.',
    );
    await selectFile(names[1]);
    assert.equal(await readSource(page), invalid);
    await button('Schematic').click();
    await page.locator('.source-editor-error').waitFor();
    await fileMenuAction(page, 'Save');
    await toast('Fix the source errors before saving');
    assert.deepEqual(await diskFiles(), initialFiles, 'Invalid native drafts never reach disk.');
  }
  await fillSource(page, beforeSource[names[1]]);
  await button('Schematic').click();
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await fileMenuAction(page, ['Export', 'BOM']);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  const exportDir = path.join(dir, 'exports');
  await mkdir(exportDir);
  for (const [label, header] of [
    ['BOM', 'Comment'],
    ['CPL', 'Designator'],
  ]) {
    const destination = path.join(
      exportDir,
      label === 'BOM' ? 'bom.csv' : 'positions.csv',
    );
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await fileMenuAction(page, ['Export', label]);
    await toast('Exported ' + label);
    assert.ok((await readFile(destination, 'utf8')).startsWith('"' + header + '",'));
    assert.equal(
      await page.locator('.project-navigation .dirty-dot').count(),
      1,
      'Export retains unsaved state.',
    );
  }
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => {
      throw new Error('Unexpected Save picker after export');
    };
  });
  await button('Source').click();
  const expectedSaved = await sourceFiles();
  assert.equal(
    nativeProject(expectedSaved).schematic.parts.find((part) => part.ref === 'R1').value,
    '2k',
  );
  assert.equal(expectedSaved[names[0]], initialFiles[names[0]]);
  assert.equal(expectedSaved[names[2]], beforeSource[names[2]]);
  await writeFile(
    path.join(dir, 'expected-save-native.json'),
    JSON.stringify(expectedSaved, null, 2),
  );
  const beforeSaveState = await page.evaluate(async () => {
    const connection = await window.openpe.connection();
    return await (
      await fetch(connection.base + '/api/state', {
        cache: 'no-store',
        headers: { 'X-OpenPE-Token': connection.token },
      })
    ).json();
  });
  await writeFile(
    path.join(dir, 'before-save-recovery.json'),
    JSON.stringify(beforeSaveState, null, 2),
  );
  await fileMenuAction(page, 'Save');
  await toast('Save project');
  const saved = await diskFiles();
  await writeFile(path.join(dir, 'actual-save-native.json'), JSON.stringify(saved, null, 2));
  assert.deepEqual(
    saved,
    expectedSaved,
    'Save keeps its existing native destination after exports.',
  );
  assert.equal(nativeProject(saved).id, initial.id);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  const rejectedDir = path.join(dir, 'rejected');
  await mkdir(rejectedDir);
  const rejectedFile = path.join(rejectedDir, 'invalid.kicad_pro');
  const badSource = '{invalid project settings';
  await writeFile(rejectedFile, badSource);
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, rejectedFile);
  await button('Open project').click();
  await toast('Invalid KiCad project');
  assert.equal(await readFile(rejectedFile, 'utf8'), badSource);
  assert.deepEqual(await diskFiles(), saved);
  await waitForAsync(
    page,
    async (id) => {
      const c = await window.openpe.connection();
      const state = await (
        await fetch(c.base + '/api/state', {
          cache: 'no-store',
          headers: { 'X-OpenPE-Token': c.token },
        })
      ).json();
      return state?.documents?.some((item) => JSON.parse(item.source).project.id === id);
    },
    initial.id,
  );
  await page.reload();
  await page.getByTestId('schematic-canvas').waitFor();
  await button('Source').click();
  assert.deepEqual(await sourceFiles(), saved);
  await selectFile(names[1]);
  const unfinished = `(kicad_sch (unfinished-recovery-${Date.now()}`;
  const beforeDraftWrite = (await recoveryObserver.snapshot()).sequence;
  await fillSource(page, unfinished);
  await recoveryObserver.waitForState(
    (state) =>
      state?.documents?.some(
        (item) =>
          item.sourceDraft &&
          JSON.parse(item.sourceDraft).files.some((file) => file.source === unfinished),
      ),
    { after: beforeDraftWrite },
  );
  await waitForAsync(
    page,
    async (draft) => {
      const c = await window.openpe.connection();
      const state = await (
        await fetch(c.base + '/api/state', {
          cache: 'no-store',
          headers: { 'X-OpenPE-Token': c.token },
        })
      ).json();
      return state.documents.some(
        (item) =>
          item.sourceDraft &&
          JSON.parse(item.sourceDraft).files.some((file) => file.source === draft),
      );
    },
    unfinished,
  );
  const beforeDraftReload = await page.evaluate(async () => {
    const c = await window.openpe.connection();
    return await (
      await fetch(c.base + '/api/state', {
        cache: 'no-store',
        headers: { 'X-OpenPE-Token': c.token },
      })
    ).json();
  });
  await writeFile(
    path.join(dir, 'before-draft-reload.json'),
    JSON.stringify(beforeDraftReload, null, 2),
  );
  await page.reload();
  await page.getByRole('region', { name: 'Project source', exact: true }).waitFor();
  await selectFile(names[1]);
  assert.equal(
    await readSource(page),
    unfinished,
    'Recovery restores the selected native file draft.',
  );
  const recoveredDir = path.join(dir, 'recovered');
  await mkdir(recoveredDir);
  const recoveredFile = path.join(recoveredDir, 'source-recovered.kicad_pro');
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, recoveredFile);
  await fillSource(
    page,
    saved[names[1]].replace('(property "Value" "2k"', '(property "Value" "4k"'),
  );
  await fileMenuAction(page, 'Save');
  await toast('Save project');
  const recovered = await diskFiles(recoveredDir, 'source-recovered');
  assert.equal(
    nativeProject(recovered, 'source-recovered.kicad_pro').schematic.parts.find(
      (part) => part.ref === 'R1',
    ).value,
    '4k',
  );
  assert.deepEqual(
    await diskFiles(),
    saved,
    'Saving recovery does not overwrite the former destination.',
  );
  await fileMenuAction(page, 'Close project');
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  await button('New project').click();
  await button('Source').click();
  await page
    .getByRole('navigation', { name: 'Project files', exact: true })
    .getByRole('button', { name: /\.kicad_pro$/ })
    .click();
  const newSource = await readSource(page);
  await fillSource(page, '{unfinished');
  await fileMenuAction(page, 'Close project');
  const closeDialog = page.getByRole('dialog', { name: 'Save changes?', exact: true });
  await closeDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await closeDialog.getByRole('alert').filter({ hasText: 'Fix the source errors' }).waitFor();
  await closeDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await readSource(page), '{unfinished');
  await fillSource(
    page,
    JSON.stringify(
      { ...JSON.parse(newSource), text_variables: { NOTE: 'Edited before closing' } },
      null,
      2,
    ),
  );
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await fileMenuAction(page, 'Close project');
  await closeDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await closeDialog.getByRole('alert').filter({ hasText: 'Save cancelled' }).waitFor();
  const closedDir = path.join(dir, 'closed');
  await mkdir(closedDir);
  const closedFile = path.join(closedDir, 'closed-project.kicad_pro');
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, closedFile);
  await closeDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  assert.equal(
    JSON.parse(await readFile(closedFile, 'utf8')).text_variables.NOTE,
    'Edited before closing',
  );
  await readFile(path.join(closedDir, 'closed-project.kicad_sch'), 'utf8');
  await button('New project').click();
  await button('Source').click();
  await fillSource(page, '{unfinished');
  await fileMenuAction(page, 'Close project');
  await closeDialog.getByRole('button', { name: "Don't save", exact: true }).click();
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  assert.equal(await page.locator('.project-navigation').getByRole('button').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: native KiCad file-set save/recovery, multi-file Source validation and undo, invalid drafts, cancelled/manufacturing exports, destination retention and save/discard close review.',
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
  try {
    if (recoveryObserver)
      recoveryTrace.push(
        await recoveryObserver.evidence().catch((error) => ({ error: error.message })),
      );
    await writeFile(path.join(dir, 'recovery-trace.json'), JSON.stringify(recoveryTrace, null, 2));
  } finally {
    await recoveryObserver?.restore().catch(() => {});
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
}
