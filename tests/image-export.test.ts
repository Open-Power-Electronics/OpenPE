import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const { createImageExport } = createRequire(import.meta.url)('../electron/image-export.cjs');
const dataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII=';
const image = { dataUrl, width: 1, height: 1, name: 'supply.openpe.json' };
const nativeImage = {
  createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }),
};
test('image export validates PNGs before a native picker and writes only the selected PNG destination', async () => {
  const writes: { file: string; bytes: Buffer }[] = [],
    dialogs: any[] = [];
  const run = createImageExport({
    nativeImage,
    showSaveDialog: async (options: unknown) => {
      dialogs.push(options);
      return { canceled: false, filePath: path.resolve('image-export-test') };
    },
    atomicWrite: async (file: string, bytes: Buffer) => writes.push({ file, bytes }),
  });
  assert.deepEqual(await run(image), { name: 'image-export-test.png' });
  assert.equal(dialogs[0].defaultPath, 'supply.png');
  assert.equal(writes[0].file, path.resolve('image-export-test.png'));
  assert.deepEqual(writes[0].bytes, Buffer.from(dataUrl.split(',')[1], 'base64'));
  for (const value of [
    { ...image, path: 'C:/private.png' },
    { ...image, width: 4097 },
    { ...image, height: 2 },
    { ...image, dataUrl: 'data:image/svg+xml;base64,AAAA' },
    { ...image, dataUrl: 'file:///private.png' },
  ])
    await assert.rejects(run(value), /Invalid PNG/);
  assert.equal(dialogs.length, 1);
  assert.equal(writes.length, 1);
});
test('image export preserves cancellation, rejects other file types and releases busy state', async () => {
  let answer: { canceled: boolean; filePath?: string } = { canceled: true },
    writes = 0;
  const run = createImageExport({
    nativeImage,
    showSaveDialog: async () => answer,
    atomicWrite: async () => {
      writes++;
    },
  });
  assert.equal(await run(image), null);
  assert.equal(writes, 0);
  answer = { canceled: false, filePath: path.resolve('project.openpe.json') };
  await assert.rejects(run(image), /\.png filename/);
  assert.equal(writes, 0);
  answer = { canceled: false, filePath: path.resolve('project.png') };
  await run(image);
  assert.equal(writes, 1);
  const invalid = createImageExport({
    nativeImage: {
      createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
    },
    showSaveDialog: () => {
      throw new Error('Must not open');
    },
  });
  await assert.rejects(invalid(image), /Could not decode/);
});
