import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import {
  createProject,
  projectNativeFiles,
  parseProject,
  projectFromNativeFiles,
} from '../server/project-format.mjs';
import { buildSpiceDeck, defaultTransient } from '../server/spice-format.mjs';
import native from '../electron/native-project.cjs';

// Explicitly authorized isolated desktop check. Only its own temporary project
// directory and profile are used; the user's application remains untouched.
const { switchingStageFixture } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
const root = path.resolve('examples');
const directory = await mkdtemp(path.join(root, 'openpe-discovery-check-'));
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(path.resolve('test-results/discovery-desktop-'));
const title = `Customer circuit ${path.basename(directory).slice(-6)}`;
let application;
try {
  application = await electron.launch({
    args: [path.resolve('electron/main.cjs')],
    env: { ...process.env, OPENPE_TEST: '1', OPENPE_DATA_DIR: profile, OPENPE_DEV_URL: '' },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(60000);
  await page.getByRole('textbox', { name: 'Describe your circuit', exact: true }).waitFor();
  const before = await page.evaluate(() => window.openpe.listExamples());
  const bundle = projectNativeFiles(createProject(switchingStageFixture()), `${title}.kicad_pro`);
  for (const file of bundle.files) await writeFile(path.join(directory, file.name), file.source);
  assert.equal(
    await page.getByRole('button', { name: 'Refresh examples', exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const card = page.getByRole('button', { name: `Open ${title} example`, exact: true });
  await card.waitFor();
  const after = await page.evaluate(() => window.openpe.listExamples());
  const added = after.entries.filter((entry) => !before.entries.some((old) => old.id === entry.id));
  assert.equal(added.length, 1);
  assert.match(added[0].id, /^local-[a-f0-9]{64}$/);
  await card.click();
  await page.getByTestId('schematic-canvas').waitFor();
  const opened = await page.evaluate(
    (id) => window.openpe.openDefaultExample(`example:${id}`),
    added[0].id,
  );
  const project = parseProject(opened.source);
  const direct = projectFromNativeFiles(
    await native.readNativeProject(path.join(directory, bundle.entry)),
  );
  assert.deepEqual(project.nativeFiles, direct.nativeFiles);
  assert.deepEqual(
    buildSpiceDeck(project.schematic, defaultTransient(project.schematic)),
    buildSpiceDeck(direct.schematic, defaultTransient(direct.schematic)),
  );
  for (const file of bundle.files)
    assert.equal(await readFile(path.join(directory, file.name), 'utf8'), file.source);
  await page.screenshot({ path: 'test-results/example-discovery-desktop.png' });
  console.log(
    'Dropped native project appeared after window focus, opened through the real desktop grant, and compiled identically to ordinary native import without changing its files.',
  );
} finally {
  await application?.close();
  assert.equal(path.dirname(path.resolve(directory)), root);
  assert.ok(path.basename(directory).startsWith('openpe-discovery-check-'));
  assert.equal((await lstat(directory)).isSymbolicLink(), false);
  await rm(directory, { recursive: true, force: true });
}
