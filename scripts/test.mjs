import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

const timingFile = '.openpe/test-timings-v1.json';

export function parseTestArguments(args, cpus = availableParallelism()) {
  const options = {
    concurrency: Math.max(1, Math.min(16, cpus - 1)),
    files: [],
    testNamePatterns: [],
    testSkipPatterns: [],
    only: false,
  };
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--' && !positional) {
      positional = true;
      continue;
    }
    if (positional || !arg.startsWith('-')) {
      options.files.push(arg);
      continue;
    }
    if (arg === '--test-only') {
      options.only = true;
      continue;
    }
    const [flag, ...inline] = arg.split('=');
    if (!['--test-concurrency', '--test-name-pattern', '--test-skip-pattern'].includes(flag))
      throw new Error(`Unsupported test option: ${arg}`);
    const value = inline.length ? inline.join('=') : args[++index];
    if (value === undefined || (!inline.length && value.startsWith('--')))
      throw new Error(`Missing value for ${flag}.`);
    if (flag === '--test-concurrency') {
      const number = Number(value);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number))
        throw new Error('Test concurrency must be a positive integer.');
      options.concurrency = number;
    } else {
      new RegExp(value);
      options[flag === '--test-name-pattern' ? 'testNamePatterns' : 'testSkipPatterns'].push(value);
    }
  }
  return options;
}

async function readTimings(root) {
  try {
    const file = path.join(root, timingFile);
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return {};
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (
      data.version === 1 &&
      data.durations &&
      typeof data.durations === 'object' &&
      !Array.isArray(data.durations) &&
      Object.values(data.durations).every((ms) => Number.isFinite(ms) && ms >= 0)
    )
      return data.durations;
  } catch {
    // Timings only choose execution order. Missing or damaged caches change no coverage.
  }
  return {};
}

export async function planTests(args = [], root = process.cwd()) {
  const options = parseTestArguments(args);
  const allFiles = (await readdir(path.join(root, 'tests'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  const selected = new Set();
  for (const selector of options.files) {
    const pattern = (path.isAbsolute(selector) ? path.relative(root, selector) : selector)
      .replaceAll('\\', '/')
      .replace(/^\.\//, '');
    const matches = allFiles.filter((file) => path.matchesGlob(file, pattern));
    if (!matches.length) throw new Error(`No test files match: ${selector}`);
    for (const file of matches) selected.add(file);
  }
  const durations = await readTimings(root);
  const files = options.files.length ? [...selected] : allFiles;
  if (!files.length) throw new Error('No test files found in tests/*.test.ts.');
  files.sort((a, b) => (durations[b] ?? 0) - (durations[a] ?? 0) || a.localeCompare(b));
  const full =
    !options.files.length &&
    !options.testNamePatterns.length &&
    !options.testSkipPatterns.length &&
    !options.only;
  return { ...options, files, full };
}

async function saveTimings(root, durations, signal) {
  const target = path.join(root, timingFile);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    if (!(await lstat(path.dirname(target))).isDirectory()) return;
    const existing = await lstat(target).catch(() => null);
    if (existing && !existing.isFile()) return;
    const file = await open(temporary, 'wx');
    created = true;
    try {
      await file.writeFile(JSON.stringify({ version: 1, durations }, null, 2) + '\n');
    } finally {
      await file.close();
    }
    if (!signal?.aborted) await rename(temporary, target);
  } catch {
    // A read-only or unavailable cache must never fail a completed test run.
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

export async function runTests(
  args = [],
  { root = process.cwd(), signal, output = process.stdout } = {},
) {
  const plan = await planTests(args, root);
  if (signal?.aborted) return 1;
  output.write(`Running ${plan.files.length} test files with concurrency ${plan.concurrency}.\n`);
  const durations = {};
  let success = false;
  const tests = run({
    cwd: root,
    files: plan.files.map((file) => path.join(root, file)),
    concurrency: plan.concurrency,
    isolation: 'process',
    execArgv: ['--import', 'tsx'],
    testNamePatterns: plan.testNamePatterns.length ? plan.testNamePatterns : undefined,
    testSkipPatterns: plan.testSkipPatterns.length ? plan.testSkipPatterns : undefined,
    only: plan.only,
    signal,
    setup(stream) {
      stream.on('test:summary', (summary) => {
        if (summary.file) {
          const file = path.relative(root, summary.file).replaceAll('\\', '/');
          if (summary.success && plan.files.includes(file)) durations[file] = summary.duration_ms;
        } else success = summary.success;
      });
    },
  });
  const reporter = tests.compose(spec);
  reporter.pipe(output, { end: false });
  await finished(reporter);
  if (!success || signal?.aborted) return 1;
  if (plan.full && Object.keys(durations).length === plan.files.length)
    await saveTimings(root, durations, signal);
  return signal?.aborted ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    process.exitCode = await runTests(process.argv.slice(2), { signal: controller.signal });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
