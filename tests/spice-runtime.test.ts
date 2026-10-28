import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SpiceDeck } from '../lib/spice';

class SolverProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = 0;
  kill() {
    this.kills++;
    this.emit('close', null);
    return true;
  }
}

test(
  'solver runs beyond 60 seconds and still completes or cancels with temporary-file cleanup',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-spice-runtime-'));
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin', 'ngspice_con.exe'), 'isolated solver fixture');
    // Mock detection before importing the runner, which captures promisified execFile.
    const originalExecFile = childProcess.execFile;
    childProcess.execFile = Object.assign(
      () => {
        throw new Error('The solver fixture must use promisified detection.');
      },
      { [promisify.custom]: async () => ({ stdout: 'ngspice-47 fixture', stderr: '' }) },
    ) as unknown as typeof childProcess.execFile;
    let started: (child: SolverProcess) => void;
    let directory = '';
    context.mock.method(
      childProcess,
      'spawn',
      (_executable: string, _args: readonly string[], options: SpawnOptions) => {
        directory = String(options.cwd);
        const child = new SolverProcess();
        started(child);
        return child as unknown as ChildProcess;
      },
    );
    syncBuiltinESMExports();
    context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
      const { runSimulation } = await import('../server/spice.mjs');
      for (const outcome of ['complete', 'cancel']) {
        const control = new AbortController();
        let settled = false;
        const began = new Promise<SolverProcess>((resolve) => {
          started = resolve;
        });
        const deck: SpiceDeck = {
          netlist: `* ${outcome}\n.control\ntran 0.1 1\nwrdata waveforms.txt v(out)\n.endc\n.end\n`,
          stop: 1,
          assumptions: [],
          traces: [{ label: 'Output', vector: 'v(out)', unit: 'V' }],
        };
        const pending = runSimulation(deck, control.signal, undefined, root);
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const child = await Promise.race([
          began,
          pending.then(() => {
            throw new Error('The solver fixture must wait for completion or cancellation.');
          }),
        ]);
        try {
          context.mock.timers.tick(61_000);
          await Promise.resolve();
          assert.equal(child.kills, 0, 'Elapsed runtime must not stop the solver.');
          assert.equal(settled, false);
          if (outcome === 'complete') {
            await writeFile(path.join(directory, 'waveforms.txt'), 'time v(out)\n0 0\n1 5\n');
            child.emit('close', 0);
            const result = await pending;
            assert.deepEqual(result.time, [0, 1]);
            assert.deepEqual(result.traces[0].values, [0, 5]);
            const updated: SpiceDeck = {
              ...deck,
              traces: deck.traces.map((trace) => ({
                ...trace,
                label: 'Current project output',
                targets: [{ kind: 'voltage', id: 'current-project-wire' }],
              })),
            };
            const reused = await runSimulation(
              updated,
              new AbortController().signal,
              undefined,
              root,
            );
            assert.deepEqual(
              reused.traces,
              updated.traces.map((trace, index) => ({
                ...trace,
                values: result.traces[index].values,
              })),
              'Process-local reuse must bind current labels/targets instead of leaking prior project metadata.',
            );
            assert.notEqual(reused, result);
            control.abort();
            assert.equal(child.kills, 0, 'Completion must remove the cancellation listener.');
          } else {
            control.abort();
            await assert.rejects(pending, /Simulation cancelled\./);
            assert.equal(child.kills, 1);
          }
          await assert.rejects(stat(directory), { code: 'ENOENT' });
        } finally {
          control.abort();
          await pending.catch(() => {});
        }
      }
    } finally {
      context.mock.restoreAll();
      childProcess.execFile = originalExecFile;
      syncBuiltinESMExports();
      context.mock.timers.reset();
      await rm(root, { recursive: true, force: true });
    }
  },
);
