import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { serializeProject } from '../lib/project';
import { FileGrants } from '../electron/file-grants.cjs';
import { createHomeExample } from '../lib/create-home-example';
import { createBlankProject } from '../lib/create-blank-project';
import { attachOnlineFootprint } from '../lib/library-project-assets';
import { parseSExpr } from '../lib/sexpr';
test('component model routes require the service token, reject foreign origins and bound request shape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-component-route-'));
  const server = await startServer({ dataDir: root });
  try {
    const post = (route: string, headers: Record<string, string>, body: unknown) =>
      fetch(server.base + '/api/' + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    for (const route of ['component-model', 'component-model/library', 'library-package']) {
      assert.equal((await post(route, {}, {})).status, 401);
      assert.equal(
        (
          await post(
            route,
            { 'X-OpenPE-Token': server.token, Origin: 'https://foreign.invalid' },
            {},
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post(
            route,
            { 'X-OpenPE-Token': server.token },
            { path: 'C:/private.step', url: 'https://foreign.invalid/model.step' },
          )
        ).status,
        422,
      );
    }
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unsaved grants preview exact pinned and imported models without authorizing project files', async (t) => {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'component-preview-'));
  const grants = new FileGrants();
  const server = await startServer({
    dataDir: root,
    componentModelFiles: { resolve: (id: string) => grants.location(id) },
  });
  t.after(async () => {
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = createHomeExample('reference-lm25017-wson8-flybuck');
  const footprint = project.pcb!.footprints.find((item) =>
    item.libraryId.startsWith('Package_SON:WSON-8-1EP'),
  )!;
  const pinnedPath = footprint.models![0].path;
  const request = (fileId: string) =>
    fetch(server.base + '/api/component-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': server.token },
      body: JSON.stringify({ source: serializeProject(project), fileId, footprintId: footprint.id, index: 0 }),
    });
  const unsaved = grants.create();
  const pinned = await request(unsaved);
  assert.equal(pinned.status, 200);
  assert.ok((await pinned.json()).meshes.length);

  footprint.models![0].path = pinnedPath.replace('/models/', '/other/');
  const unknown = await request(unsaved);
  assert.equal(unknown.status, 422);
  assert.match((await unknown.json()).error, /Save the project/);

  const projectFile = path.resolve('examples/lm25017-wson8-flybuck/lm25017-wson8-flybuck.kicad_pro');
  footprint.models![0].path = pinnedPath;
  const savedGrant = grants.create();
  grants.assign(savedGrant, projectFile);
  const saved = await request(savedGrant);
  assert.equal(saved.status, 200);
  assert.ok((await saved.json()).meshes.length);

  const imported = await server.componentModels.importFile(
    path.join(path.dirname(projectFile), pinnedPath.slice('${KIPRJMOD}/'.length)),
    new AbortController().signal,
  );
  footprint.models![0].path = imported.path;
  const cached = await request(unsaved);
  assert.equal(cached.status, 200);
  assert.ok((await cached.json()).meshes.length);
  const packageId = 'JLCPCB:C7593';
  const withLocalPackage = attachOnlineFootprint(createBlankProject(), {
    id: packageId,
    projectAssets: true,
    footprint: parseSExpr(`(footprint "C7593" (model "${imported.path}"))`),
  });
  const previewPackage = (selector: object) =>
    fetch(server.base + '/api/component-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': server.token },
      body: JSON.stringify({ source: serializeProject(withLocalPackage), fileId: unsaved, index: 0, ...selector }),
    });
  const packagePreview = await previewPackage({ libraryId: packageId });
  assert.equal(packagePreview.status, 200);
  assert.ok((await packagePreview.json()).meshes.length);
  assert.equal((await previewPackage({ libraryId: 'JLCPCB:C9999' })).status, 422);
  assert.equal((await previewPackage({ libraryId: packageId, footprintId: footprint.id })).status, 422);
  grants.release(unsaved);
  const revoked = await request(unsaved);
  assert.equal(revoked.status, 422);
  assert.match((await revoked.json()).error, /no file access grant/);
  assert.equal((await previewPackage({ libraryId: packageId })).status, 422);
});
