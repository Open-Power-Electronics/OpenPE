import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceExamples, createReferenceExample } from '../lib/reference-examples';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { worldZones } from '../lib/pcb-polygons';

for (const example of referenceExamples) {
  test(`${example.id}: default DRC accepts saved fills and warns only for missing fills`, () => {
    const project = createReferenceExample(example.id);
    const board = project.pcb!;
    const before = structuredClone(board);
    const report = runPCBDesignRules(board, {
      useZoneClearance: example.id === 'reference-tps61046-bga6-boost',
    });
    assert.deepEqual(
      report.issues.filter((issue) => issue.severity === 'error'),
      [],
    );
    assert.equal(report.truncated, false);
    const missing = worldZones(board).filter(
      (zone) =>
        board.layers.some((layer) => layer === zone.layer) &&
        !zone.keepout &&
        zone.fillEnabled !== false &&
        zone.filledPolygons === undefined,
    );
    assert.equal(report.complete, missing.length === 0);
    assert.deepEqual(
      report.issues.map((issue) => issue.ruleId),
      missing.map(() => 'pcb.unfilled-zone'),
    );
    assert.deepEqual(
      report.issues.map((issue) => issue.objectIds),
      missing.map((zone) => [zone.id]),
    );
    assert.deepEqual(board, before, 'DRC preserves the supplied board and saved fills.');
  });
}
