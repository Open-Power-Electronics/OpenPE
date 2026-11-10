import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fileSystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { withDevPreparationCache } from '../scripts/dev-preparation-cache.mjs';

async function fixture(t: TestContext, { outputExists = true } = {}) {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'dev-preparation-cache-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('dev-preparation-cache-test-'));
    assert.ok(!(await lstat(root)).isSymbolicLink());
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source.txt');
  const generated = path.join(root, 'generated.txt');
  const cache = path.join(root, '.openpe/dev-preparation-v1.json');
  await writeFile(source, 'source-v1');
  if (outputExists) await writeFile(generated, 'output-v1');
  let preparations = 0;
  const messages: string[] = [];
  const logger = {
    status: (message: string) => messages.push(message),
    error: (message: string) => messages.push(message),
  };
  const run = ({
    prepare,
    cancelled = () => false,
    paths = ['source.txt', 'generated.txt'],
  }: {
    prepare?: () => Promise<void>;
    cancelled?: () => boolean;
    paths?: string[];
  } = {}) =>
    withDevPreparationCache({
      root,
      logger,
      paths,
      outputs: ['generated.txt'],
      cancelled,
      prepare: async () => {
        preparations++;
        await writeFile(generated, 'output-v1');
        await prepare?.();
      },
    });
  return { root, source, generated, cache, run, messages, count: () => preparations };
}

test('unchanged development resources reuse successful preparation', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(), false);
  assert.equal(await f.run(), true);
  assert.equal(f.count(), 1);
});

test('first preparation can publish newly created generated outputs', async (t) => {
  const f = await fixture(t, { outputExists: false });
  assert.equal(await f.run(), false);
  assert.equal(await readFile(f.generated, 'utf8'), 'output-v1');
  assert.equal(await f.run(), true);
  assert.equal(f.count(), 1);
});

for (const target of ['source', 'generated'] as const) {
  test(`same-size ${target} changes invalidate preparation even with a restored mtime`, async (t) => {
    const f = await fixture(t);
    assert.equal(await f.run(), false);
    const original = await stat(f[target]);
    await writeFile(f[target], target === 'source' ? 'source-v2' : 'output-v2');
    await utimes(f[target], original.atime, original.mtime);
    assert.equal((await stat(f[target])).size, original.size);
    assert.equal(await f.run(), false);
    assert.equal(f.count(), 2);
    assert.equal(await f.run(), true);
    assert.equal(f.count(), 2);
  });
}

test('missing generated output is recreated before a subsequent cache hit', async (t) => {
  const f = await fixture(t);
  await f.run();
  await unlink(f.generated);
  assert.equal(await f.run(), false);
  assert.equal(await readFile(f.generated, 'utf8'), 'output-v1');
  assert.equal(await f.run(), true);
  assert.equal(f.count(), 2);
});

test('a source edited during preparation cannot publish a reusable snapshot', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run({ prepare: () => writeFile(f.source, 'source-v2') }), false);
  await assert.rejects(readFile(f.cache), { code: 'ENOENT' });
  assert.equal(await f.run(), false);
  assert.equal(await f.run(), true);
  assert.equal(f.count(), 2);
});

test('failed preparation is retried and never publishes a success marker', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      prepare: async () => {
        throw new Error('Fixture preparation failed');
      },
    }),
    /Fixture preparation failed/,
  );
  await assert.rejects(readFile(f.cache), { code: 'ENOENT' });
  assert.equal(await f.run(), false);
  assert.equal(await f.run(), true);
  assert.equal(f.count(), 2);
});

test('cancellation after preparation prevents publishing a success marker', async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  assert.equal(
    await f.run({
      cancelled: () => cancelled,
      prepare: async () => {
        cancelled = true;
      },
    }),
    false,
  );
  await assert.rejects(readFile(f.cache), { code: 'ENOENT' });
  cancelled = false;
  assert.equal(await f.run({ cancelled: () => cancelled }), false);
  assert.equal(await f.run({ cancelled: () => cancelled }), true);
  assert.equal(f.count(), 2);
});

test('malformed cache data is repaired by running preparation', async (t) => {
  const f = await fixture(t);
  await f.run();
  await writeFile(f.cache, '{broken JSON');
  assert.equal(await f.run(), false);
  const repaired = await readFile(f.cache, 'utf8');
  assert.doesNotThrow(() => JSON.parse(repaired));
  assert.equal(await f.run(), true);
  assert.equal(f.count(), 2);
});

test('development resource links are rejected instead of trusted by the cache', async (t) => {
  const f = await fixture(t);
  await f.run();
  const other = path.join(f.root, 'other-source.txt');
  await writeFile(other, 'source-v1');
  await unlink(f.source);
  try {
    await symlink(other, f.source, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Creating file links is unavailable in this Windows session.');
      return;
    }
    throw error;
  }
  await assert.rejects(f.run(), /link|regular|real|symbolic/i);
  assert.equal(f.count(), 1, 'A linked source must not reach the preparation task.');
});

test('a linked cache parent never redirects cache publication outside its regular parent', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'linked-cache-target');
  const cacheParent = path.dirname(f.cache);
  await mkdir(target);
  let linked = false;
  try {
    try {
      await symlink(target, cacheParent, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Creating directory links is unavailable in this session.');
        return;
      }
      throw error;
    }
    assert.equal(await f.run(), false);
    assert.equal(await f.run(), false);
    assert.equal(f.count(), 2, 'An unavailable cache must not prevent retrying preparation.');
    assert.deepEqual(
      await readdir(target),
      [],
      'No cache marker or staging file enters the linked target.',
    );
  } finally {
    if (linked) await unlink(cacheParent);
  }
});

test('Home solver results never enter development preparation fingerprints', async (t) => {
  const f = await fixture(t);
  const paths = ['source.txt', 'generated.txt', 'examples'];
  const project = path.join(f.root, 'examples/project/emc-flyback');
  const put = async (relative: string, text: string) => {
    const target = path.join(project, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  await put('emc-flyback.kicad_pro', 'native input');
  await put('spice/run/waveforms.txt', 'saved waveform');
  await put('thermal/run/thermal.vtu', 'saved field');
  assert.equal(await f.run({ paths }), false);
  const cached = await readFile(f.cache, 'utf8');
  await put('spice/run/waveforms.txt', 'changed saved waveform');
  await put('spice/another-run/results.json', 'new saved result');
  await put('thermal/new-run/mesh.nodes', 'new mesh');
  assert.equal(await f.run({ paths }), true);
  assert.equal(await readFile(f.cache, 'utf8'), cached);
  assert.equal(f.count(), 1);
  for (const kind of ['spice', 'thermal']) {
    const target = path.resolve(project, kind);
    assert.equal(path.dirname(target), project);
    assert.ok(!(await lstat(target)).isSymbolicLink());
    await rm(target, { recursive: true });
  }
  assert.equal(await f.run({ paths }), true);
  await put('footprints/custom.pretty/custom.kicad_mod', 'changed package input');
  assert.equal(await f.run({ paths }), false);
  assert.equal(f.count(), 2, 'Native package inputs must still invalidate preparation.');
});

test('pinned original SPICE source directories remain preparation inputs', async (t) => {
  const f = await fixture(t);
  const paths = ['source.txt', 'generated.txt', 'resources/example-catalog'];
  const model = path.join(f.root, 'resources/example-catalog/sources/fixture/spice/model.lib');
  await mkdir(path.dirname(model), { recursive: true });
  await writeFile(model, 'pinned model');
  assert.equal(await f.run({ paths }), false);
  assert.equal(await f.run({ paths }), true);
  await writeFile(model, 'edited model');
  assert.equal(await f.run({ paths }), false);
  assert.equal(f.count(), 2);
});

test('first-time models and circuits outputs remain cacheable while native footprint inputs invalidate preparation', async (t) => {
  const f = await fixture(t);
  const project = path.join(f.root, 'examples/lm2596-to220-5-buck');
  const model = path.join(project, 'models/pinned.step');
  const circuit = path.join(project, 'circuits/pinned.lib');
  const footprint = path.join(project, 'footprints/custom.pretty/custom.kicad_mod');
  await mkdir(path.dirname(footprint), { recursive: true });
  await writeFile(path.join(project, 'lm2596-to220-5-buck.kicad_pro'), 'native input');
  await writeFile(footprint, 'package-v1');
  let preparations = 0;
  const run = () =>
    withDevPreparationCache({
      root: f.root,
      logger: { status: () => {}, error: () => {} },
      prepare: async () => {
        preparations++;
        await mkdir(path.dirname(model), { recursive: true });
        await mkdir(path.dirname(circuit), { recursive: true });
        await writeFile(model, 'generated STEP');
        await writeFile(circuit, 'generated SPICE');
      },
    });
  assert.equal(await run(), false);
  assert.equal(await run(), true, 'Initial output directories do not become new source inputs.');
  assert.equal(preparations, 1);
  await unlink(model);
  assert.equal(await run(), false);
  assert.equal(await readFile(model, 'utf8'), 'generated STEP');
  assert.equal(await run(), true);
  await writeFile(circuit, 'changed SPICE');
  assert.equal(await run(), false);
  assert.equal(await readFile(circuit, 'utf8'), 'generated SPICE');
  assert.equal(await run(), true);
  await writeFile(footprint, 'package-v2');
  assert.equal(await run(), false);
  assert.equal(await run(), true);
  assert.equal(preparations, 4);
});

test('generated formats are cacheable while pinned inputs stay distinct from discovered projects', async (t) => {
  const f = await fixture(t);
  const put = async (relative: string, text: string) => {
    const file = path.join(f.root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  const font = 'resources/third-party-source/newstroke-10.0.0/newstroke_font.cpp';
  const model = 'examples/project/emc-flyback/circuits/EMC_flyback_control.lib';
  await put(font, 'pinned font');
  await put(model, 'pinned EMC model');
  await mkdir(path.join(f.root, 'lib'));
  await mkdir(path.join(f.root, 'server'));
  const run = () =>
    withDevPreparationCache({
      root: f.root,
      logger: { status: () => {}, error: () => {} },
      prepare: async () => {
        await put('lib/manufacturing-font.json', 'generated font');
        await put('server/manufacturing-format.mjs', 'generated format');
        await put('server/datasheet-format.d.mts', 'generated declaration');
      },
    });
  assert.equal(await run(), false);
  assert.equal(await run(), true);
  await put('examples/customer/notes.txt', 'ordinary project content');
  assert.equal(await run(), true);
  await put(font, 'edited font source');
  assert.equal(await run(), false);
  assert.equal(await run(), true);
  await put(model, 'edited EMC model source');
  assert.equal(await run(), false);
  assert.equal(await run(), true);
});

test('relocated shared catalog and pinned footprints invalidate default preparation while shared models remain generated outputs', async (t) => {
  const f = await fixture(t);
  const catalog = path.join(f.root, 'resources/example-catalog');
  const manifest = path.join(catalog, 'manifest.json');
  const pinned = path.join(catalog, 'footprints/models/pinned.step');
  const model = path.join(catalog, 'simulation/models/pinned.lib');
  await mkdir(path.dirname(pinned), { recursive: true });
  await writeFile(manifest, 'catalog-v1');
  await writeFile(pinned, 'pinned-v1');
  let preparations = 0;
  const run = () =>
    withDevPreparationCache({
      root: f.root,
      logger: { status: () => {}, error: () => {} },
      prepare: async () => {
        preparations++;
        await mkdir(path.dirname(model), { recursive: true });
        await writeFile(model, 'generated model');
      },
    });
  assert.equal(await run(), false);
  assert.equal(await run(), true, 'First-time shared model directory creation remains cacheable.');
  await writeFile(manifest, 'catalog-v2');
  assert.equal(await run(), false);
  assert.equal(await run(), true);
  await writeFile(pinned, 'pinned-v2');
  assert.equal(await run(), false);
  assert.equal(await run(), true);
  await unlink(model);
  assert.equal(await run(), false);
  assert.equal(await readFile(model, 'utf8'), 'generated model');
  assert.equal(await run(), true);
  assert.equal(preparations, 4);
});

test('preparation hashes complete input streams without whole-file reads', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(3 * 256 * 1024 + 17, 'a');
  await writeFile(f.source, bytes);
  const originalRead = fileSystem.readFile;
  t.mock.method(fileSystem, 'readFile', async (...args: Parameters<typeof fileSystem.readFile>) => {
    if (path.resolve(String(args[0])) === f.source)
      throw new Error('Preparation attempted a whole-file input read.');
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal(await f.run(), false);
  assert.equal(await f.run(), true);
  const before = await stat(f.source);
  const handle = await open(f.source, 'r+');
  try {
    await handle.write(Buffer.from('b'), 0, 1, bytes.length - 1);
  } finally {
    await handle.close();
  }
  await utimes(f.source, before.atime, before.mtime);
  assert.equal(
    await f.run(),
    false,
    'A same-size change in the final chunk must invalidate preparation.',
  );
  assert.equal(f.count(), 2);
});

async function observeInputReads(t: TestContext, root: string, shouldFail = () => false) {
  const folder = path.join(root, 'inputs');
  await mkdir(folder);
  for (let index = 0; index < 8; index++)
    await writeFile(path.join(folder, `${index}.txt`), `input-${index}`);
  const originalOpen = fileSystem.open;
  const active = new Set<Awaited<ReturnType<typeof open>>>();
  let peak = 0;
  let delayDirection = 1;
  t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof fileSystem.open>) => {
    const handle = await originalOpen(...args);
    const file = path.resolve(String(args[0]));
    if (!file.startsWith(folder + path.sep)) return handle;
    active.add(handle);
    peak = Math.max(peak, active.size);
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      try {
        return await originalClose();
      } finally {
        active.delete(handle);
      }
    };
    const originalStat = handle.stat.bind(handle);
    handle.stat = (async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, 24 + delayDirection * Number(path.parse(file).name) * 2),
      );
      return originalStat();
    }) as typeof handle.stat;
    const originalStream = handle.createReadStream.bind(handle);
    handle.createReadStream = (options) => {
      if (shouldFail()) throw new Error('Fixture streaming failure.');
      return originalStream(options);
    };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { active, peak: () => peak, reverseDelays: () => (delayDirection *= -1) };
}

test('parallel fingerprints bound input handles and retain cache identity across completion orders', async (t) => {
  const f = await fixture(t);
  const reads = await observeInputReads(t, f.root);
  const paths = ['inputs', 'generated.txt'];
  assert.equal(await f.run({ paths }), false);
  const cached = await readFile(f.cache, 'utf8');
  reads.reverseDelays();
  assert.equal(await f.run({ paths: paths.toReversed() }), true);
  assert.equal(await readFile(f.cache, 'utf8'), cached);
  assert.equal(f.count(), 1);
  assert.ok(reads.peak() > 1 && reads.peak() <= 4, 'At most four file streams overlap.');
  assert.equal(reads.active.size, 0);
});

test('failed parallel fingerprints drain input handles and leave preparation retryable', async (t) => {
  const f = await fixture(t);
  let failing = true;
  const reads = await observeInputReads(t, f.root, () => failing);
  const paths = ['inputs', 'generated.txt'];
  await assert.rejects(f.run({ paths }), /Fixture streaming failure/);
  assert.equal(reads.active.size, 0, 'Every in-flight file is closed before failure returns.');
  assert.equal(f.count(), 0);
  await assert.rejects(readFile(f.cache), { code: 'ENOENT' });
  failing = false;
  assert.equal(await f.run({ paths }), false);
  assert.equal(await f.run({ paths }), true);
  assert.equal(reads.active.size, 0);
  assert.ok(reads.peak() <= 4);
});
