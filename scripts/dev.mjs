import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDevLogger } from './dev-output.mjs';
import { withDevPreparationCache } from './dev-preparation-cache.mjs';

const rendererURL = 'http://127.0.0.1:3000';
/** Node argument lists shared by development startup and `scripts/build.mjs`. */
export const formatPreparation = ['Preparing project formats', [['scripts/build-format.mjs']]];
export const examplePreparation = [
  'Preparing Home projects and models',
  [
    ['--import', 'tsx', 'scripts/prepare-emc-analytical-models.ts'],
    ['scripts/download-manufacturer-models.mjs'],
    ['--import', 'tsx', 'scripts/download-example-models.ts'],
    ['--import', 'tsx', 'scripts/prepare-default-examples.ts'],
  ],
];
export const solverVerification = [
  'Verifying solver resources',
  [['scripts/prepare-ngspice.mjs'], ['scripts/prepare-thermal.mjs']],
];
const preparations = [formatPreparation, examplePreparation, solverVerification];

function launch(spawnProcess, args, env, logger, label, outputOptions) {
  const child = spawnProcess(process.execPath, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });
  const done = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const capture = logger.attach(child, label, outputOptions);
  return { child, done, capture };
}

function failure(label, result) {
  const detail =
    result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit ${result.code}`);
  const error = new Error(`${label} stopped (${detail}).`);
  error.exitCode = result.code || 1;
  return error;
}

export async function prepareDevResources({
  spawnProcess = spawn,
  logger = createDevLogger(),
  env = process.env,
  cache = true,
  cancelled = () => false,
} = {}) {
  const run = async (steps) => {
    for (const [message, commands] of steps) {
      logger.status(message);
      for (const args of commands) {
        const task = launch(spawnProcess, args, env, logger, 'prepare', { quiet: true });
        const result = await task.done;
        if (result.error || result.code !== 0) {
          task.capture.replayStdout();
          throw failure(message, result);
        }
      }
    }
  };
  const prepare = () => run(preparations.slice(0, 2));
  if (cache) await withDevPreparationCache({ logger, prepare, cancelled });
  else await prepare();
  if (!cancelled()) await run(preparations.slice(2));
}

export async function runDev({
  verbose = false,
  spawnProcess = spawn,
  probe = async (url) => (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok,
  startupTimeoutMs = 60000,
  retryDelayMs = 500,
  processEvents = /** @type {Pick<import('node:events').EventEmitter, 'on' | 'off'>} */ (process),
  prepare = true,
  logger = createDevLogger({ verbose }),
} = {}) {
  const env = { ...process.env, OPENPE_DEV_VERBOSE: verbose ? '1' : '0' };
  if (!verbose) {
    delete env.FORCE_COLOR;
    env.NO_COLOR = '1';
  }
  const owned = new Set();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of owned) if (child.exitCode == null && !child.killed) child.kill();
  };
  const spawnOwned = (...args) => {
    if (stopping) throw new Error('Development startup cancelled.');
    const child = spawnProcess(...args);
    owned.add(child);
    const release = () => owned.delete(child);
    child.once('close', release);
    child.once('error', release);
    return child;
  };
  processEvents.on('SIGINT', stop);
  processEvents.on('SIGTERM', stop);
  try {
    logger.status('Development');
    if (prepare)
      await prepareDevResources({
        spawnProcess: spawnOwned,
        logger,
        env,
        cancelled: () => stopping,
      });
    if (stopping) return 0;
    logger.status('Starting renderer');
    let markReady;
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });
    const renderer = launch(
      spawnOwned,
      ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3000'],
      env,
      logger,
      'renderer',
      {
        onLine: (line, stream) => {
          if (stream === 'stdout' && /^\s*✓?\s*Ready in\b/.test(line)) markReady();
        },
      },
    );
    let rendererResult;
    const rendererExit = renderer.done.then((result) => {
      rendererResult = result;
      throw failure('Renderer', result);
    });
    // Keep an exit observable while starting, without an unhandled rejection
    // after startup when the desktop owns the remaining session lifetime.
    rendererExit.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Renderer startup timed out.')), startupTimeoutMs);
    });
    try {
      // An unrelated server on port 3000 cannot make this launch ready.
      await Promise.race([ready, rendererExit, timeout]);
      for (;;) {
        let available = false;
        try {
          available = await Promise.race([probe(rendererURL), rendererExit, timeout]);
        } catch (error) {
          if (rendererResult || error.message === 'Renderer startup timed out.') throw error;
        }
        if (rendererResult) throw failure('Renderer', rendererResult);
        if (available) break;
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, retryDelayMs)),
          rendererExit,
          timeout,
        ]);
      }
    } finally {
      clearTimeout(timer);
    }
    if (stopping) return 0;
    logger.status(`Renderer ready: ${rendererURL}`);
    logger.status('Starting Electron');
    const desktop = launch(
      spawnOwned,
      ['node_modules/electron/cli.js', '.'],
      { ...env, OPENPE_DEV_URL: rendererURL },
      logger,
      'desktop',
    );
    let desktopClosed = false;
    desktop.done.then(() => {
      desktopClosed = true;
    });
    renderer.done.then((result) => {
      if (!stopping && !desktopClosed) {
        logger.error(
          `${failure('Renderer', result).message} Close the desktop window after saving your work.`,
        );
      }
    });
    const result = await desktop.done;
    if (stopping) return 0;
    if (result.error || result.code !== 0) throw failure('Electron', result);
    if (rendererResult) throw failure('Renderer', rendererResult);
    logger.status('Development stopped');
    return 0;
  } catch (error) {
    if (stopping) return 0;
    logger.error(verbose ? (error.stack ?? error.message) : error.message);
    return error.exitCode || 1;
  } finally {
    stop();
    processEvents.off('SIGINT', stop);
    processEvents.off('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--verbose')) {
    console.error('Usage: npm run dev -- [--verbose]');
    process.exitCode = 1;
  } else process.exitCode = await runDev({ verbose: args.includes('--verbose') });
}
