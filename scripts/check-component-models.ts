import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectCore } from '../core/project-core';
import { parseProject, serializeProject, projectNativeFiles } from '../lib/project';
import { startServer } from '../server/index.mjs';
const root = await mkdtemp(path.join(tmpdir(), 'openpe-step-component-real-'));
const launch = startServer as unknown as (
  options: Record<string, unknown>,
) => ReturnType<typeof startServer>;
const grant = '00000000-0000-4000-8000-000000000001';
let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  const footprint = project.pcb!.footprints.find((f) => f.symbolId && f.models?.length)!;
  const existing = footprint.models![0];
  const modelFile = path.resolve('project/emc-flyback', existing.path.slice('${KIPRJMOD}/'.length));
  const source = await readFile(modelFile);
  const projectFile = path.join(root, 'source', 'board.kicad_pro');
  await mkdir(path.dirname(projectFile));
  let file = projectFile;
  const options = {
    dataDir: path.join(root, 'profile'),
    componentModelFiles: {
      resolve: (id: string) => {
        assert.equal(id, grant);
        return file;
      },
    },
  };
  server = await launch(options);
  const libraryResponse = await fetch(server.base + '/api/component-model/library', {
    method: 'POST',
    headers: { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: footprint.libraryId, index: 0 }),
  });
  const libraryModel = await libraryResponse.json();
  assert.equal(libraryResponse.status, 200, JSON.stringify(libraryModel));
  assert.match(libraryModel.path, /models\/[a-f0-9]{64}\.step$/);
  const imported = await server.componentModels.importFile(modelFile, new AbortController().signal);
  const core = new ProjectCore(project);
  assert.equal(
    core.replaceBoard({
      ...project.pcb!,
      footprints: project.pcb!.footprints.map((f) =>
        f.id === footprint.id ? { ...f, models: [{ ...existing, path: imported.path }] } : f,
      ),
    }),
    true,
  );
  async function post(body: object) {
    const response = await fetch(server!.base + '/api/component-model', {
      method: 'POST',
      headers: { 'X-OpenPE-Token': server!.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  const body = {
    source: core.getSnapshot().source,
    fileId: grant,
    footprintId: footprint.id,
    index: 0,
  };
  const preview = await post(body);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.ok(preview.data.meshes.length);
  assert.equal((await post({ ...body, path: modelFile })).status, 422);
  const copy = path.join(root, 'copy', 'copy.kicad_pro');
  await mkdir(path.dirname(copy));
  await server.componentModels.prepare(
    core.getSnapshot().project,
    copy,
    path.resolve('project/emc-flyback/emc-flyback.kicad_pro'),
  );
  for (const f of projectNativeFiles(core.getSnapshot().project!, 'copy.kicad_pro').files) {
    await mkdir(path.dirname(path.join(path.dirname(copy), f.name)), { recursive: true });
    await writeFile(path.join(path.dirname(copy), f.name), f.source, f.encoding ?? 'utf8');
  }
  assert.deepEqual(
    await readFile(path.join(path.dirname(copy), imported.path.slice('${KIPRJMOD}/'.length))),
    source,
  );
  server.close();
  file = copy;
  server = await launch({ ...options, dataDir: path.join(root, 'fresh-profile') });
  const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
  const { projectFromNativeFiles } = await import('../lib/project');
  const reopened = projectFromNativeFiles(await readNativeProject(copy));
  const after = await post({ ...body, source: serializeProject(reopened) });
  assert.equal(after.status, 200);
  assert.ok(after.data.meshes.length);
  await writeFile(
    path.join(path.dirname(copy), imported.path.slice('${KIPRJMOD}/'.length)),
    'ISO-10303-21; changed',
  );
  assert.equal((await post({ ...body, source: serializeProject(reopened) })).status, 422);
  const handlers = new Map();
  const { registerComponentModelPicker } = createRequire(import.meta.url)(
    '../electron/component-model-picker.cjs',
  );
  let authorized = 0;
  registerComponentModelPicker({
    ipcMain: { handle: (key: string, fn: unknown) => handlers.set(key, fn) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [modelFile] }) },
    getWindow: () => null,
    authorize: () => authorized++,
    grants: { location: () => copy },
    models: server.componentModels,
  });
  assert.match(
    (await handlers.get('openpe:choose-component-model')({}, grant)).path,
    /models\/[a-f0-9]{64}\.step$/,
  );
  assert.equal(authorized, 3);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/component-model-real.json',
    JSON.stringify(
      {
        passed: true,
        sourceModel: modelFile,
        modelPath: imported.path,
        meshCount: after.data.meshes.length,
        nativeRoundTrip: true,
        saveAsPortable: true,
        freshHostLoaded: true,
        changedBytesRejected: true,
        extraPathRejected: true,
        nativePickerAuthorized: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: real STEP tessellation, component-index preview, portable Save as, fresh-host native reopen, changed-byte rejection and native picker authorization.',
  );
} finally {
  server?.close();
  await rm(root, { recursive: true, force: true });
}
