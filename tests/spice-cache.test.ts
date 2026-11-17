import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpiceResultCache } from '../plugins/spice-simulation/host/spice-cache.mjs';
import type { SimulationResult } from '../plugins/spice-simulation/domain/spice';

const result = (samples = 2): SimulationResult => ({
  time: Array.from({ length: samples }, (_, i) => i),
  traces: [
    {
      label: 'V(out)',
      unit: 'V',
      vector: 'v(out)',
      values: new Array(samples).fill(5),
      targets: [{ kind: 'voltage', id: 'probe' }],
    },
  ],
  version: 'test',
  log: 'completed',
});

test('completed simulation cache isolates stored samples and probe metadata from consumers', () => {
  const cache = createSpiceResultCache();
  const original = result();
  cache.set('same-deck-models-and-targets', original);
  original.traces[0].values[0] = 99;
  original.traces[0].targets![0].id = 'other-project';
  const cached = cache.get('same-deck-models-and-targets')!;
  assert.equal(cached.traces[0].values[0], 5);
  assert.equal(cached.traces[0].targets![0].id, 'probe');
  cached.time[0] = 100;
  cached.traces[0].values.length = 0;
  assert.deepEqual(cache.get('same-deck-models-and-targets'), result());
  assert.equal(cache.get('changed-deck-models-or-targets'), null);
});

test('simulation cache evicts least-recently-used entries and enforces its byte budget', () => {
  const cache = createSpiceResultCache(4096, 2);
  cache.set('a', result());
  cache.set('b', result());
  assert.ok(cache.get('a'));
  cache.set('c', result());
  assert.equal(cache.get('b'), null);
  assert.ok(cache.get('a'));
  assert.ok(cache.get('c'));
  cache.set('large', result(200));
  assert.equal(cache.get('a'), null);
  assert.ok(cache.get('large'));
  cache.set('oversized', result(1000));
  assert.equal(cache.get('oversized'), null);
  assert.ok(cache.get('large'), 'Oversized output must not evict usable cached results.');
  cache.set('large', result());
  cache.set('small', result(150));
  assert.ok(cache.get('large'));
  assert.ok(cache.get('small'), 'Replacing a cache entry must release its previous byte budget.');
});
