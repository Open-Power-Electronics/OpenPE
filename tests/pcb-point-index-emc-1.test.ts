import { test } from 'node:test';
import { compareEMCPointShard } from './fixtures/pcb-point-queries';

test('owned EMC point index shard 1 of 3 matches exhaustive geometry across viewport scales, layers and filters', async () => {
  await compareEMCPointShard({ shard: 0, shards: 3 });
});
