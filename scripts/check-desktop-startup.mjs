import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import nativeProject from '../electron/native-project.cjs';
import { projectFromNativeFiles } from '../server/project-format.mjs';

// Opt-in native IPC regression: Home skips preparation; explicit opening joins it.
// The isolated bootstrap delays work without adding test switches to production.
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/startup-gate-'));
const profile = path.join(root, 'profile');
const bootstrap = path.join(root, 'main.cjs');
await writeFile(
  bootstrap,
  `
(async () => {
  const { ExampleProjects } = await import(${JSON.stringify(pathToFileURL(path.resolve('server/example-projects.mjs')).href)});
  const prepare = ExampleProjects.prototype.prepare;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.startupCheck = { calls: 0, release, complete: false };
  ExampleProjects.prototype.prepare = async function () {
    globalThis.startupCheck.calls++;
    await gate;
    const warnings = await prepare.call(this);
    globalThis.startupCheck.complete = true;
    return warnings;
  };
  require(${JSON.stringify(path.resolve('electron/main.cjs'))});
})();
`,
);
const application = await electron.launch({
  args: [bootstrap],
  env: { ...process.env, OPENPE_TEST: '1', OPENPE_DATA_DIR: profile, OPENPE_DEV_URL: '' },
});
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(60_000);
  await page.getByRole('textbox', { name: 'Describe your circuit', exact: true }).waitFor();
  assert.equal(await application.evaluate(() => globalThis.startupCheck.calls), 0);
  assert.equal(await application.evaluate(() => globalThis.startupCheck.complete), false);
  await page.evaluate(() => {
    window.openedEarly = false;
    window.pendingExample = window.openpe
      .openDefaultExample('example:reference-lm2596-to220-5-buck')
      .then((result) => {
        window.openedEarly = true;
        return result;
      });
  });
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByTestId('schematic-canvas').waitFor();
  assert.equal(await application.evaluate(() => globalThis.startupCheck.calls), 1);
  assert.equal(
    await page.evaluate(() => window.openedEarly),
    false,
    'Example IPC waits for preparation while ordinary project creation stays interactive.',
  );
  await application.evaluate(() => globalThis.startupCheck.release());
  const result = await page.evaluate(() => window.pendingExample);
  assert.equal(await application.evaluate(() => globalThis.startupCheck.calls), 1);
  assert.equal(await application.evaluate(() => globalThis.startupCheck.complete), true);
  const manifest = JSON.parse(
    await readFile('resources/example-catalog/home-manifest.json', 'utf8'),
  );
  const catalog = [...manifest.recent, ...manifest.examples];
  assert.equal((await readdir(path.join(profile, 'project-history-v1'))).length, catalog.length);
  await assert.rejects(readdir(path.join(profile, 'example-projects')), { code: 'ENOENT' });
  for (const entry of catalog) {
    const directory = path.resolve(manifest.sourceRoots[entry.root], entry.directory);
    const nativePath = path.join(directory, `${entry.file}.kicad_pro`);
    const normalized = process.platform === 'win32' ? nativePath.toLowerCase() : nativePath;
    const repository = createHash('sha256').update(normalized).digest('hex') + '.git';
    assert.match(
      (
        await readFile(
          path.join(profile, 'project-history-v1', repository, 'refs/heads/main'),
          'utf8',
        )
      ).trim(),
      /^[a-f0-9]{40}$/,
    );
    const project = projectFromNativeFiles(await nativeProject.readNativeProject(nativePath));
    for (const model of project.simulationModels ?? [])
      assert.ok((await readFile(path.join(directory, model.file))).length);
  }
  assert.equal(JSON.parse(result.source).format, 'openpe');
  await page.evaluate((fileId) => window.openpe.releaseFile(fileId), result.fileId);
  const reopened = await page.evaluate(() =>
    window.openpe.openDefaultExample('example:reference-lm2596-to220-5-buck'),
  );
  assert.equal(await application.evaluate(() => globalThis.startupCheck.calls), 1);
  await page.evaluate((fileId) => window.openpe.releaseFile(fileId), reopened.fileId);
  console.log(
    'Desktop startup: Home skips example checks; explicit example IPC waits for all ten native KiCad/model/history preparations; preparation runs once.',
  );
} finally {
  await application.close();
}
