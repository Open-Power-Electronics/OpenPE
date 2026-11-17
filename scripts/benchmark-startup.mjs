import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Measure total service/example preparation in fresh Node processes, independently
// of the desktop's concurrent renderer startup and first paint.
// Never launch Electron, providers, a solver, or read the user's application data.
const script = fileURLToPath(import.meta.url);
const worker = process.argv[2] === '--worker';
if (worker) {
  const start = performance.now();
  const { FileGrants } = createRequire(import.meta.url)('../electron/file-grants.cjs');
  const { startServer } = await import('../server/index.mjs');
  const { ProjectHistory } = await import('../server/project-history.mjs');
  const { ExampleProjects } = await import('../server/example-projects.mjs');
  const imported = performance.now();
  const dataDir = process.argv[3];
  const grants = new FileGrants();
  const history = new ProjectHistory(dataDir, grants);
  let gitCommands = 0;
  const run = history.run.bind(history);
  history.run = (...args) => {
    gitCommands++;
    return run(...args);
  };
  let service;
  try {
    const examples = new ExampleProjects(path.resolve('examples'), grants, history);
    const catalogReady = performance.now();
    const warnings = await examples.prepare();
    assert.deepEqual(
      warnings,
      [],
      'The benchmark requires working Git and valid bundled examples.',
    );
    const examplesReady = performance.now();
    service = await startServer({ dataDir });
    const ready = performance.now();
    const ms = (duration) => Math.round(duration * 10) / 10;
    console.log(
      JSON.stringify({
        importsMs: ms(imported - start),
        catalogMs: ms(catalogReady - imported),
        examplesMs: ms(examplesReady - catalogReady),
        serviceMs: ms(ready - examplesReady),
        totalMs: ms(ready - start),
        gitCommands,
      }),
    );
  } finally {
    history.close();
    service?.close();
  }
} else {
  const count = process.argv[2] === undefined ? 3 : Number(process.argv[2]);
  assert.ok(
    Number.isInteger(count) && count >= 1 && count <= 5,
    'Usage: node scripts/benchmark-startup.mjs [samples: 1-5]',
  );
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-startup-benchmark-'));
  const measure = (directory) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--worker', directory], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '',
        size = 0;
      let failure;
      const stop = (message) => {
        failure = new Error(message);
        child.kill();
      };
      const timer = setTimeout(() => stop('Startup benchmark timed out.'), 180_000);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 100_000) stop('Startup benchmark output exceeded its limit.');
        else stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        size += chunk.length;
        if (size > 100_000) stop('Startup benchmark output exceeded its limit.');
        else stderr += chunk;
      });
      child.on('error', (error) => {
        failure = error;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(stderr || `Benchmark exited with ${code}.`));
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  try {
    const results = { fresh: [], existing: [] };
    for (let sample = 0; sample < count; sample++) {
      const directory = path.join(root, String(sample));
      for (const mode of ['fresh', 'existing']) {
        const result = await measure(directory);
        results[mode].push(result);
        console.log(JSON.stringify({ mode, sample: sample + 1, ...result }));
      }
    }
    const median = (values) => {
      values.sort((a, b) => a - b);
      return (
        (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
      );
    };
    console.log(
      JSON.stringify({
        medianTotalMs: Object.fromEntries(
          Object.entries(results).map(([mode, samples]) => [
            mode,
            median(samples.map((s) => s.totalMs)),
          ]),
        ),
      }),
    );
  } finally {
    // Only remove the exact temporary directory allocated by this invocation.
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('openpe-startup-benchmark-'));
    await rm(root, { recursive: true, force: true });
  }
}
