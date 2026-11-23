import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibraryService } from '../server/libraries.mjs';

test('read-only library previews use prepared STEP bytes without downloads, cache writes or closing a borrowed parser', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-browser-models-'));
  const directory = path.join(root, 'models', 'Package_Test.3dshapes');
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('ISO-10303-21;\nprepared fixture');
  await writeFile(path.join(directory, 'Package.step'), bytes);
  let parsed = 0,
    closed = 0;
  const parser = {
    run: async (input: Uint8Array) => {
      assert.deepEqual(Buffer.from(input), bytes);
      parsed++;
      return { meshes: [] };
    },
    close: () => {
      closed++;
    },
  };
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Read-only previews cannot download.');
  });
  const library = createLibraryService({
    root,
    allowModelDownloads: false,
    stepParserPool: parser,
  });
  try {
    await library.modelPath(
      '${KICAD10_3DMODEL_DIR}/Package_Test.3dshapes/Package.step',
      new AbortController().signal,
    );
    assert.equal(parsed, 1);
    await assert.rejects(
      library.modelPath(
        '${KICAD10_3DMODEL_DIR}/Package_Test.3dshapes/Missing.step',
        new AbortController().signal,
      ),
      /Prepare the bundled/,
    );
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(await readdir(root), ['models']);
    assert.deepEqual(await readdir(directory), ['Package.step']);
    library.close();
    assert.equal(closed, 0);
  } finally {
    library.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('openpe-browser-models-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('the desktop library previews a manually added official STEP with downloads disabled', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-offline-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'profile');
  const directory = path.join(dataDir, 'library-models', '10.0.0', 'Package_SO.3dshapes');
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('ISO-10303-21;\nuser supplied official fixture');
  await writeFile(path.join(directory, 'SOIC-8.step'), bytes);
  const library = createLibraryService({
    root: path.join(root, 'bundle'),
    dataDir,
    allowModelDownloads: false,
    modelFetcher: async () => {
      throw new Error('Offline model resolution reached the network.');
    },
    stepParserPool: {
      run: async (input: Uint8Array) => {
        assert.deepEqual(Buffer.from(input), bytes);
        return { meshes: [] };
      },
      close() {},
    },
  });
  t.after(() => library.close());
  assert.deepEqual(
    await library.modelPath('${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step'),
    { meshes: [] },
  );
});
