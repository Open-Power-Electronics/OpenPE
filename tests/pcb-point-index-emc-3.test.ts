import { test } from 'node:test';
import { compareEMCPointShard } from './fixtures/pcb-point-queries';

test('owned EMC point index shard 3 of 3 matches exhaustive geometry across viewport scales, layers and filters', async () => {
  await compareEMCPointShard({ shard: 2, shards: 3 });
});
