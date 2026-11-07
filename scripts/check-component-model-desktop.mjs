import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { parseProject, serializeProject } from '../server/project-format.mjs';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/component-model-desktop-'));
const folder = path.resolve('project/emc-flyback/models');
const model = path.join(
  folder,
  (await readdir(folder)).find((name) => name.endsWith('.step')),
);
const output = path.join(root, 'saved', 'copy.kicad_pro');
await mkdir(path.dirname(output));
const bootstrap = path.join(root, 'main.cjs');
await writeFile(
  bootstrap,
  `const {dialog}=require('electron');dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(output)}});dialog.showOpenDialog=async(_owner,options)=>{if(options.title==='Choose component STEP model')return {canceled:false,filePaths:[${JSON.stringify(model)}]};throw new Error('Unexpected dialog in component model fixture.');};require(${JSON.stringify(path.resolve('electron/main.cjs'))});`,
);
const application = await electron.launch({
  args: [bootstrap],
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DATA_DIR: path.join(root, 'profile'),
    OPENPE_DEV_URL: '',
  },
});
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(60000);
  await page.getByRole('textbox', { name: 'Describe your circuit', exact: true }).waitFor();
  const opened = await page.evaluate(() =>
    window.openpe.openDefaultExample('example:emc-flyback-demo'),
  );
  const selected = await page.evaluate(
    (fileId) => window.openpe.chooseComponentModel(fileId),
    opened.fileId,
  );
  assert.match(selected.path, /^\$\{KIPRJMOD\}\/models\/[a-f0-9]{64}\.step$/);
  const project = parseProject(opened.source),
    footprint = project.pcb.footprints.find((f) => f.symbolId && f.models?.length);
  footprint.models = [{ ...footprint.models[0], path: selected.path }];
  const source = serializeProject(project);
  const response = await page.evaluate(
    async ({ source, fileId, footprintId }) => {
      const { base, token } = await window.openpe.connection();
      const res = await fetch(base + '/api/component-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': token },
        body: JSON.stringify({ source, fileId, footprintId, index: 0 }),
      });
      const data = await res.json();
      return { status: res.status, meshCount: data.meshes?.length, error: data.error };
    },
    { source, fileId: opened.fileId, footprintId: footprint.id },
  );
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.ok(response.meshCount > 0);
  const saved = await page.evaluate(
    ({ fileId, source }) =>
      window.openpe.save({ fileId, source, name: 'copy.kicad_pro', saveAs: true }),
    { fileId: opened.fileId, source },
  );
  assert.equal(saved.path, output);
  assert.ok(
    (await readFile(path.join(path.dirname(output), selected.path.slice('${KIPRJMOD}/'.length))))
      .length,
  );
  await page.evaluate((fileId) => window.openpe.releaseFile(fileId), opened.fileId);
  await assert.rejects(
    page.evaluate((fileId) => window.openpe.chooseComponentModel(fileId), opened.fileId),
    /grant|Reopen/,
  );
  console.log(
    'PASS: isolated Electron native STEP picker, live saved-project grant, real STEP preview through authenticated service, revoked-grant rejection.',
  );
} finally {
  await application.close();
}
