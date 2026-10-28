import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseTestArguments, planTests } from '../scripts/test.mjs';

const runner = path.resolve('scripts/test.mjs');
const timingFile = '.openpe/test-timings-v1.json';
const passing = "import test from 'node:test'; test('passes', () => {});";

async function fixture(t: TestContext, files: Record<string, string>) {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'test-runner-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(!(await lstat(root)).isSymbolicLink());
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

async function execute(root: string, args: string[] = [], script = runner) {
  const env = { ...process.env };
  // A fixture runner is a fresh parent, rather than a recursive node:test child.
  delete env.NODE_TEST_CONTEXT;
  return new Promise<{ code: number | string; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [script, ...args],
        { cwd: root, env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && (error.killed || typeof error.code !== 'number')) reject(error);
          else resolve({ code: error?.code ?? 0, stdout, stderr });
        },
      );
    },
  );
}

test('test arguments bound default concurrency and reject unsupported or invalid options', () => {
  assert.equal(parseTestArguments([], 32).concurrency, 16);
  assert.equal(parseTestArguments([], 16).concurrency, 15);
  assert.equal(parseTestArguments([], 2).concurrency, 1);
  assert.equal(parseTestArguments([], 1).concurrency, 1);
  assert.equal(parseTestArguments(['--test-concurrency=12']).concurrency, 12);
  const filtered = parseTestArguments([
    '--test-name-pattern',
    'accepts=value',
    '--test-skip-pattern=slow',
    '--test-only',
    'tests/*.test.ts',
  ]);
  assert.deepEqual(filtered.testNamePatterns, ['accepts=value']);
  assert.deepEqual(filtered.testSkipPatterns, ['slow']);
  assert.equal(filtered.only, true);
  for (const args of [
    ['--test-concurrency=0'],
    ['--test-concurrency=1.5'],
    ['--test-concurrency'],
    ['--test-concurrency=-2'],
    ['--test-name-pattern', '['],
    ['--test-isolation=none'],
  ])
    assert.throws(() => parseTestArguments(args));
});

test('timings change scheduling while discovery includes new files and exact/glob selection deduplicates', async (t) => {
  const root = await fixture(t, {
    'tests/a.test.ts': passing,
    'tests/new.test.ts': passing,
    'tests/z.test.ts': passing,
    'tests/ignored.ts': 'throw new Error("Not a test file");',
    [timingFile]: JSON.stringify({
      version: 1,
      durations: { 'tests/a.test.ts': 10, 'tests/z.test.ts': 100, 'tests/removed.test.ts': 1000 },
    }),
  });
  const planned = await planTests([], root);
  assert.deepEqual(planned.files, ['tests/z.test.ts', 'tests/a.test.ts', 'tests/new.test.ts']);
  assert.equal(planned.full, true);
  assert.deepEqual((await planTests(['tests/[az].test.ts', 'tests/a.test.ts'], root)).files, [
    'tests/z.test.ts',
    'tests/a.test.ts',
  ]);
  await assert.rejects(planTests(['tests/missing.test.ts'], root), /No test files match/);
  for (const args of [
    ['tests/*.test.ts'],
    ['--test-name-pattern=a'],
    ['--test-skip-pattern=z'],
    ['--test-only'],
  ])
    assert.equal((await planTests(args, root)).full, false);
  for (const contents of [
    'broken JSON',
    '{"version":0,"durations":{}}',
    '{"version":1,"durations":{"tests/a.test.ts":-1}}',
  ]) {
    await writeFile(path.join(root, timingFile), contents);
    assert.deepEqual((await planTests([], root)).files, [
      'tests/a.test.ts',
      'tests/new.test.ts',
      'tests/z.test.ts',
    ]);
  }
  await rm(path.join(root, timingFile));
  assert.equal((await planTests([], root)).files.length, 3);
});

test('CLI runs TypeScript files in isolated processes, follows timing order and publishes full durations', async (t) => {
  const isolated = (name: string) => `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    enum FixtureValue { Passing = 7 }
    test('${name}', () => {
      const state = globalThis as typeof globalThis & { fixture?: string };
      assert.equal(state.fixture, undefined);
      state.fixture = '${name}';
      assert.equal(FixtureValue.Passing, 7);
      appendFileSync('order.txt', '${name}\\n');
    });
  `;
  const root = await fixture(t, {
    'tests/a.test.ts': isolated('a'),
    'tests/z.test.ts': isolated('z'),
    [timingFile]: JSON.stringify({ version: 1, durations: { 'tests/z.test.ts': 100 } }),
  });
  const result = await execute(root, ['--test-concurrency=1']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Running 2 test files with concurrency 1/);
  assert.match(result.stdout, /tests 2/);
  assert.equal(await readFile(path.join(root, 'order.txt'), 'utf8'), 'z\na\n');
  const cache = JSON.parse(await readFile(path.join(root, timingFile), 'utf8'));
  assert.equal(cache.version, 1);
  assert.deepEqual(Object.keys(cache.durations).sort(), ['tests/a.test.ts', 'tests/z.test.ts']);
  assert.ok(
    Object.values(cache.durations).every((value) => Number.isFinite(value) && Number(value) >= 0),
  );
});

test('filtered and failed runs preserve the successful full-run timing cache and execute changed files', async (t) => {
  const originalCache = JSON.stringify({ version: 1, durations: { 'tests/a.test.ts': 999 } });
  const root = await fixture(t, {
    'tests/a.test.ts': `
      import test from 'node:test';
      test.only('selected', () => {});
      test('blocked', () => { throw new Error('CHANGED_FILE_EXECUTED'); });
    `,
    [timingFile]: originalCache,
  });
  for (const args of [
    ['tests/a.test.ts', '--test-name-pattern=selected'],
    ['tests/*.test.ts', '--test-skip-pattern=blocked'],
    ['--test-only'],
  ]) {
    const result = await execute(root, args);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(await readFile(path.join(root, timingFile), 'utf8'), originalCache);
  }
  await writeFile(
    path.join(root, 'tests/a.test.ts'),
    "import test from 'node:test'; test('changed', () => { throw new Error('CHANGED_FILE_EXECUTED'); });",
  );
  const failed = await execute(root);
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /CHANGED_FILE_EXECUTED/);
  assert.equal(await readFile(path.join(root, timingFile), 'utf8'), originalCache);
});

test('aborting a run terminates its owned test child without publishing timings or force exit', async (t) => {
  const root = await fixture(t, {
    'tests/pending.test.ts': `
      import test from 'node:test';
      import { writeFileSync } from 'node:fs';
      test('pending', async () => {
        writeFileSync('ready.txt', String(process.pid));
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `,
    'cancel.mjs': `
      import { existsSync, readFileSync } from 'node:fs';
      import assert from 'node:assert/strict';
      import { runTests } from ${JSON.stringify(pathToFileURL(runner).href)};
      const controller = new AbortController();
      const timer = setInterval(() => {
        if (existsSync('ready.txt')) {
          clearInterval(timer);
          controller.abort();
        }
      }, 10);
      try {
        assert.equal(await runTests([], { signal: controller.signal }), 1);
        const child = Number(readFileSync('ready.txt', 'utf8'));
        assert.throws(() => process.kill(child, 0));
      } finally { clearInterval(timer); }
    `,
  });
  const result = await execute(root, [], path.join(root, 'cancel.mjs'));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  await assert.rejects(readFile(path.join(root, timingFile)), { code: 'ENOENT' });
});
