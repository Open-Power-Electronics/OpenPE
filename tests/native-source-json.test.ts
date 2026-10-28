import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createHomeExample } from '../lib/create-home-example';
import { ownProjectData } from '../lib/immutable-project';
import { projectNativeFiles, serializeProject } from '../lib/project';
import { formatProjectJson, rememberNativeSourceJson } from '../lib/project-json';
import {
  primeSExprJsonChildren,
  quote,
  writeSExpr,
  writeSExprJsonPayload,
  type SExpr,
} from '../lib/sexpr';

test('owned native JSON chunks preserve Unicode and surrogate boundaries through indentation eviction', (t) => {
  const node = ownProjectData<SExpr>([
    'root',
    ['text', quote('é中😀\\"\r\n\t\u2028\u2029')],
    ['raw', '\ud800'],
    ['raw', '\udfff'],
    ['nested', ['raw', '\ud800\udfff']],
  ]);
  const expected = new Map(
    [0, 1, 2, 3, 4, 8].map((depth) => [
      depth,
      JSON.stringify(writeSExpr(node, depth)).slice(1, -1),
    ]),
  );
  const stringify = JSON.stringify;
  let calls = 0;
  const mocked = t.mock.method(JSON, 'stringify', (value: unknown, ...args: unknown[]) => {
    calls++;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  });
  try {
    for (const depth of [0, 1, 2])
      assert.equal(writeSExprJsonPayload(node, depth), expected.get(depth));
    assert.equal(calls, 3);
    assert.equal(writeSExprJsonPayload(node, 1), expected.get(1));
    assert.equal(calls, 3, 'An exact owned node/depth retains its encoded chunk.');
    assert.equal(writeSExprJsonPayload(node, 3), expected.get(3));
    assert.equal(calls, 4);
    assert.equal(writeSExprJsonPayload(node, 0), expected.get(0));
    assert.equal(calls, 5, 'The fourth indentation variant evicts an earlier one.');
  } finally {
    mocked.mock.restore();
  }
  for (const depth of [8, 2, 0, 4, 1]) {
    const root = [...node];
    primeSExprJsonChildren(root, depth);
    assert.equal(writeSExprJsonPayload(root, depth), expected.get(depth));
    assert.equal(writeSExprJsonPayload(structuredClone(node), depth), expected.get(depth));
  }
});

test('mutable and caller-frozen syntax follows changed descendants after chunk preparation', () => {
  const nested: SExpr = ['text', quote('Original')];
  const node: SExpr = ['root', nested];
  Object.freeze(node);
  primeSExprJsonChildren(node);
  const before = writeSExprJsonPayload(node);
  nested[1] = quote('Changed é😀\ud800');
  const after = writeSExprJsonPayload(node);
  assert.notEqual(after, before);
  assert.equal(after, JSON.stringify(writeSExpr(node)).slice(1, -1));
});

test('owned file encoders are one-shot, discarded on format-cache hits and retryable after failure', () => {
  const file = ownProjectData({ name: 'Current.kicad_pcb', source: 'é😀\\"\n'.repeat(512) });
  const expected = formatProjectJson(structuredClone(file));
  let calls = 0;
  rememberNativeSourceJson(file, () => {
    calls++;
    return JSON.stringify(file.source);
  });
  assert.equal(formatProjectJson(file), expected);
  assert.equal(formatProjectJson(file), expected);
  assert.equal(calls, 1);
  rememberNativeSourceJson(file, () => {
    throw new Error('A cached format must discard this encoder without running it.');
  });
  assert.equal(formatProjectJson(file), expected);
  const nested = { child: { child: file } };
  assert.equal(formatProjectJson(nested), formatProjectJson(structuredClone(nested)));

  const retry = ownProjectData({ ...file, name: 'Retry.kicad_pcb' });
  rememberNativeSourceJson(retry, () => {
    calls++;
    throw new Error('Injected encoding failure');
  });
  assert.throws(() => formatProjectJson(retry), /Injected encoding failure/);
  assert.equal(formatProjectJson(retry), formatProjectJson(structuredClone(retry)));
  assert.equal(calls, 2, 'A failed encoder is not invoked again on retry.');
  for (const caller of [{ ...file }, Object.freeze({ ...file, name: 'Caller.kicad_pcb' })]) {
    rememberNativeSourceJson(caller, () => {
      throw new Error('Unowned encoder must not run.');
    });
    assert.equal(formatProjectJson(caller), formatProjectJson(structuredClone(caller)));
  }
});

test('EMC clean native bytes and changed Core Source remain exact through chunk encoding and rejection', () => {
  const input = createHomeExample('emc-flyback-demo', (id) => id);
  assert.ok(input.nativeFiles);
  const original = input.nativeFiles.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
  original.source = original.source
    .replace('(kicad_pcb', '(kicad_pcb\n  ')
    .replace('(descr "', '(descr "Encoded metadata é😀 ');
  const core = new ProjectCore(input, { nativeEntryName: 'Managed.kicad_pro' });
  const clean = core.getSnapshot();
  assert.equal(
    projectNativeFiles(clean.project!).files.find((file) => file.name === original.name)!.source,
    original.source,
  );
  assert.equal(clean.undoDepth, 0);
  const selectedId = clean.project!.pcb!.tracks.find((track) => !track.locked)!.id;
  for (let step = 0; step < 4; step++) {
    const board = core.getSnapshot().project!.pcb!;
    assert.equal(
      core.replaceBoard({
        ...board,
        tracks: board.tracks.map((track) =>
          track.id === selectedId
            ? {
                ...track,
                start: { ...track.start, y: track.start.y + 0.125 },
                end: { ...track.end, y: track.end.y + 0.125 },
              }
            : track,
        ),
      }),
      true,
    );
    const snapshot = core.getSnapshot();
    const detached = structuredClone(snapshot.project!);
    assert.equal(snapshot.source, serializeProject(detached));
    assert.deepEqual(projectNativeFiles(snapshot.project!), projectNativeFiles(detached));
    assert.deepEqual(core.getNativeFiles(), projectNativeFiles(detached, 'Managed.kicad_pro'));
    const encoded = JSON.parse(snapshot.source);
    const file = encoded.nativeFiles.files.find((file: { name: string }) =>
      file.name.endsWith('.kicad_pcb'),
    );
    assert.match(file.source, /Encoded metadata é😀/);
    assert.deepEqual(Object.keys(file).sort(), ['name', 'source']);
    assert.equal(serializeProject(snapshot.project!), snapshot.source);
  }
  const accepted = core.getSnapshot();
  assert.throws(
    () => core.commitProject({ ...accepted.project!, id: accepted.project!.pcb!.id }),
    /duplicate UUID/,
  );
  assert.equal(core.getSnapshot(), accepted);
  assert.throws(
    () =>
      serializeProject(
        ownProjectData({
          ...accepted.project!,
          extensions: { oversized: 'x'.repeat(8_000_000) },
        }),
      ),
    /8 MB/,
  );
  assert.equal(core.getSnapshot(), accepted);
  core.undo();
  assert.equal(
    core.getSnapshot().source,
    serializeProject(structuredClone(core.getSnapshot().project!)),
  );
  core.redo();
  assert.equal(core.getSnapshot().project, accepted.project);
  assert.equal(core.getSnapshot().source, accepted.source);
});
