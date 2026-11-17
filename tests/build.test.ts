import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runBuild } from '../scripts/build.mjs';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  finish(code: number) {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }
}

function harness(exitCodes: Record<string, number> = {}) {
  const events: string[] = [];
  const pending = new Map<string, FakeChild>();
  const launches: { step: string; options: SpawnOptions }[] = [];
  const spawnProcess = (file: string, args: readonly string[], options: SpawnOptions) => {
    assert.equal(file, process.execPath);
    const step = path.basename(args.at(-1)!) === 'build' ? 'next' : path.basename(args.at(-1)!);
    const child = new FakeChild();
    events.push(`start ${step}`);
    launches.push({ step, options });
    pending.set(step, child);
    return child as unknown as ChildProcess;
  };
  let written = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  const finish = async (step: string) => {
    for (let wait = 0; !pending.has(step); wait++) {
      assert.ok(wait < 1000, `${step} was not started.`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const child = pending.get(step)!;
    pending.delete(step);
    if (step === 'check-architecture.mjs') child.stdout.write('Architecture output\n');
    events.push(`finish ${step}`);
    child.finish(exitCodes[step] ?? 0);
  };
  return {
    events,
    launches,
    pending,
    finish,
    output: () => written,
    spawnProcess: spawnProcess as typeof import('node:child_process').spawn,
    sink: output,
  };
}

test('production build verifies solvers concurrently and checks architecture after formats', async () => {
  const build = harness();
  const result = runBuild({ spawnProcess: build.spawnProcess, output: build.sink });
  await build.finish('build-format.mjs');
  await build.finish('check-architecture.mjs');
  await build.finish('prepare-emc-analytical-models.ts');
  await build.finish('download-manufacturer-models.mjs');
  await build.finish('download-example-models.ts');
  await build.finish('prepare-ngspice.mjs');
  await build.finish('prepare-default-examples.ts');
  await build.finish('prepare-thermal.mjs');
  await build.finish('next');
  assert.equal(await result, 0);
  const order = build.events.filter((event) => event.startsWith('start'));
  assert.deepEqual(
    order.slice(0, 2).sort(),
    ['start build-format.mjs', 'start prepare-ngspice.mjs'],
    'Solver verification starts before format generation finishes.',
  );
  assert.ok(
    build.events.indexOf('start check-architecture.mjs') >
      build.events.indexOf('finish build-format.mjs'),
    'Architecture inspects the generated format modules written by this build.',
  );
  assert.equal(order.at(-1), 'start next');
  assert.ok(
    ['check-architecture.mjs', 'prepare-default-examples.ts', 'prepare-thermal.mjs'].every(
      (step) => build.events.indexOf(`finish ${step}`) < build.events.indexOf('start next'),
    ),
  );
  for (const { step, options } of build.launches) {
    assert.equal(options.windowsHide, true);
    assert.notEqual(options.shell, true);
    const buffered = ['check-architecture.mjs', 'prepare-ngspice.mjs', 'prepare-thermal.mjs'];
    assert.equal(options.stdio === 'inherit', !buffered.includes(step), step);
  }
  assert.match(build.output(), /Architecture output/);
});

for (const failing of [
  'build-format.mjs',
  'check-architecture.mjs',
  'prepare-default-examples.ts',
  'prepare-thermal.mjs',
])
  test(`production build stops before the renderer when ${failing} fails`, async () => {
    const build = harness({ [failing]: 5 });
    const result = runBuild({ spawnProcess: build.spawnProcess, output: build.sink });
    await build.finish('prepare-ngspice.mjs');
    await build.finish('prepare-thermal.mjs');
    await build.finish('build-format.mjs');
    if (failing !== 'build-format.mjs')
      for (const step of [
        'check-architecture.mjs',
        'prepare-emc-analytical-models.ts',
        'download-manufacturer-models.mjs',
        'download-example-models.ts',
        'prepare-default-examples.ts',
      ])
        await build.finish(step);
    assert.equal(await result, 5);
    assert.ok(!build.events.includes('start next'));
    if (failing === 'build-format.mjs') {
      assert.ok(!build.events.includes('start check-architecture.mjs'));
      assert.ok(!build.events.includes('start prepare-emc-analytical-models.ts'));
      assert.ok(!build.events.includes('start download-manufacturer-models.mjs'));
      assert.ok(!build.events.includes('start download-example-models.ts'));
    }
    assert.equal(build.pending.size, 0);
  });

test('example preparation runs only formats and Home projects', async () => {
  const build = harness();
  const result = runBuild({
    args: ['--examples'],
    spawnProcess: build.spawnProcess,
    output: build.sink,
  });
  await build.finish('build-format.mjs');
  await build.finish('prepare-emc-analytical-models.ts');
  await build.finish('download-manufacturer-models.mjs');
  await build.finish('download-example-models.ts');
  await build.finish('prepare-default-examples.ts');
  assert.equal(await result, 0);
  assert.deepEqual(
    build.events.filter((event) => event.startsWith('start')),
    [
      'start build-format.mjs',
      'start prepare-emc-analytical-models.ts',
      'start download-manufacturer-models.mjs',
      'start download-example-models.ts',
      'start prepare-default-examples.ts',
    ],
  );
  await assert.rejects(runBuild({ args: ['--watch'], spawnProcess: build.spawnProcess }), {
    message: 'Usage: node scripts/build.mjs [--examples]',
  });
});
