import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spiceConvergenceDecks,
  runSpiceAttempts,
  convergenceProgress,
} from '../plugins/spice-simulation/host/spice-convergence.mjs';
import { spiceFailure } from '../plugins/spice-simulation/host/spice-errors.mjs';

const deck = {
  netlist:
    '* ordinary circuit\n.options itl4=50 reltol=0.005 method=gear\n.control\ntran 2e-7 .002 uic\n.endc\n.end\n',
  stop: 0.002,
  traces: [],
};
const convergence = () => spiceFailure('Timestep too small; time = 0.001');

test('accepted solver work detects collapsed steps without a runtime deadline or rejecting normal progress', () => {
  const normal = convergenceProgress(deck);
  for (let i = 0; i < 200000; i++) normal(i * 1e-9);
  const stalled = convergenceProgress(deck);
  for (let i = 0; i < 99999; i++) stalled(0.001 + i * 1e-15);
  assert.throws(() => stalled(0.001 + 99999 * 1e-15), { code: 'OPENPE_SPICE_CONVERGENCE' });
});

test('convergence retry changes only the iteration ceiling, independent of circuit identity', () => {
  const [first, second] = spiceConvergenceDecks(deck);
  assert.equal(first, deck);
  assert.deepEqual(second, { ...deck, netlist: deck.netlist.replace('itl4=50', 'itl4=1000') });
  assert.equal(spiceConvergenceDecks(second).length, 1);
  assert.equal(
    spiceConvergenceDecks({ ...deck, netlist: deck.netlist.replace('itl4=50', 'itl4=2000') })
      .length,
    1,
  );
  const implicit = { ...deck, netlist: deck.netlist.replace('itl4=50 ', '') };
  assert.match(spiceConvergenceDecks(implicit)[1].netlist, /\.options itl4=1000\n\.control/);
});

test('successful initial attempt is not retried; convergence clears previews before exactly one retry', async () => {
  const plan = spiceConvergenceDecks(deck);
  const signal = new AbortController().signal;
  const calls: string[] = [];
  assert.deepEqual(
    await runSpiceAttempts(
      plan,
      signal,
      async () => 'completed',
      () => assert.fail('no retry'),
    ),
    { deck, log: 'completed' },
  );
  const result = await runSpiceAttempts(
    plan,
    signal,
    async (candidate: typeof deck, index: number) => {
      calls.push(`attempt ${index}`);
      if (!index) throw convergence();
      assert.match(candidate.netlist, /itl4=1000/);
      return 'completed';
    },
    async () => {
      calls.push('reset');
    },
  );
  assert.deepEqual(calls, ['attempt 0', 'reset', 'attempt 1']);
  assert.equal(result.deck, plan[1]);
  assert.match(result.log, /Convergence retry/);
  let count = 0;
  await assert.rejects(
    runSpiceAttempts(plan, signal, async () => {
      count++;
      throw convergence();
    }),
    /could not converge/,
  );
  assert.equal(count, 2);
});

test('cancellation, invalid samples, syntax failures and reset failures cannot launch another attempt', async () => {
  for (const reason of [
    'Simulation cancelled.',
    'Invalid native waveform samples.',
    'Error on line 4',
  ]) {
    let calls = 0;
    await assert.rejects(
      runSpiceAttempts(
        spiceConvergenceDecks(deck),
        new AbortController().signal,
        async () => {
          calls++;
          throw spiceFailure('Timestep too small', reason);
        },
        () => assert.fail('no reset'),
      ),
    );
    assert.equal(calls, 1);
  }
  for (const at of ['failure', 'reset']) {
    const control = new AbortController();
    let calls = 0;
    await assert.rejects(
      runSpiceAttempts(
        spiceConvergenceDecks(deck),
        control.signal,
        async () => {
          calls++;
          if (at === 'failure') control.abort();
          throw convergence();
        },
        () => {
          control.abort();
        },
      ),
      /Simulation cancelled\./,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    runSpiceAttempts(
      spiceConvergenceDecks(deck),
      new AbortController().signal,
      async () => {
        calls++;
        throw convergence();
      },
      () => {
        throw new Error('stream disconnected');
      },
    ),
    /stream disconnected/,
  );
  assert.equal(calls, 1);
});
