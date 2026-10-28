import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fileSystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analysisFilename,
  createAnalysisStaging,
  discardAnalysisStaging,
  publishAnalysisFiles,
  withAnalysisFiles,
} from '../server/flat-analysis-files.mjs';

async function fixture(t: TestContext) {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'flat-analysis-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(!(await lstat(root)).isSymbolicLink());
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'spice');
  await mkdir(directory);
  const staging = await createAnalysisStaging(directory);
  return { root, directory, staging };
}

test('flat analysis names retain project stems and reject traversal', () => {
  assert.equal(analysisFilename('buck', 'waveforms.raw'), 'buck.waveforms.raw');
  assert.equal(analysisFilename('buck', 'mesh/mesh.nodes'), 'buck.mesh.nodes');
  for (const name of ['../result.json', '/result.json', 'mesh\\mesh.nodes', ''])
    assert.throws(() => analysisFilename('buck', name), /filename/);
  assert.throws(() => analysisFilename('../buck', 'result.json'), /filename/);
});

test('flat publication commits the manifest last and retains unknown and other-project files', async (t) => {
  const { root, directory, staging } = await fixture(t);
  const old = ['buck.waveforms.raw', 'buck.obsolete.lib', 'buck.manifest.json'];
  const next = ['buck.waveforms.raw', 'buck.result.json', 'buck.manifest.json'];
  for (const name of old) await writeFile(path.join(directory, name), `old ${name}`);
  for (const name of next) await writeFile(path.join(staging, name), `new ${name}`);
  await writeFile(path.join(directory, 'personal.txt'), 'user sidecar');
  await writeFile(path.join(directory, 'other.manifest.json'), 'other project');
  const original = fileSystem.rename;
  const installed: string[] = [];
  t.mock.method(fileSystem, 'rename', async (...args: Parameters<typeof fileSystem.rename>) => {
    if (path.dirname(String(args[1])) === directory) installed.push(path.basename(String(args[1])));
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await publishAnalysisFiles({
    directory,
    staging,
    previousNames: old,
    nextNames: next,
    manifestName: 'buck.manifest.json',
    check: async () => {},
    signal: new AbortController().signal,
  });
  assert.deepEqual(installed, next);
  for (const name of next)
    assert.equal(await readFile(path.join(directory, name), 'utf8'), `new ${name}`);
  assert.equal(await readFile(path.join(directory, 'personal.txt'), 'utf8'), 'user sidecar');
  assert.equal(
    await readFile(path.join(directory, 'other.manifest.json'), 'utf8'),
    'other project',
  );
  await assert.rejects(readFile(path.join(directory, 'buck.obsolete.lib')), { code: 'ENOENT' });
  await discardAnalysisStaging(staging, next);
  assert.deepEqual(await readdir(root), ['spice']);
});

for (const mode of ['rename-failure', 'cancelled', 'revoked'] as const) {
  test(`flat publication restores all previous bytes after ${mode}`, async (t) => {
    const { root, directory, staging } = await fixture(t);
    const names = ['buck.waveforms.raw', 'buck.result.json', 'buck.manifest.json'];
    for (const name of names) {
      await writeFile(path.join(directory, name), `old ${name}`);
      await writeFile(path.join(staging, name), `new ${name}`);
    }
    let permitted = true;
    const controller = new AbortController();
    const original = fileSystem.rename;
    t.mock.method(fileSystem, 'rename', async (...args: Parameters<typeof fileSystem.rename>) => {
      if (String(args[0]) === path.join(staging, names[1])) {
        if (mode === 'cancelled') controller.abort();
        else if (mode === 'revoked') permitted = false;
        throw Object.assign(new Error('Fixture publication denied.'), { code: 'EPERM' });
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(
      publishAnalysisFiles({
        directory,
        staging,
        previousNames: names,
        nextNames: names,
        manifestName: names[2],
        check: async () => {
          if (!permitted) throw new Error('The project grant was revoked.');
        },
        signal: controller.signal,
      }),
      mode === 'cancelled' ? /abort/i : mode === 'revoked' ? /grant/ : /publication denied/,
    );
    for (const name of names)
      assert.equal(await readFile(path.join(directory, name), 'utf8'), `old ${name}`);
    await discardAnalysisStaging(staging, names);
    assert.deepEqual(await readdir(root), ['spice']);
  });
}

test('flat publication refuses unknown target collisions and private cleanup preserves unexpected files', async (t) => {
  const { directory, staging } = await fixture(t);
  await writeFile(path.join(directory, 'buck.result.json'), 'unknown data');
  await writeFile(path.join(staging, 'buck.result.json'), 'new result');
  await writeFile(path.join(staging, 'buck.manifest.json'), 'new manifest');
  await assert.rejects(
    publishAnalysisFiles({
      directory,
      staging,
      previousNames: [],
      nextNames: ['buck.result.json', 'buck.manifest.json'],
      manifestName: 'buck.manifest.json',
      check: async () => {},
      signal: new AbortController().signal,
    }),
    /unknown analysis file/,
  );
  assert.equal(await readFile(path.join(directory, 'buck.result.json'), 'utf8'), 'unknown data');
  await writeFile(path.join(staging, 'personal.txt'), 'user data');
  await assert.rejects(
    discardAnalysisStaging(staging, ['buck.result.json', 'buck.manifest.json']),
    /unknown/,
  );
  assert.equal(await readFile(path.join(staging, 'personal.txt'), 'utf8'), 'user data');
});

test('previous record identities are retained across preparation before any replacement', async (t) => {
  const { directory, staging } = await fixture(t);
  const name = 'buck.manifest.json';
  const target = path.join(directory, name);
  await writeFile(target, 'old verified manifest');
  const identities = new Map([[name, await lstat(target)]]);
  await writeFile(path.join(staging, name), 'new manifest');
  await writeFile(target, 'changed user manifest');
  await assert.rejects(
    publishAnalysisFiles({
      directory,
      staging,
      previousNames: [name],
      previousIdentities: identities,
      nextNames: [name],
      manifestName: name,
      check: async () => {},
      signal: new AbortController().signal,
    }),
    /changed while preparing/,
  );
  assert.equal(await readFile(target, 'utf8'), 'changed user manifest');
  await discardAnalysisStaging(staging, [name]);
});

for (const mode of ['restore-denied', 'external-replacement'] as const) {
  test(`failed rollback preserves previous bytes and reports its backup after ${mode}`, async (t) => {
    const { root, directory, staging } = await fixture(t);
    const names = ['buck.waveforms.raw', 'buck.result.json', 'buck.manifest.json'];
    for (const name of names) {
      await writeFile(path.join(directory, name), 'old ' + name);
      await writeFile(path.join(staging, name), 'new ' + name);
    }
    await writeFile(path.join(directory, 'personal.txt'), 'user sidecar');
    const original = fileSystem.rename;
    t.mock.method(fileSystem, 'rename', async (...args: Parameters<typeof fileSystem.rename>) => {
      if (String(args[0]) === path.join(staging, names[1])) {
        if (mode === 'external-replacement')
          await writeFile(path.join(directory, names[0]), 'external file change');
        throw Object.assign(new Error('Fixture publication failure.'), { code: 'EXDEV' });
      }
      if (
        mode === 'restore-denied' &&
        String(args[0]).includes('.spice-previous-') &&
        String(args[1]) === path.join(directory, names[0])
      )
        throw Object.assign(new Error('Fixture restore denied.'), { code: 'EACCES' });
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(
      publishAnalysisFiles({
        directory,
        staging,
        previousNames: names,
        nextNames: names,
        manifestName: names[2],
        check: async () => {},
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof AggregateError && /Preserve .*spice-previous-/.test(error.message),
    );
    const backup = (await readdir(root)).find((name) => name.startsWith('.spice-previous-'))!;
    assert.ok(backup);
    assert.equal(await readFile(path.join(root, backup, names[0]), 'utf8'), 'old ' + names[0]);
    assert.equal(await readFile(path.join(directory, names[1]), 'utf8'), 'old ' + names[1]);
    assert.equal(await readFile(path.join(directory, names[2]), 'utf8'), 'old ' + names[2]);
    assert.equal(await readFile(path.join(directory, 'personal.txt'), 'utf8'), 'user sidecar');
    if (mode === 'external-replacement')
      assert.equal(await readFile(path.join(directory, names[0]), 'utf8'), 'external file change');
    await discardAnalysisStaging(staging, names);
  });
}

test('analysis directory queues serialize distinct stores and recover after rejection', async (t) => {
  const { directory, staging } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const first = withAnalysisFiles(directory, async () => {
    order.push('write');
    await gate;
    throw new Error('Fixture failure.');
  });
  const second = withAnalysisFiles(directory, async () => {
    order.push('read');
  });
  await Promise.resolve();
  assert.deepEqual(order, ['write']);
  release();
  await assert.rejects(first, /Fixture failure/);
  await second;
  assert.deepEqual(order, ['write', 'read']);
  await discardAnalysisStaging(staging, []);
});
