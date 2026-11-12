import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pin from '../resources/example-catalog/footprints/emc-flyback/manifest.json' with { type: 'json' };
import { assertAnalyticalMesh } from '../scripts/prepare-emc-analytical-models';

test('EMC analytical models match their pad-aligned envelopes', async () => {
  const models = Object.values(pin.analyticalModels);
  assert.equal(models.length, 2);
  for (const entry of models) {
    const bytes = await readFile(
      `resources/example-catalog/footprints/emc-flyback/${entry.file}`,
    );
    assert.equal(bytes.length, entry.size);
    await assertAnalyticalMesh(bytes, entry.replaces, entry.offset);
  }
});
