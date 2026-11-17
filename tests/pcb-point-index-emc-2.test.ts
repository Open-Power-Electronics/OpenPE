import { test } from 'node:test';
import { compareEMCPointShard } from './fixtures/pcb-point-queries';

test('owned EMC point index shard 2 of 3 matches exhaustive geometry across viewport scales, layers and filters', async () => {
  await compareEMCPointShard({ shard: 1, shards: 3 });
});
