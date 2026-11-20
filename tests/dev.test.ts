import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createDevLogger } from '../scripts/dev-output.mjs';
import { prepareDevResources, runDev } from '../scripts/dev.mjs';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  pid = 12345;
  private closed = false;

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.kills.push(signal);
    this.finish(null, signal);
    return true;
  }
}

function output(verbose = false) {
  let stdout = '',
    stderr = '';
  const stream = (write: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, done) {
        write(chunk.toString());
        done();
      },
    });
  return {
    logger: createDevLogger({
      verbose,
      stdout: stream((text) => (stdout += text)),
      stderr: stream((text) => (stderr += text)),
    }),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      'The fake development process did not reach the expected state.',
    );
    await delay(1);
  }
}

function runner(
  t: TestContext,
  options: {
    verbose?: boolean;
    probe?: (url: string, signal: AbortSignal) => Promise<boolean>;
    useDefaultProbe?: boolean;
    startupTimeoutMs?: number;
    onSpawn?: (child: FakeChild, index: number) => void;
  } = {},
) {
  const log = output(options.verbose);
  const events = new EventEmitter();
  const children: FakeChild[] = [];
  const launches: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const spawnProcess = (file: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    const child = new FakeChild();
    children.push(child);
    launches.push({ file, args: [...args], options: spawnOptions });
    queueMicrotask(() => options.onSpawn?.(child, children.length - 1));
    return child as unknown as ChildProcess;
  };
  const result = runDev({
    verbose: options.verbose ?? false,
    prepare: false,
    logger: log.logger,
    spawnProcess: spawnProcess as typeof import('node:child_process').spawn,
    probe: options.useDefaultProbe ? undefined : (options.probe ?? (async () => true)),
    processEvents: events,
    retryDelayMs: 1,
    startupTimeoutMs: options.startupTimeoutMs ?? 1000,
  });
  t.after(async () => {
    events.emit('SIGTERM');
    for (const child of children) child.finish();
    await result;
  });
  return { ...log, events, children, launches, result };
}

test('dev output preserves UTF-8 and diagnostics while removing terminal control sequences', async () => {
  const log = output();
  const child = new FakeChild();
  const observed: string[] = [];
  log.logger.attach(child, 'renderer', { onLine: (line: string) => observed.push(line) });
  const bytes = Buffer.from('\u001b[31mWarning: 温度\u001b[0m\r\n');
  child.stderr.write(bytes.subarray(0, 4));
  child.stderr.write(bytes.subarray(4, bytes.length - 5));
  child.stderr.write(bytes.subarray(bytes.length - 5));
  child.stdout.write('\u001b]0;');
  child.stdout.write('window title\u0007Ready');
  child.stdout.end(' now');
  await delay(0);
  assert.match(log.stderr(), /Warning: 温度/);
  assert.match(log.stdout(), /Ready now/);
  assert.ok(!/[\u001b\r\u0007]/.test(log.stdout() + log.stderr()));
  assert.ok(!log.stdout().includes('window title'));
  assert.ok(observed.some((line) => line.includes('Ready now')));
});

test('quiet preparation retains downloads and warnings and replays a bounded failure tail', () => {
  const log = output();
  const child = new FakeChild();
  const attached = log.logger.attach(child, 'prepare', { quiet: true });
  child.stdout.write('Routine fixture success\n');
  child.stdout.write('Downloading pinned model.lib\n');
  child.stderr.write('Warning: source archive requires repair\n');
  assert.ok(!log.stdout().includes('Routine fixture success'));
  assert.match(log.stdout(), /Downloading pinned model\.lib/);
  assert.match(log.stderr(), /Warning: source archive requires repair/);
  child.stdout.write('discard-start\n' + 'x'.repeat(80_000) + '\nDetailed failure context\n');
  attached.replayStdout();
  const replay = log.stdout() + log.stderr();
  assert.match(replay, /Detailed failure context/);
  assert.ok(!replay.includes('discard-start'));
  assert.ok(Buffer.byteLength(replay) < 70_000, 'Failure replay remains bounded.');
});

test('verbose dev output forwards raw bytes once without adding child prefixes', () => {
  const log = output(true);
  const child = new FakeChild();
  const attached = log.logger.attach(child, 'renderer', { quiet: true });
  const stdout = '\u001b[32mComplete details\u001b[0m\r\n';
  const stderr = '\u001b[31mOriginal warning\u001b[0m\n';
  child.stdout.write(stdout);
  child.stderr.write(stderr);
  attached.replayStdout();
  assert.equal(log.stdout(), stdout);
  assert.equal(log.stderr(), stderr);
});

test('failure replay bounds Unicode by bytes without splitting UTF-8 characters or surrogate pairs', () => {
  for (const padding of [0, 1, 2, 3]) {
    const log = output();
    const child = new FakeChild();
    const attached = log.logger.attach(child, 'prepare', { quiet: true });
    child.stdout.write('Discarded Unicode output prefix\n');
    const bytes = Buffer.from('温度🌡️'.repeat(20_000) + 'x'.repeat(padding) + '\n');
    child.stdout.write(bytes.subarray(0, 8));
    child.stdout.write(bytes.subarray(8));
    child.stdout.write('Latest failure context: Δ\n');
    attached.replayStdout();
    const replay = log.stdout() + log.stderr();
    assert.ok(
      Buffer.byteLength(replay) <= 66 * 1024,
      'The 64 KiB tail plus labels remains bounded.',
    );
    assert.match(replay, /Latest failure context: Δ/);
    assert.ok(!replay.includes('Discarded Unicode output prefix'));
    assert.ok(
      !replay.includes('\ufffd'),
      'A byte boundary must not create a replacement character.',
    );
    assert.ok(
      !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(replay),
      'A boundary must preserve complete surrogate pairs.',
    );
  }
});

test('development preparation overlaps solver checks and formats without racing shared solver files', async () => {
  const log = output();
  const calls: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const resources = new Map<string, FakeChild>();
  const env = { ...process.env, OPENPE_DEV_FIXTURE: 'retained' };
  const preparing = prepareDevResources({
    logger: log.logger,
    env,
    cache: false,
    spawnProcess: ((file: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ file, args: [...args], options });
      const child = new FakeChild();
      const name = path.basename(args.at(-1)!);
      if (['prepare-ngspice.mjs', 'prepare-thermal.mjs', 'build-format.mjs'].includes(name))
        resources.set(name, child);
      else queueMicrotask(() => child.finish());
      return child as unknown as ChildProcess;
    }) as typeof import('node:child_process').spawn,
  });
  assert.equal(resources.size, 2);
  assert.ok(!resources.has('prepare-ngspice.mjs'));
  resources.get('build-format.mjs')!.finish();
  await delay(0);
  assert.equal(calls.length, 2, 'Home preparation waits for the thermal runtime.');
  resources.get('prepare-thermal.mjs')!.finish();
  await until(() => calls.length === 7);
  resources.get('prepare-ngspice.mjs')!.finish();
  await preparing;
  assert.deepEqual(
    calls.map((call) => path.basename(call.args.at(-1)!)),
    [
      'prepare-thermal.mjs',
      'build-format.mjs',
      'prepare-ngspice.mjs',
      'prepare-emc-analytical-models.ts',
      'download-manufacturer-models.mjs',
      'download-example-models.ts',
      'prepare-default-examples.ts',
    ],
  );
  for (const call of calls) {
    assert.equal(call.file, process.execPath);
    assert.notEqual(call.options.shell, true);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env?.OPENPE_DEV_FIXTURE, 'retained');
    if (call.args.at(-1)!.endsWith('.ts')) assert.ok(call.args.includes('tsx'));
  }
});

test('failed development preparation stops subsequent steps and preserves its diagnostics', async () => {
  const log = output();
  let calls = 0;
  await assert.rejects(
    prepareDevResources({
      logger: log.logger,
      cache: false,
      spawnProcess: ((_file: string, args: readonly string[]) => {
        const child = new FakeChild();
        calls++;
        const failing = args.at(-1) === 'scripts/build-format.mjs';
        queueMicrotask(() => {
          if (failing) {
            child.stdout.write('Pinned model integrity context\n');
            child.stderr.write('Model download failed\n');
          }
          child.finish(failing ? 3 : 0);
        });
        return child as unknown as ChildProcess;
      }) as typeof import('node:child_process').spawn,
    }),
  );
  assert.ok(calls <= 3, 'No Home child can start after format preparation fails.');
  assert.match(log.stdout() + log.stderr(), /Pinned model integrity context/);
  assert.match(log.stderr(), /Model download failed/);
});

test('the desktop starts only after its renderer announces readiness and a successful probe', async (t) => {
  let probes = 0;
  const dev = runner(t, { probe: async () => (++probes, true) });
  await until(() => dev.children.length === 1);
  dev.children[0].stdout.write('Renderer is still compiling\n');
  await delay(10);
  assert.equal(probes, 0, 'An unrelated server already on port 3000 cannot establish readiness.');
  assert.equal(dev.children.length, 1);
  dev.children[0].stdout.write('✓ Ready in 5ms\n');
  await until(() => dev.children.length === 2);
  assert.ok(probes > 0);
  assert.equal(dev.launches[1].options.env?.OPENPE_DEV_URL, 'http://127.0.0.1:3000');
  dev.children[0].stdout.write('✓ Ready in 1ms\n');
  await delay(5);
  assert.equal(dev.children.length, 2, 'Repeated renderer status cannot open another desktop.');
  dev.children[1].finish();
  assert.equal(await dev.result, 0);
  assert.equal(dev.children[0].kills.length, 1);
  assert.equal(dev.children[1].kills.length, 0);
  assert.equal(dev.events.listenerCount('SIGINT'), 0);
  assert.equal(dev.events.listenerCount('SIGTERM'), 0);
});

test('renderer failure before readiness never starts a desktop or waits for the startup deadline', async (t) => {
  const dev = runner(t, {
    onSpawn: (child) => {
      child.stderr.write('Error: listen EADDRINUSE: address already in use\n');
      child.finish(2);
    },
  });
  assert.notEqual(await dev.result, 0);
  assert.equal(dev.children.length, 1);
  assert.match(dev.stderr(), /EADDRINUSE/);
});

test('missing renderer readiness times out without probing or opening a desktop', async (t) => {
  let probes = 0;
  const dev = runner(t, {
    startupTimeoutMs: 25,
    probe: async () => (++probes, true),
  });
  assert.notEqual(await dev.result, 0);
  assert.equal(probes, 0);
  assert.equal(dev.children.length, 1);
  assert.equal(dev.children[0].kills.length, 1);
  assert.match(dev.stderr(), /timed out|timeout/i);
});

test('a renderer whose HTTP probe remains unsuccessful cannot start the desktop', async (t) => {
  let probes = 0;
  const dev = runner(t, {
    startupTimeoutMs: 25,
    probe: async () => (++probes, false),
    onSpawn: (child) => child.stdout.write('✓ Ready in 1ms\n'),
  });
  assert.notEqual(await dev.result, 0);
  assert.ok(probes > 0);
  assert.equal(dev.children.length, 1);
  assert.equal(dev.children[0].kills.length, 1);
});

test('a renderer request stays in flight until it responds and releases the response body', async (t) => {
  const renderer = Promise.withResolvers<Response>();
  let requestedSignal: AbortSignal | null | undefined;
  const request = t.mock.method(
    globalThis,
    'fetch',
    async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      requestedSignal = options?.signal;
      assert.equal(options?.redirect, 'error');
      return renderer.promise;
    },
  );
  const dev = runner(t, {
    useDefaultProbe: true,
    onSpawn: (child, index) => {
      if (!index) child.stdout.write('✓ Ready in 1ms\n');
    },
  });
  await until(() => request.mock.callCount() === 1);
  assert.equal(dev.children.length, 1);
  assert.equal(requestedSignal?.aborted, false);
  let released = false;
  renderer.resolve(
    new Response(
      new ReadableStream({
        cancel: () => {
          released = true;
        },
      }),
    ),
  );
  await until(() => dev.children.length === 2);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(released, true);
  assert.equal(requestedSignal?.aborted, true);
  dev.children[1].finish();
  assert.equal(await dev.result, 0);
});

test('the startup deadline aborts an in-flight renderer probe', async (t) => {
  let requestedSignal: AbortSignal | undefined;
  const dev = runner(t, {
    startupTimeoutMs: 50,
    probe: async (_url, signal) => {
      requestedSignal = signal;
      return new Promise<boolean>(() => {});
    },
    onSpawn: (child, index) => {
      if (!index) child.stdout.write('✓ Ready in 1ms\n');
    },
  });
  assert.equal(await dev.result, 1);
  assert.equal(requestedSignal?.aborted, true);
  assert.equal(dev.children.length, 1);
  assert.equal(dev.children[0].kills.length, 1);
});

test('process spawn errors report failure rather than opening a desktop', async (t) => {
  const dev = runner(t, {
    onSpawn: (child) => {
      child.emit('error', new Error('Fixture executable could not start'));
      child.finish(1);
    },
  });
  assert.notEqual(await dev.result, 0);
  assert.equal(dev.children.length, 1);
  assert.match(dev.stderr(), /could not start/);
});

test('the development runner preserves a nonzero desktop exit code and stops its renderer', async (t) => {
  const dev = runner(t, {
    onSpawn: (child, index) => {
      if (!index) child.stdout.write('✓ Ready in 1ms\n');
    },
  });
  await until(() => dev.children.length === 2);
  dev.children[1].finish(7);
  assert.equal(await dev.result, 7);
  assert.equal(dev.children[0].kills.length, 1);
});

test('an unexpected renderer exit reports failure but leaves the live desktop available', async (t) => {
  const dev = runner(t, {
    onSpawn: (child, index) => {
      if (!index) child.stdout.write('✓ Ready in 1ms\n');
    },
  });
  await until(() => dev.children.length === 2);
  dev.children[0].finish(4);
  await delay(5);
  assert.equal(
    dev.children[1].kills.length,
    0,
    'Do not force-close a desktop containing unsaved work.',
  );
  assert.match(dev.stderr(), /renderer|Next/i);
  dev.children[1].finish();
  assert.notEqual(await dev.result, 0);
});

test("Ctrl+C stops only this runner's owned children and removes signal listeners", async (t) => {
  const dev = runner(t, {
    onSpawn: (child, index) => {
      if (!index) child.stdout.write('✓ Ready in 1ms\n');
    },
  });
  await until(() => dev.children.length === 2);
  dev.events.emit('SIGINT');
  assert.equal(await dev.result, 0);
  assert.equal(dev.children[0].kills.length, 1);
  assert.equal(dev.children[1].kills.length, 1);
  assert.equal(dev.events.listenerCount('SIGINT'), 0);
  assert.equal(dev.events.listenerCount('SIGTERM'), 0);
});

test('cancelling renderer startup returns without opening a desktop', async (t) => {
  const dev = runner(t);
  await until(() => dev.children.length === 1);
  dev.events.emit('SIGTERM');
  assert.equal(await dev.result, 0);
  assert.equal(dev.children.length, 1);
  assert.equal(dev.children[0].kills.length, 1);
  assert.equal(dev.events.listenerCount('SIGINT'), 0);
  assert.equal(dev.events.listenerCount('SIGTERM'), 0);
});
