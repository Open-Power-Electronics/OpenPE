import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertSolverPlatforms,
  hostSolverPlatform,
  solverPlatforms,
} from '../server/solver-platform.mjs';
import { spiceRuntime } from '../plugins/spice-simulation/host/spice-runtime.mjs';

test('every solver lock covers all supported hosts and rejects incomplete or foreign platforms', async () => {
  for (const name of ['ngspice', 'thermal']) {
    const lock = JSON.parse(await readFile(`resources/${name}-lock.json`, 'utf8'));
    assert.deepEqual(Object.keys(lock.platforms).sort(), [...solverPlatforms].sort());
    assert.equal(assertSolverPlatforms(lock.platforms), lock.platforms[hostSolverPlatform()]);
    for (const platform of solverPlatforms) {
      const incomplete = { ...lock.platforms };
      delete incomplete[platform];
      assert.throws(() => assertSolverPlatforms(incomplete), /missing platform/);
      const entry = lock.platforms[platform];
      for (const executable of Object.values(entry.executables ?? { ngspice: entry.executable }))
        assert.match(entry.files[executable as string], /^[a-f0-9]{64}$/);
    }
    assert.throws(
      () => assertSolverPlatforms({ ...lock.platforms, 'linux-arm64': {} }),
      /Unknown solver platform/,
    );
  }
});

test('SPICE selects the bundled host executable and removes inherited solver and loader overrides', (context) => {
  for (const key of [
    'SPICE_SCRIPTS',
    'NGSPICE_INPUT_DIR',
    'OPENPE_NGSPICE',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_LIBRARY_PATH',
  ]) {
    const previous = process.env[key];
    process.env[key] = 'foreign-library-or-executable';
    context.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const root = path.resolve('trusted-bundled-spice');
  const runtime = spiceRuntime(root);
  assert.equal(
    runtime.executable,
    path.join(root, 'bin', process.platform === 'win32' ? 'ngspice_con.exe' : 'ngspice'),
  );
  assert.equal(runtime.env.SPICE_SCRIPTS, path.join(root, 'share/ngspice/scripts'));
  for (const key of [
    'NGSPICE_INPUT_DIR',
    'OPENPE_NGSPICE',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_LIBRARY_PATH',
  ])
    assert.equal((runtime.env as NodeJS.ProcessEnv)[key], undefined, key);
});
