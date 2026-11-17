import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { examplePreparation, formatPreparation, solverVerification } from './dev.mjs';

const architectureCheck = [['scripts/check-architecture.mjs']];
const nextBuild = [['node_modules/next/dist/bin/next', 'build']];

/** Run Node argument lists in order; buffered output is returned instead of streamed. */
async function runSequence(spawnProcess, commands, { buffered = false } = {}) {
  let output = '';
  for (const args of commands) {
    const code = await new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, args, {
        stdio: buffered ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        windowsHide: true,
      });
      if (buffered)
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (chunk) => (output += chunk));
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve(signal ? 1 : exitCode));
    });
    if (code !== 0) return { code, output, failed: args.at(-1) };
  }
  return { code: 0, output };
}

/**
 * Production build: formats, then the architecture check beside Home example
 * preparation, with solver verification concurrent throughout. Any failure
 * stops before the renderer build. `--examples` prepares only formats and Home.
 * @param {{ args?: string[], spawnProcess?: typeof spawn, output?: NodeJS.WritableStream }} [options]
 */
export async function runBuild({ args = [], spawnProcess = spawn, output = process.stdout } = {}) {
  const examplesOnly = args.length === 1 && args[0] === '--examples';
  if (args.length && !examplesOnly) throw new Error('Usage: node scripts/build.mjs [--examples]');
  const run = (commands, options) => runSequence(spawnProcess, commands, options);
  const prepareProjects = async () => {
    const format = await run(formatPreparation[1]);
    if (format.code !== 0) return [format];
    // The architecture check resolves generated format modules, so it starts only
    // after they are current and runs beside example preparation.
    return Promise.all([
      examplesOnly ? null : run(architectureCheck, { buffered: true }),
      run(examplePreparation[1]),
    ]);
  };
  const [projects, solvers] = await Promise.all([
    prepareProjects(),
    // Solver resource verification shares no inputs or outputs with format/example preparation.
    examplesOnly ? null : run(solverVerification[1], { buffered: true }),
  ]);
  const results = [...projects, solvers];
  for (const result of results) if (result?.output) output.write(result.output);
  for (const result of results)
    if (result && result.code !== 0) {
      console.error(`Build stopped: ${result.failed} exited with ${result.code}.`);
      return result.code;
    }
  if (examplesOnly) return 0;
  return (await run(nextBuild)).code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runBuild({ args: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
