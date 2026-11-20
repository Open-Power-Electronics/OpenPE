import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SimulationResult, SpiceDeck } from '../plugins/spice-simulation/domain/spice';
import {
  buildSpiceDeck,
  defaultTransient,
  type TransientConfig,
} from '../plugins/spice-simulation/domain/spice';
import { createProject, serializeProject } from '../lib/project';
import { createProjectSpiceStore } from '../server/project-spice-files.mjs';
import { switchingStageFixture } from './fixtures/switching-stage';

const solverPlatform = `${process.platform}-${process.arch}`;
const ngspiceExecutable =
  solverPlatform === 'win32-x64'
    ? 'ngspice_con.exe'
    : solverPlatform === 'darwin-arm64'
      ? 'ngspice'
      : '';

function completedRawFixture(deck: SpiceDeck) {
  const variables = [
    '0 time time',
    ...deck.traces.map(
      (trace, index) =>
        `${index + 1} ${trace.vector.startsWith('@') ? `i(${trace.vector})` : trace.vector} ${trace.unit === 'V' ? 'voltage' : 'current'}`,
    ),
  ];
  const header = `Title: Persistence fixture\nPlotname: Transient Analysis\nFlags: real\nNo. Variables: ${variables.length}\nNo. Points: 3\nVariables:\n${variables.join('\n')}\nBinary:\n`;
  const values = Buffer.alloc(3 * variables.length * 8);
  [0, deck.stop * 0.9, deck.stop].forEach((time, row) => {
    values.writeDoubleLE(time, row * variables.length * 8);
    deck.traces.forEach((_trace, column) =>
      values.writeDoubleLE(row ? 5 : 0, (row * variables.length + column + 1) * 8),
    );
  });
  return Buffer.concat([Buffer.from(header), values]);
}

test(
  'runner reuses project results across fresh module instances, rechecking solver/models and invalidating changes',
  { skip: !ngspiceExecutable },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-persisted-run-'));
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin', ngspiceExecutable), 'solver fixture');
    const originalExecFile = childProcess.execFile;
    let detections = 0,
      runs = 0,
      modelReads = 0;
    let fail = false;
    let convergenceOnce = false;
    const directories: string[] = [];
    childProcess.execFile = Object.assign(
      () => {
        throw new Error('Use fixture detection.');
      },
      {
        [promisify.custom]: async () => {
          detections++;
          return { stdout: 'ngspice-47 fixture', stderr: '' };
        },
      },
    ) as unknown as typeof childProcess.execFile;
    context.mock.method(
      childProcess,
      'spawn',
      (_executable: string, _args: readonly string[], options: SpawnOptions) => {
        runs++;
        const directory = String(options.cwd);
        directories.push(directory);
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        void (async () => {
          if (convergenceOnce) {
            convergenceOnce = false;
            await writeFile(path.join(directory, 'waveforms.txt'), 'failed attempt');
            child.stderr.write('Timestep too small; time = 0.1');
            child.emit('close', 1);
            return;
          }
          await writeFile(path.join(directory, 'waveforms.raw'), 'native binary fixture');
          await writeFile(path.join(directory, 'waveforms.txt'), 'time v(out)\n0 0\n1 5\n');
          child.stdout.write('solver completed');
          child.emit('close', fail ? 1 : 0);
        })();
        return child as unknown as ChildProcess;
      },
    );
    syncBuiltinESMExports();
    try {
      const { runSimulation } = await import(
        new URL('../plugins/spice-simulation/host/spice.mjs?persisted-first', import.meta.url).href
      );
      const deck: SpiceDeck = {
        netlist:
          '* persistent fixture\n.control\ntran 0.1 1\nwrdata waveforms.txt v(out)\n.endc\n.end\n',
        modelIds: ['verified-fixture'],
        stop: 1,
        assumptions: [],
        traces: [{ label: 'Output', vector: 'v(out)', unit: 'V' }],
      };
      const file = path.join(root, 'buck.kicad_pro');
      let model = 'verified model fixture';
      const store = async () => {
        modelReads++;
        return Buffer.from(model);
      };
      const resultFiles = () => createProjectSpiceStore(() => file);
      const first = await runSimulation(
        deck,
        new AbortController().signal,
        store,
        root,
        undefined,
        resultFiles(),
        { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 },
      );
      assert.equal(runs, 1);
      const records = path.join(root, 'spice-simulation');
      const { key } = JSON.parse(await readFile(path.join(records, 'buck.manifest.json'), 'utf8'));
      assert.match(key, /^[a-f0-9]{64}$/);
      assert.match(
        await readFile(path.join(records, 'buck.circuit.cir'), 'utf8'),
        /run waveforms.raw/,
      );
      assert.equal(
        await readFile(path.join(records, 'buck.solver.log'), 'utf8'),
        'solver completed',
      );
      assert.equal(await readFile(path.join(records, 'buck.example-model-0.lib'), 'utf8'), model);
      // A fresh runner has an empty process-local LRU; it must load the disk record.
      const restarted = await import(
        new URL('../plugins/spice-simulation/host/spice.mjs?persisted-restarted', import.meta.url)
          .href
      );
      assert.deepEqual(
        await restarted.runSimulation(
          deck,
          new AbortController().signal,
          store,
          root,
          undefined,
          resultFiles(),
          { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 },
        ),
        first,
      );
      assert.equal(runs, 1, 'Restart must not launch the solver for the same persisted run.');
      assert.equal(detections, 2);
      assert.equal(modelReads, 2, 'Disk reuse must re-read verified model bytes.');
      assert.deepEqual(
        await restarted.findSimulationResult(
          deck,
          new AbortController().signal,
          store,
          root,
          resultFiles(),
        ),
        first,
      );
      assert.equal(
        await restarted.findSimulationResult(
          { ...deck, netlist: deck.netlist + '* changed\n' },
          new AbortController().signal,
          store,
          root,
          resultFiles(),
        ),
        null,
      );
      assert.equal(runs, 1, 'Automatic lookup must never launch the solver on a hit or miss.');
      const metadata = JSON.parse(await readFile(path.join(records, 'buck.manifest.json'), 'utf8'));
      assert.equal(metadata.identityVersion, 2);
      assert.equal(
        metadata.solverSha256,
        createHash('sha256').update('solver fixture').digest('hex'),
      );
      const manifestFile = path.join(records, 'buck.manifest.json');
      await writeFile(manifestFile, JSON.stringify({ ...metadata, solverSha256: '0'.repeat(64) }));
      await assert.rejects(
        restarted.findSimulationResult(
          deck,
          new AbortController().signal,
          store,
          root,
          resultFiles(),
        ),
        /solver identity/,
      );
      await writeFile(manifestFile, JSON.stringify(metadata));
      const rebound = {
        ...deck,
        traces: deck.traces.map((trace) => ({
          ...trace,
          label: 'Renamed output',
          targets: [{ kind: 'voltage', id: 'new-local-wire' }],
        })),
      };
      const expectedRebound = {
        ...first,
        traces: first.traces.map((trace: object, index: number) => ({
          ...trace,
          ...rebound.traces[index],
        })),
      };
      const relocated = path.join(root, 'relocated');
      await mkdir(path.join(relocated, 'bin'), { recursive: true });
      await writeFile(path.join(relocated, 'bin', ngspiceExecutable), 'solver fixture');
      assert.deepEqual(
        await restarted.findSimulationResult(
          rebound,
          new AbortController().signal,
          store,
          relocated,
          resultFiles(),
        ),
        expectedRebound,
        'A relocated byte-identical solver and changed local probe metadata reuse verified samples.',
      );
      await writeFile(path.join(relocated, 'bin', ngspiceExecutable), 'changed solver');
      assert.equal(
        await restarted.findSimulationResult(
          rebound,
          new AbortController().signal,
          store,
          relocated,
          resultFiles(),
        ),
        null,
        'The same solver banner cannot hide changed executable bytes.',
      );
      assert.equal(runs, 1);
      await assert.rejects(
        restarted.runSimulation(
          deck,
          new AbortController().signal,
          async () => {
            throw new Error('changed/missing model');
          },
          root,
          undefined,
          resultFiles(),
          { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 },
        ),
        /missing model/,
      );
      assert.equal(runs, 1);
      const changed = { ...deck, netlist: deck.netlist.replace('tran 0.1', 'tran 0.05') };
      await restarted.runSimulation(
        changed,
        new AbortController().signal,
        store,
        root,
        undefined,
        resultFiles(),
        { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 },
      );
      assert.equal(runs, 2, 'Changed timing requires a new run.');
      model = 'different verified model bytes';
      await restarted.runSimulation(
        deck,
        new AbortController().signal,
        store,
        root,
        undefined,
        resultFiles(),
        { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 },
      );
      assert.equal(runs, 3, 'Changed model bytes require a new run.');
      const retainedManifest = await readFile(path.join(records, 'buck.manifest.json'));
      fail = true;
      await assert.rejects(
        restarted.runSimulation(
          { ...deck, netlist: deck.netlist + '* fail\n' },
          new AbortController().signal,
          store,
          root,
          undefined,
          resultFiles(),
          { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 },
        ),
        /could not complete/,
      );
      assert.equal(
        (await readdir(records)).filter((name) => name === 'buck.manifest.json').length,
        1,
        'Only the latest successful run remains after a failed run.',
      );
      assert.deepEqual(await readFile(path.join(records, 'buck.manifest.json')), retainedManifest);
      fail = false;
      convergenceOnce = true;
      const retriedDeck = {
        ...deck,
        netlist: deck.netlist.replace(
          '.control',
          '.options itl4=50 reltol=0.005 method=gear\n.control',
        ),
      };
      const beforeRetryRuns = runs;
      const resets: unknown[] = [];
      const retried = await restarted.runSimulation(
        retriedDeck,
        new AbortController().signal,
        store,
        root,
        async (packet: unknown) => {
          resets.push(packet);
        },
        resultFiles(),
        { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 },
      );
      assert.equal(runs, beforeRetryRuns + 2);
      assert.deepEqual(resets, [{ reset: true }]);
      assert.match(retried.log, /Convergence retry/);
      assert.match(
        await readFile(path.join(records, 'buck.circuit.cir'), 'utf8'),
        /itl4=1000 reltol=0.005 method=gear/,
      );
      assert.doesNotMatch(
        await readFile(path.join(records, 'buck.waveforms.txt'), 'utf8'),
        /failed attempt/,
      );
      assert.deepEqual(
        await restarted.findSimulationResult(
          retriedDeck,
          new AbortController().signal,
          store,
          root,
          resultFiles(),
        ),
        retried,
      );
      assert.equal(runs, beforeRetryRuns + 2, 'Restoring a retried run must never solve again.');
      assert.equal(
        await restarted.findSimulationResult(
          { ...retriedDeck, netlist: retriedDeck.netlist.replace('itl4=50', 'itl4=1000') },
          new AbortController().signal,
          store,
          root,
          resultFiles(),
        ),
        null,
        'A single-attempt plan cannot reuse the two-attempt plan identity.',
      );
      await rm(path.join(root, 'bin', ngspiceExecutable));

      await assert.rejects(
        restarted.runSimulation(
          deck,
          new AbortController().signal,
          store,
          root,
          undefined,
          resultFiles(),
          { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 },
        ),
        /ENOENT/,
      );
      assert.equal(
        runs,
        beforeRetryRuns + 2,
        'Missing solver must not be hidden by a saved result.',
      );
      for (const directory of directories)
        await assert.rejects(stat(directory), { code: 'ENOENT' });
    } finally {
      context.mock.restoreAll();
      childProcess.execFile = originalExecFile;
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'opening simulation recovers current saved custom timing with full identity checks and no analysis or writes',
  { skip: !ngspiceExecutable },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-restored-run-'));
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin', ngspiceExecutable), 'isolated solver fixture');
    const originalExecFile = childProcess.execFile;
    let detections = 0,
      runs = 0;
    let runningDeck: SpiceDeck;
    childProcess.execFile = Object.assign(() => {}, {
      [promisify.custom]: async () => {
        detections++;
        return { stdout: 'ngspice-47 fixture', stderr: '' };
      },
    }) as unknown as typeof childProcess.execFile;
    context.mock.method(
      childProcess,
      'spawn',
      (_executable: string, _args: readonly string[], options: SpawnOptions) => {
        runs++;
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        void (async () => {
          await writeFile(
            path.join(String(options.cwd), 'waveforms.raw'),
            completedRawFixture(runningDeck),
          );
          await writeFile(
            path.join(String(options.cwd), 'waveforms.txt'),
            [
              `time ${runningDeck.traces.map((trace) => trace.vector).join(' ')}`,
              `0 ${runningDeck.traces.map(() => 0).join(' ')}`,
              `${runningDeck.stop} ${runningDeck.traces.map(() => 5).join(' ')}`,
              '',
            ].join('\n'),
          );
          child.emit('close', 0);
        })();
        return child as unknown as ChildProcess;
      },
    );
    syncBuiltinESMExports();
    let service: { close(): void } | undefined;
    try {
      const { registerSpice, runSimulation, findSimulationResult } = await import(
        new URL('../plugins/spice-simulation/host/spice.mjs?restore-settings', import.meta.url).href
      );
      const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
      const store = () => createProjectSpiceStore(() => path.join(root, 'buck.kicad_pro'));
      service = registerSpice(
        {
          get() {},
          post(route: string, handler: (req: unknown, res: unknown) => Promise<void>) {
            handlers.set(route, handler);
          },
        },
        (
          deck: SpiceDeck,
          signal: AbortSignal,
          models: unknown,
          samples: unknown,
          files: unknown,
          config: TransientConfig,
        ) => {
          runningDeck = deck;
          return runSimulation(deck, signal, models, root, samples, files, config);
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { forProject: store },
        (deck: SpiceDeck, signal: AbortSignal, models: unknown, files: unknown) =>
          findSimulationResult(deck, signal, models, root, files),
      );
      const circuit = switchingStageFixture();
      const source = serializeProject(createProject(circuit));
      const config = { ...defaultTransient(circuit), stop: 0.004, step: 2e-7 };
      const body = { source, fileId: '12345678-1234-1234-1234-123456789abc' };
      const request = async (extra = {}, route = '/api/simulation/result') => {
        let status = 200;
        let value: { result?: unknown; config?: TransientConfig; error?: string } | undefined;
        const response = Object.assign(new EventEmitter(), {
          destroyed: false,
          status(code: number) {
            status = code;
            return this;
          },
          json(data: typeof value) {
            value = data;
          },
        });
        await handlers.get(route)!({ body: { ...body, ...extra }, get: () => '' }, response);
        return { status, value: value! };
      };
      assert.deepEqual((await request()).value, { result: null });
      assert.equal(detections, 0, 'An empty lookup must not even start solver detection.');
      assert.equal((await request({}, '/api/simulation/transient')).status, 400);
      assert.equal((await request({ config: { ...config, path: root } })).status, 400);
      const completed = await request({ config }, '/api/simulation/transient');
      assert.equal(completed.status, 200, completed.value.error);
      assert.equal(
        (completed.value as unknown as SimulationResult).dissipation?.sampleCount,
        3,
        'Completed runtime heat must use all native rows rather than the two display rows.',
      );
      assert.equal(runs, 1);
      const parent = path.join(root, 'spice-simulation');
      const manifestFile = path.join(parent, 'buck.manifest.json');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      assert.deepEqual(manifest.config, config);
      assert.deepEqual((await request()).value, { result: completed.value, config });
      const resultFile = path.join(parent, 'buck.result.json');
      const originalResult = await readFile(resultFile);
      for (const mismatch of ['digest', 'version']) {
        const changedResult =
          mismatch === 'version'
            ? Buffer.from(
                JSON.stringify({
                  ...JSON.parse(originalResult.toString()),
                  version: 'ngspice-99 unrelated',
                }),
              )
            : originalResult;
        const changedManifest = {
          ...manifest,
          ...(mismatch === 'digest'
            ? { solverSha256: '0'.repeat(64) }
            : {
                solverVersion: 'ngspice-99 unrelated',
                resultSha256: createHash('sha256').update(changedResult).digest('hex'),
              }),
        };
        const changedManifestText = JSON.stringify(changedManifest);
        await writeFile(resultFile, changedResult);
        await writeFile(manifestFile, changedManifestText);
        const rejected = await request();
        assert.equal(
          rejected.status,
          422,
          'Omitted-config discovery must forward the prepared solver identity to its read wrapper.',
        );
        assert.match(rejected.value.error!, /solver identity/);
        assert.equal(await readFile(manifestFile, 'utf8'), changedManifestText);
        assert.deepEqual(await readFile(resultFile), changedResult);
      }
      await writeFile(resultFile, originalResult);
      await writeFile(manifestFile, JSON.stringify(manifest));
      assert.deepEqual((await request({ config: defaultTransient(circuit) })).value, {
        result: null,
      });
      const changed = structuredClone(circuit);
      changed.parts.find((part) => part.ref === 'R1')!.value = '20';
      assert.notEqual(
        buildSpiceDeck(changed, config).netlist,
        buildSpiceDeck(circuit, config).netlist,
      );
      assert.deepEqual(
        (await request({ source: serializeProject(createProject(changed)) })).value,
        { result: null },
      );
      delete manifest.config;
      await writeFile(manifestFile, JSON.stringify(manifest));
      const unsupported = await request();
      assert.equal(unsupported.status, 422);
      assert.match(unsupported.value.error!, /transient settings/);
      manifest.config = config;
      await writeFile(
        manifestFile,
        JSON.stringify({ ...manifest, config: { ...config, step: 0 } }),
      );
      assert.equal((await request()).status, 422);
      await writeFile(manifestFile, JSON.stringify(manifest));
      await writeFile(resultFile, 'corrupted saved result');
      assert.equal((await request()).status, 422);
      assert.equal(await readFile(resultFile, 'utf8'), 'corrupted saved result');
      assert.equal(runs, 1, 'Restore hits, misses and failures must not start transient analyses.');
    } finally {
      service?.close();
      context.mock.restoreAll();
      childProcess.execFile = originalExecFile;
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  },
);
