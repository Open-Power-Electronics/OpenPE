import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { atomicWrite } from '../server/atomic-write.mjs';

const { RecentProjects } = createRequire(import.meta.url)('../electron/recent-projects.cjs');

test('Recent persists real paths, deduplicates, orders concurrent updates and bounds history', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-recent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RecentProjects(dir, atomicWrite);
  assert.deepEqual(await store.list(), { initialized: false, entries: [], warnings: [] });
  const files = Array.from({ length: 40 }, (_, i) => path.join(dir, `${i}.kicad_pro`));
  await Promise.all(files.map((file) => store.remember(file)));
  await store.remember(files[12]);
  const reopened = new RecentProjects(dir, atomicWrite);
  const { entries } = await reopened.list();
  assert.equal(entries.length, 32);
  assert.equal(entries[0].description, files[12]);
  assert.equal(entries[1].description, files[39]);
  assert.equal(new Set(entries.map((entry: { id: string }) => entry.id)).size, 32);
  assert.equal(await reopened.resolve(entries[0].id), files[12]);
  await assert.rejects(reopened.resolve(files[12]), /Unknown recent/);
  await assert.rejects(reopened.resolve(`recent:${'0'.repeat(64)}`), /no longer listed/);
  if (process.platform === 'win32') {
    await reopened.remember(files[12].toUpperCase());
    const next = (await reopened.list()).entries;
    assert.equal(next.length, 32);
    assert.equal(next[0].id, entries[0].id);
  }
});

test('Recent retains standalone schematics, boards and unavailable paths without granting access', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-recent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RecentProjects(dir, atomicWrite);
  for (const name of ['sheet.kicad_sch', 'board.kicad_pcb'])
    await store.remember(path.join(dir, name));
  const { entries } = await store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'board.kicad_pcb');
  assert.equal(await store.resolve(entries[0].id), path.join(dir, 'board.kicad_pcb'));
  await store.remember('../arbitrary.txt');
  assert.equal((await store.list()).entries.length, 2);
  assert.match((await store.list()).warnings[0], /Could not update Recent/);
});

test('damaged or unsupported Recent data is preserved, and a repaired store remains retryable', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-recent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'recent-projects.json');
  const store = new RecentProjects(dir, atomicWrite);
  for (const content of [
    '{broken',
    JSON.stringify({ version: 0, files: [] }),
    JSON.stringify({ version: 1, files: ['relative.kicad_pro'] }),
    JSON.stringify({ version: 1, files: [], grants: [] }),
    'x'.repeat(1024 * 1024 + 1),
  ]) {
    await writeFile(file, content);
    await assert.rejects(store.list());
    await store.remember(path.join(dir, 'valid.kicad_pro'));
    assert.equal(await readFile(file, 'utf8'), content);
  }
  await writeFile(file, JSON.stringify({ version: 1, files: [] }));
  await store.remember(path.join(dir, 'valid.kicad_pro'));
  assert.equal((await store.list()).entries.length, 1);
  assert.deepEqual((await store.list()).warnings, []);
});

test('Recent write failure preserves the accepted history and retries on the next update', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-recent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let fail = false;
  const store = new RecentProjects(dir, async (...args: Parameters<typeof atomicWrite>) => {
    if (fail) throw new Error('Disk unavailable');
    return atomicWrite(...args);
  });
  await store.remember(path.join(dir, 'first.kicad_pro'));
  fail = true;
  await store.remember(path.join(dir, 'second.kicad_pro'));
  assert.equal((await store.list()).entries[0].title, 'first.kicad_pro');
  assert.match((await store.list()).warnings[0], /Disk unavailable/);
  fail = false;
  await store.remember(path.join(dir, 'second.kicad_pro'));
  assert.equal((await store.list()).entries[0].title, 'second.kicad_pro');
  assert.deepEqual((await store.list()).warnings, []);
});

test('Recent rejects linked application data directories', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-recent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target');
  const link = path.join(dir, 'link');
  await mkdir(target);
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('This Windows environment does not allow creating links.');
    return;
  }
  const store = new RecentProjects(link, atomicWrite);
  await assert.rejects(store.list(), /unlinked/);
  await store.remember(path.join(dir, 'project.kicad_pro'));
  await assert.rejects(readFile(path.join(target, 'recent-projects.json')), /ENOENT/);
});

test('removing Recent preserves native files and persists an empty list without restoring the default', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-recent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RecentProjects(dir, atomicWrite);
  await store.remove('default:emc-flyback-demo');
  assert.deepEqual(await new RecentProjects(dir, atomicWrite).list(), {
    initialized: true,
    entries: [],
    warnings: [],
  });
  const file = path.join(dir, 'keep.kicad_pro');
  await writeFile(file, 'native bytes to preserve');
  await store.remember(file);
  const [entry] = (await store.list()).entries;
  await assert.rejects(store.remove('default:emc-flyback-demo'), /Recent changed/);
  await store.remove(entry.id);
  assert.equal(await readFile(file, 'utf8'), 'native bytes to preserve');
  assert.deepEqual(await new RecentProjects(dir, atomicWrite).list(), {
    initialized: true,
    entries: [],
    warnings: [],
  });
  await assert.rejects(store.resolve(entry.id), /no longer listed/);
  await assert.rejects(store.remove(file), /no longer listed/);
});
