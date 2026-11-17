// Repeatable in-memory timings; never opens Electron, providers or a solver,
// reads application data, downloads resources or writes project files.
// Usage: node --import tsx scripts/benchmark-project-runtime.ts [example filter | all] [samples: 1-100]
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createHomeExample } from '../lib/create-home-example';
import { homeExampleCatalog } from '../lib/home-examples';
import { createNativeProjectDirtyChecker } from '../lib/native-project-dirty';
import { projectNativeFiles, schematicFileFingerprint } from '../lib/project';

const filter = process.argv[2] === 'all' ? '' : (process.argv[2] ?? homeExampleCatalog[0].id);
const samples = Number(process.argv[3] ?? 8);
assert.ok(
  Number.isInteger(samples) && samples >= 1 && samples <= 100 && process.argv.length <= 4,
  'Usage: node --import tsx scripts/benchmark-project-runtime.ts [example filter | all] [samples: 1-100]',
);
const cases = homeExampleCatalog.filter((entry) => entry.id.includes(filter));
assert.ok(cases.length, 'No Home project matched the requested filter.');
const round = (value: number) => Math.round(value * 10000) / 10000;

for (const entry of cases) {
  // Retain fixture identifiers so each checkout receives identical input bytes.
  const openingStart = performance.now();
  const core = new ProjectCore(createHomeExample(entry.id, (id) => id));
  console.log(
    JSON.stringify({
      id: entry.id,
      operation: 'create and validate',
      firstMs: round(performance.now() - openingStart),
    }),
  );
  const { project, source: baseline } = core.getSnapshot();
  assert.ok(project);
  const editStart = performance.now();
  core.commitProject({
    ...project,
    schematic: { ...project.schematic, title: 'Changed benchmark schematic' },
  });
  console.log(
    JSON.stringify({
      id: entry.id,
      operation: 'validated edit',
      firstMs: round(performance.now() - editStart),
    }),
  );
  const edited = core.getSnapshot().project!;
  const filename = projectNativeFiles(project).entry;
  core.setNativeEntryName(filename);
  const nativeProjectDirty = createNativeProjectDirtyChecker();
  assert.equal(nativeProjectDirty(project, baseline, filename), false);

  const measure = (operation: string, run: () => unknown) => {
    const firstStart = performance.now();
    const first = run();
    const firstMs = performance.now() - firstStart;
    const timings: number[] = [];
    for (let index = 0; index < samples; index++) {
      const start = performance.now();
      const result = run();
      timings.push(performance.now() - start);
      assert.deepEqual(result, first, 'Repeated operations must retain the complete result.');
    }
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        id: entry.id,
        operation,
        samples,
        firstMs: round(firstMs),
        medianMs: round(timings[Math.floor(samples / 2)]),
        minMs: round(timings[0]),
      }),
    );
  };

  measure('schematic fingerprint', () => schematicFileFingerprint(project, project.schematic.id));
  measure('native files with destination', () => projectNativeFiles(project, filename));
  measure('native files with default name', () => projectNativeFiles(project));
  measure('edited project dirty state', () => nativeProjectDirty(edited, baseline, filename));

  // Fresh edits expose main-thread work hidden by repeated reads of one cached
  // snapshot. Include the native Source and dirty reads performed by Workbench.
  const edits: { commitMs: number; nativeMs: number; dirtyMs: number; totalMs: number }[] = [];
  const partId = project.schematic.parts.find((part) => !part.ref.startsWith('#'))?.id;
  assert.ok(partId, 'The example has a component to move.');
  for (let index = 0; index < samples; index++) {
    const before = core.getSnapshot().project!;
    const start = performance.now();
    core.replaceSchematic({
      ...before.schematic,
      parts: before.schematic.parts.map((part) =>
        part.id === partId ? { ...part, x: Number((part.x + 1.27).toFixed(4)) } : part,
      ),
    });
    const committed = performance.now();
    const native = core.getNativeFiles();
    const derived = performance.now();
    const dirty = nativeProjectDirty(core.getSnapshot().project, baseline, filename);
    const end = performance.now();
    assert.equal(dirty, true);
    assert.equal(native.entry, filename);
    assert.equal(core.getSnapshot().undoDepth, Math.min(60, index + 2));
    edits.push({
      commitMs: committed - start,
      nativeMs: derived - committed,
      dirtyMs: end - derived,
      totalMs: end - start,
    });
  }
  const median = (key: keyof (typeof edits)[number]) =>
    round(edits.map((edit) => edit[key]).sort((a, b) => a - b)[Math.floor(samples / 2)]);
  console.log(
    JSON.stringify({
      id: entry.id,
      operation: 'fresh component edits with native Source and dirty state',
      samples,
      medianMs: median('totalMs'),
      commitMs: median('commitMs'),
      nativeMs: median('nativeMs'),
      dirtyMs: median('dirtyMs'),
    }),
  );

  for (const operation of ['property pose edits', 'participation edits', 'unchanged properties']) {
    const timings: number[] = [];
    for (let index = 0; index < samples; index++) {
      const before = core.getSnapshot();
      const part = before.project!.schematic.parts.find((part) => part.id === partId)!;
      const unchanged = operation === 'unchanged properties';
      const input = {
        schematicId: before.project!.schematic.id,
        partId,
        ...(operation === 'property pose edits'
          ? { position: { x: Number((part.x + 1.27).toFixed(4)), y: part.y } }
          : operation === 'participation edits'
            ? { included: !!part.excludeFromSimulation }
            : {}),
      };
      const start = performance.now();
      core.execute(
        operation === 'participation edits' ? 'part.participation' : 'part.properties',
        input,
      );
      const native = core.getNativeFiles();
      const dirty = nativeProjectDirty(core.getSnapshot().project, baseline, filename);
      timings.push(performance.now() - start);
      assert.equal(native.entry, filename);
      assert.equal(dirty, true);
      if (unchanged) assert.equal(core.getSnapshot(), before);
      else {
        assert.equal(core.getSnapshot().revision, before.revision + 1);
        assert.equal(core.getSnapshot().undoDepth, Math.min(60, before.undoDepth + 1));
      }
    }
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        id: entry.id,
        operation: `Core ${operation} with native Source and dirty state`,
        samples,
        medianMs: round(timings[Math.floor(samples / 2)]),
        minMs: round(timings[0]),
      }),
    );
  }
}
