import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  rename,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fs = require('node:fs/promises');
const { FileGrants } = require('../electron/file-grants.cjs');
const { readNativeProject } = require('../electron/native-project.cjs');
const {
  createProjectDirectoryReader,
  registerProjectDirectory,
} = require('../electron/project-directory.cjs');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const grants = new FileGrants();
  const file = path.join(root, 'project.kicad_pro');
  await writeFile(file, '{}');
  const id = grants.create(file);
  const write = async (name: string, source: string | Buffer) => {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  };
  return { root, grants, id, write, reader: createProjectDirectoryReader(grants) };
}

test('Source observes project folders, empty directories, text and binary resources without importing solver artifacts', async (t) => {
  const { root, id, write, reader } = await fixture(t);
  await write('footprints/models/device.step', 'ISO-10303-21;');
  await write('models/controller.lib', '.subckt controller 1 2\n.ends');
  await write('models/legacy.lib', Buffer.from('* Copyright © vendor\n', 'latin1'));
  const scadSource = '// Cover dimensions in mm\ncube([112, 94, 3]);\n';
  await write('enclosure.scad', scadSource);
  await write('spice/project/run/deck.cir', '* generated deck');
  await write('thermal/project/run/result.json', '{"temperature":42}');
  await write('thermal/project/run/model.msh', Buffer.from([0, 1, 255]));
  await mkdir(path.join(root, 'notes/empty'), { recursive: true });
  await write('.git/config', 'private git');
  await write('history.git/config', 'private history');
  await write('.env', 'private credentials');
  const listing = await reader.list(id);
  assert.equal(listing.truncated, false);
  for (const name of ['footprints', 'models', 'spice', 'thermal', 'notes/empty'])
    assert.ok(
      listing.entries.some((entry: any) => entry.name === name && entry.kind === 'directory'),
    );
  assert.ok(listing.entries.every((entry: any) => !/\.git|\.env/.test(entry.name)));
  const result = listing.entries.find((entry: any) => entry.name.endsWith('result.json'));
  assert.deepEqual(await reader.read(id, result.id), {
    source: '{"temperature":42}',
    bytes: 18,
    binary: false,
    truncated: false,
    readOnly: false,
  });
  const mesh = listing.entries.find((entry: any) => entry.name.endsWith('.msh'));
  assert.equal((await reader.read(id, mesh.id)).binary, true);
  const legacy = listing.entries.find((entry: any) => entry.name === 'models/legacy.lib');
  const text = await reader.read(id, legacy.id);
  assert.equal(text.source, '* Copyright © vendor\n');
  assert.equal(text.encoding, 'latin1');
  const scad = listing.entries.find((entry: any) => entry.name === 'enclosure.scad');
  assert.ok(scad, 'Root CAD sources appear in the grant-bound Source file listing.');
  assert.deepEqual(await reader.read(id, scad.id), {
    source: scadSource,
    bytes: Buffer.byteLength(scadSource),
    binary: false,
    truncated: false,
    readOnly: false,
  });
  const native = await readNativeProject(path.join(root, 'project.kicad_pro'));
  assert.ok(native.files.every((entry: any) => !/^(spice|thermal)\//.test(entry.name)));
  assert.ok(native.files.every((entry: any) => !entry.name.endsWith('.scad')));
  assert.equal(await readFile(path.join(root, result.name), 'utf8'), '{"temperature":42}');
});

test('ordinary SCAD and text files save exact bytes while retaining other observation IDs', async (t) => {
  const { root, id, write, reader } = await fixture(t);
  await write('enclosure.scad', 'cube([1, 2, 3]);\n');
  await write('notes.txt', 'original notes');
  const listing = await reader.list(id);
  const scad = listing.entries.find((entry: any) => entry.name === 'enclosure.scad');
  const notes = listing.entries.find((entry: any) => entry.name === 'notes.txt');
  const source = '// Dimensions in mm\ncube([12, 34, 56]);\n';
  assert.deepEqual(
    await reader.write({ fileId: id, id: scad.id, source, expectedSource: 'cube([1, 2, 3]);\n' }),
    {
      source,
      bytes: Buffer.byteLength(source),
      binary: false,
      truncated: false,
      readOnly: false,
    },
  );
  assert.equal(await readFile(path.join(root, 'enclosure.scad'), 'utf8'), source);
  assert.equal((await reader.read(id, scad.id)).source, source);
  await reader.write({ fileId: id, id: notes.id, source: '', expectedSource: 'original notes' });
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), '');
  assert.ok((await readdir(root)).every((name) => !name.startsWith('.openpe-source-')));
});

test('PDF observations deliver complete bounded local bytes without exposing paths or enabling edits', async (t) => {
  const { root, grants, id, write, reader } = await fixture(t);
  const pdfBytes = Buffer.from(
    '%PDF-1.7\n%\x00\xff\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
    'latin1',
  );
  await write('datasheets/controller.pdf', pdfBytes);
  await write('notes.txt', '%PDF-1.7\n%%EOF\n');
  await write('invalid.pdf', 'a document without a PDF header');
  const listing = await reader.list(id);
  const pdf = listing.entries.find((entry: any) => entry.name === 'datasheets/controller.pdf');
  assert.deepEqual(await reader.read(id, pdf.id), {
    source: `PDF document\nSize: ${pdfBytes.length} bytes\n`,
    bytes: pdfBytes.length,
    binary: true,
    truncated: false,
    readOnly: true,
    pdf: true,
  });
  assert.deepEqual(await reader.pdf(id, pdf.id), {
    base64: pdfBytes.toString('base64'),
    bytes: pdfBytes.length,
  });
  await assert.rejects(
    reader.write({ fileId: id, id: pdf.id, source: 'edit', expectedSource: '' }),
    /fully loaded/,
  );
  const invalid = listing.entries.find((entry: any) => entry.name === 'invalid.pdf');
  await assert.rejects(reader.pdf(id, invalid.id), /does not contain a PDF/);
  const text = listing.entries.find((entry: any) => entry.name === 'notes.txt');
  await assert.rejects(reader.pdf(id, text.id), /Select a PDF/);
  await write(
    'datasheets/controller.pdf',
    Buffer.concat([pdfBytes, Buffer.from('external change')]),
  );
  await assert.rejects(reader.pdf(id, pdf.id), /changed/);
  assert.deepEqual(
    await readFile(path.join(root, 'datasheets/controller.pdf')),
    Buffer.concat([pdfBytes, Buffer.from('external change')]),
  );
  const next = await reader.list(id);
  const current = next.entries.find((entry: any) => entry.name === 'datasheets/controller.pdf');
  grants.release(id);
  await assert.rejects(reader.pdf(id, current.id), /grant|expired/);
});

test('PDF reads reject oversized files before allocation and stale frames before returning bytes', async (t) => {
  const { id, grants, write, reader } = await fixture(t);
  await write('large.pdf', '%PDF-1.7\n');
  const first = await reader.list(id);
  const large = first.entries.find((entry: any) => entry.name === 'large.pdf');
  // A sparse file exercises the bound without retaining a 32 MiB fixture.
  const location = path.join(path.dirname(grants.get(id)), 'large.pdf');
  await fs.truncate(location, 32 * 1024 * 1024 + 1);
  const updated = await reader.list(id);
  const tooLarge = updated.entries.find((entry: any) => entry.name === 'large.pdf');
  await assert.rejects(reader.pdf(id, large.id), /expired/);
  await assert.rejects(reader.pdf(id, tooLarge.id), /32 MiB/);
  assert.equal((await reader.read(id, tooLarge.id)).pdf, undefined);
  await write('controller.pdf', '%PDF-1.7\n%%EOF\n');
  const handlers = new Map<string, (...args: any[]) => any>();
  let trusted = true;
  registerProjectDirectory({
    ipcMain: {
      handle: (channel: string, callback: (...args: any[]) => any) =>
        handlers.set(channel, callback),
    },
    authorize: () => {
      if (!trusted) throw new Error('Unauthorized window.');
    },
    grants,
  });
  const listing = await handlers.get('openpe:project-directory')!({}, id);
  const pdf = listing.entries.find((entry: any) => entry.name === 'controller.pdf');
  await assert.rejects(
    handlers.get('openpe:project-file-pdf')!(
      {},
      { fileId: id, id: pdf.id, path: '../outside.pdf' },
    ),
    /Invalid project PDF/,
  );
  const pending = handlers.get('openpe:project-file-pdf')!({}, { fileId: id, id: pdf.id });
  trusted = false;
  await assert.rejects(pending, /Unauthorized/);
});

test('text saves preserve Latin-1 and reject stale drafts, native edits and invalid payloads', async (t) => {
  const { root, id, write, reader } = await fixture(t);
  await write('notes.txt', Buffer.from('Copyright © vendor\n', 'latin1'));
  let listing = await reader.list(id);
  let notes = listing.entries.find((entry: any) => entry.name === 'notes.txt');
  const expectedSource = 'Copyright © vendor\n';
  const source = 'Copyright © vendor — edited\n';
  const edit = { fileId: id, id: notes.id, expectedSource, encoding: 'latin1' };
  await assert.rejects(reader.write({ ...edit, source }), /valid text/);
  await assert.rejects(reader.write({ ...edit, source: 'edited', encoding: undefined }), /changed/);
  const accepted = 'Copyright © vendor, revised\n';
  const saved = await reader.write({ ...edit, source: accepted });
  assert.equal(saved.encoding, 'latin1');
  assert.deepEqual(await readFile(path.join(root, 'notes.txt')), Buffer.from(accepted, 'latin1'));
  await assert.rejects(reader.write({ ...edit, source: 'stale' }), /changed/);
  await write('notes.txt', 'external replacement');
  await assert.rejects(reader.write({ ...edit, source: 'stale' }), /changed/);
  listing = await reader.list(id);
  notes = listing.entries.find((entry: any) => entry.name === 'notes.txt');
  await assert.rejects(
    reader.write({ fileId: id, id: notes.id, source: 'stale', expectedSource: accepted }),
    /changed/,
  );
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'external replacement');
  const native = listing.entries.find((entry: any) => entry.name === 'project.kicad_pro');
  assert.equal((await reader.read(id, native.id)).readOnly, true);
  await assert.rejects(
    reader.write({ fileId: id, id: native.id, source: '{"unsafe":true}', expectedSource: '{}' }),
    /validated Source/,
  );
  assert.equal(await readFile(path.join(root, 'project.kicad_pro'), 'utf8'), '{}');
  const valid = {
    fileId: id,
    id: notes.id,
    source: 'edit',
    expectedSource: 'external replacement',
  };
  for (const invalid of [
    { ...valid, source: '\0' },
    { ...valid, source: '\ud800' },
    { ...valid, source: 'x'.repeat(1024 * 1024 + 1) },
    { ...valid, expectedSource: 'x'.repeat(1024 * 1024 + 1) },
    { ...valid, encoding: 'utf8' },
    { ...valid, path: '../outside.txt' },
  ])
    await assert.rejects(reader.write(invalid), /Invalid|valid text/);
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'external replacement');
});

test('binary, truncated, linked and imported observations cannot be written', async (t) => {
  const { root, grants, id, write, reader } = await fixture(t);
  await write('binary.dat', Buffer.from([0, 1, 2]));
  await write('large.txt', 'x'.repeat(1024 * 1024 + 1));
  await write('enclosure.scad', 'cube([1, 2, 3]);');
  const listing = await reader.list(id);
  for (const name of ['binary.dat', 'large.txt']) {
    const entry = listing.entries.find((entry: any) => entry.name === name);
    const preview = await reader.read(id, entry.id);
    await assert.rejects(
      reader.write({ fileId: id, id: entry.id, source: 'edit', expectedSource: preview.source }),
      /fully loaded/,
    );
  }
  const scad = listing.entries.find((entry: any) => entry.name === 'enclosure.scad');
  await rename(path.join(root, 'enclosure.scad'), path.join(root, 'original.scad'));
  await mkdir(path.join(root, 'linked-folder'));
  await symlink(path.join(root, 'linked-folder'), path.join(root, 'enclosure.scad'), 'junction');
  await assert.rejects(
    reader.write({ fileId: id, id: scad.id, source: 'edit', expectedSource: 'cube([1, 2, 3]);' }),
    /changed|linked|regular/i,
  );
  assert.equal(await readFile(path.join(root, 'original.scad'), 'utf8'), 'cube([1, 2, 3]);');
  const imported = grants.createImport(path.join(root, 'import.kicad_pro'));
  const importedListing = await reader.list(imported);
  const large = importedListing.entries.find((entry: any) => entry.name === 'large.txt');
  assert.equal((await reader.read(imported, large.id)).readOnly, true);
  await assert.rejects(
    reader.write({ fileId: imported, id: large.id, source: 'edit', expectedSource: '' }),
    /Save or reopen/,
  );
});

test('text write IPC rechecks frame and grant after staging and preserves the original on rejection', async (t) => {
  const { root, grants, id, write } = await fixture(t);
  await write('enclosure.scad', 'cube([1, 2, 3]);');
  const handlers = new Map<string, (...args: any[]) => any>();
  let trusted = true;
  registerProjectDirectory({
    ipcMain: {
      handle: (channel: string, callback: (...args: any[]) => any) =>
        handlers.set(channel, callback),
    },
    authorize: () => {
      if (!trusted) throw new Error('Unauthorized window.');
    },
    grants,
  });
  const listing = await handlers.get('openpe:project-directory')!({}, id);
  const scad = listing.entries.find((entry: any) => entry.name === 'enclosure.scad');
  const options = { fileId: id, id: scad.id, source: 'edit', expectedSource: 'cube([1, 2, 3]);' };
  const originalOpen = fs.open;
  let revoke = () => {
    trusted = false;
  };
  t.mock.method(fs, 'open', async (file: string, flags: string) => {
    const handle = await originalOpen(file, flags);
    if (path.basename(file).startsWith('.openpe-source-')) {
      const writeStaged = handle.writeFile.bind(handle);
      handle.writeFile = async (...args: any[]) => {
        await writeStaged(...args);
        revoke();
      };
    }
    return handle;
  });
  await assert.rejects(handlers.get('openpe:project-file-write')!({}, options), /Unauthorized/);
  assert.equal(await readFile(path.join(root, 'enclosure.scad'), 'utf8'), options.expectedSource);
  trusted = true;
  revoke = () => grants.release(id);
  await assert.rejects(handlers.get('openpe:project-file-write')!({}, options), /grant|expired/i);
  assert.equal(await readFile(path.join(root, 'enclosure.scad'), 'utf8'), options.expectedSource);
  assert.ok((await readdir(root)).every((name) => !name.startsWith('.openpe-source-')));
});

test('opaque observations reject stale reads, cross-project IDs, changed files, revoked grants and linked parents', async (t) => {
  const { root, grants, id, write, reader } = await fixture(t);
  await write('models/a.txt', 'original');
  const first = await reader.list(id);
  const token = first.entries.find((entry: any) => entry.name === 'models/a.txt').id;
  const other = grants.create(path.join(root, 'other.kicad_pro'));
  await write('other.kicad_pro', '{}');
  await assert.rejects(reader.read(other, token), /expired/);
  await assert.rejects(reader.read(id, '../models/a.txt'), /expired/);
  await write('models/a.txt', 'changed content');
  await assert.rejects(reader.read(id, token), /changed/);
  const second = await reader.list(id);
  assert.ok(!second.entries.some((entry: any) => entry.name === 'other.kicad_pro'));
  await assert.rejects(reader.read(id, token), /expired/);
  const next = second.entries.find((entry: any) => entry.name === 'models/a.txt').id;
  await rename(path.join(root, 'models'), path.join(root, 'original-models'));
  await symlink(path.join(root, 'original-models'), path.join(root, 'models'), 'junction');
  await assert.rejects(reader.read(id, next), /links|Linked/);
  const linked = await reader.list(id);
  assert.ok(!linked.entries.some((entry: any) => entry.name.startsWith('models/')));
  grants.release(id);
  await assert.rejects(reader.read(id, next), /grant|expired/);
});

test('overlapping directory refreshes publish only the latest observation IDs', async (t) => {
  const { id, write, reader } = await fixture(t);
  await write('spice/run.txt', 'output');
  const results = await Promise.allSettled([reader.list(id), reader.list(id)]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  if (results[1].status === 'fulfilled') {
    const entry = results[1].value.entries.find((entry: any) => entry.name === 'spice/run.txt');
    assert.equal((await reader.read(id, entry.id)).source, 'output');
  }
});

test('previews and traversal are bounded; Save as and frame replacement invalidate observations', async (t) => {
  const { root, grants, id, write, reader } = await fixture(t);
  await write('models/large.step', 'é'.repeat(600_000));
  const listing = await reader.list(id);
  const token = listing.entries.find((entry: any) => entry.name.endsWith('large.step')).id;
  const preview = await reader.read(id, token);
  assert.ok(preview.truncated && !preview.binary);
  assert.ok(Buffer.byteLength(preview.source) <= 1024 * 1024);
  assert.ok(!preview.source.includes('\ufffd'));
  await mkdir(path.join(root, ...Array(14).fill('deep')), { recursive: true });
  const bounded = await reader.list(id);
  assert.equal(bounded.truncated, true);
  const next = path.join(root, 'moved/project.kicad_pro');
  await mkdir(path.dirname(next));
  grants.assign(id, next);
  await assert.rejects(reader.read(id, token), /expired/);
  const empty = grants.create();
  assert.deepEqual(await reader.list(empty), { entries: [], truncated: false });
  grants.clear();
  await assert.rejects(reader.list(id), /grant/);
});

test('directory IPC checks the originating frame before and after asynchronous observations', async (t) => {
  const { grants, id } = await fixture(t);
  const handlers = new Map<string, (...args: any[]) => any>();
  let trusted = false;
  registerProjectDirectory({
    ipcMain: {
      handle: (channel: string, callback: (...args: any[]) => any) =>
        handlers.set(channel, callback),
    },
    authorize: () => {
      if (!trusted) throw new Error('Unauthorized window.');
    },
    grants,
  });
  for (const handler of handlers.values()) await assert.rejects(handler({}, {}), /Unauthorized/);
  trusted = true;
  const pending = handlers.get('openpe:project-directory')!({}, id);
  trusted = false;
  await assert.rejects(pending, /Unauthorized/);
});
