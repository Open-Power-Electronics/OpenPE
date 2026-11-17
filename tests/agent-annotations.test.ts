import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { annotationFixture } from './fixtures/annotation';
import {
  validateAnnotations,
  annotationContext,
  validateLayoutAnnotationContext,
} from '../lib/agent-annotations';
import { captureAnnotationSelection } from '../lib/annotation-selection';
import {
  capturePCBAnnotationSelection,
  layoutAnnotationContext,
  pcbAnnotationFingerprint,
} from '../lib/pcb-annotations';
import { exampleProject } from '../lib/project-example';
import { ownProject } from '../lib/immutable-project';
import { fieldId } from '../lib/schematic-edit';
import { createReferenceExample } from '../lib/reference-examples';
import { createSession, restoreSessions } from '../lib/chat-sessions';
import {
  validateAnnotations as validateServiceAnnotations,
  validateLayoutAnnotationContext as validateServiceLayoutContext,
} from '../server/annotation-format.mjs';
import { runAgent, makePrompt } from '../server/agents.mjs';
import { startServer } from '../server/index.mjs';

test('annotation selection captures immutable identities and properties without editing project data', () => {
  const project = exampleProject();
  const original = structuredClone(project);
  const part = project.schematic.parts[0];
  const snapshot = captureAnnotationSelection(project.schematic, [
    part.id,
    fieldId(part.id, 'Value'),
    project.schematic.wires[0].id,
  ]);
  assert.deepEqual(project, original);
  assert.equal(snapshot.elements[0].properties.Reference, part.ref);
  assert.equal(snapshot.elements[1].properties['Component ID'], part.id);
  assert.equal(snapshot.elements[2].kind, 'wire');
  part.value = 'changed';
  assert.equal(snapshot.elements[0].properties.Value, original.schematic.parts[0].value);
  assert.throws(() => captureAnnotationSelection(project.schematic, []), /Select between/);
  assert.throws(
    () => captureAnnotationSelection(project.schematic, [crypto.randomUUID()]),
    /no longer exists/,
  );
});

test('layout annotations capture PCB identities and physical properties without changing the project', () => {
  const project = exampleProject();
  const board = project.pcb!;
  const before = structuredClone(project);
  const snapshot = capturePCBAnnotationSelection(board, project.schematic, [
    board.footprints[0].id,
    board.footprints[0].pads[0].id,
    board.tracks[0].id,
    board.vias[0].id,
    board.graphics[0].id,
    board.zones[0].id,
    board.footprints[0].graphics[0].id,
  ]);
  assert.equal(snapshot.target, 'layout');
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.boardId, board.id);
  assert.deepEqual(
    snapshot.elements.map((element) => element.kind),
    ['footprint', 'pad', 'track', 'via', 'graphic', 'zone', 'graphic'],
  );
  assert.equal(snapshot.elements[0].properties['Component ID'], board.footprints[0].symbolId);
  assert.equal(snapshot.elements[1].properties['Net ID'], board.footprints[0].pads[0].netId);
  assert.equal(snapshot.elements[2].properties.Layer, 'F.Cu');
  assert.equal(snapshot.elements[5].properties.Fill, 'Unfilled');
  assert.deepEqual(project, before);
  assert.equal(
    pcbAnnotationFingerprint(structuredClone(board), structuredClone(project.schematic)),
    snapshot.basis,
  );
  board.tracks[0].width += 0.1;
  assert.notEqual(pcbAnnotationFingerprint(board, project.schematic), snapshot.basis);
  assert.equal(snapshot.elements[2].properties['Width (mm)'], String(before.pcb!.tracks[0].width));
  board.tracks[0].width -= 0.1;
  project.schematic.parts[0].ref = 'R99';
  assert.notEqual(pcbAnnotationFingerprint(board, project.schematic), snapshot.basis);
  assert.throws(
    () => capturePCBAnnotationSelection(board, project.schematic, [project.schematic.parts[0].id]),
    /no longer exists/,
  );
  assert.throws(
    () => capturePCBAnnotationSelection(board, project.schematic, []),
    /Select between/,
  );
});

test('owned layout fingerprints reuse board bytes while tracking every drawn label and board edit', () => {
  const project = ownProject(exampleProject());
  const board = project.pcb!;
  const first = pcbAnnotationFingerprint(board, project.schematic);
  const schematic = structuredClone(project.schematic);
  schematic.parts[0].x += 1.27;
  schematic.title = 'A schematic-only title';
  assert.equal(pcbAnnotationFingerprint(board, schematic), first);
  const originalRef = schematic.parts[0].ref;
  const originalValue = schematic.parts[0].value;
  for (const edit of [
    () => {
      schematic.parts[0].ref = 'R99';
    },
    () => {
      schematic.parts[0].ref = originalRef;
      schematic.parts[0].value = '22k';
    },
    () => {
      schematic.parts[0].value = originalValue;
      schematic.id = crypto.randomUUID();
    },
  ]) {
    edit();
    const changed = pcbAnnotationFingerprint(board, schematic);
    assert.notEqual(changed, first);
    assert.equal(changed, pcbAnnotationFingerprint(structuredClone(board), schematic));
  }
  assert.equal(pcbAnnotationFingerprint(board, project.schematic), first);
  const edited = ownProject(
    {
      ...project,
      pcb: {
        ...board,
        tracks: board.tracks.map((track, index) =>
          index ? track : { ...track, width: track.width + 0.1 },
        ),
      },
    },
    project,
  );
  assert.notEqual(pcbAnnotationFingerprint(edited.pcb!, project.schematic), first);
  const caller = structuredClone(project);
  Object.freeze(caller.pcb);
  const baseline = pcbAnnotationFingerprint(caller.pcb!, caller.schematic);
  caller.pcb!.tracks[0].width += 0.1;
  assert.notEqual(pcbAnnotationFingerprint(caller.pcb!, caller.schematic), baseline);
  const context = layoutAnnotationContext(board, project.schematic);
  context.layers.reverse();
  context.counts.pads = 0;
  assert.deepEqual(layoutAnnotationContext(board, project.schematic).layers, board.layers);
  assert.ok(layoutAnnotationContext(board, project.schematic).counts.pads > 0);
});

test('layout attachments remain versioned, bounded and distinct from schematic annotations through recovery', () => {
  const project = exampleProject();
  const schematic = annotationFixture();
  const layout = {
    ...annotationFixture(),
    ...capturePCBAnnotationSelection(project.pcb!, project.schematic, [project.pcb!.tracks[0].id]),
  };
  const session = { ...createSession(), annotations: [layout, schematic] };
  const state = { sessions: [session], activeSessionId: session.id };
  assert.deepEqual(restoreSessions(JSON.parse(JSON.stringify(state))), state);
  for (const validate of [validateAnnotations, validateServiceAnnotations]) {
    assert.doesNotThrow(() => validate([layout, schematic]));
    for (const bad of [
      { ...layout, target: undefined },
      { ...layout, version: undefined },
      { ...layout, version: 2 },
      { ...layout, boardId: undefined },
      { ...layout, boardId: '../private' },
      { ...layout, target: 'schematic' },
      { ...layout, elements: schematic.elements },
      { ...schematic, elements: layout.elements },
    ])
      assert.throws(() => validate([bad]));
    const bounds = { x: 10, y: 20, width: 30, height: 40 };
    assert.doesNotThrow(() =>
      validate([
        {
          ...layout,
          ...capturePCBAnnotationSelection(project.pcb!, project.schematic, [], {
            kind: 'rectangle',
            bounds,
          }),
          bounds,
        },
      ]),
    );
  }
  const context = annotationContext([layout])[0];
  assert.equal(context.target, 'layout');
  assert.equal(context.boardId, project.pcb!.id);
  assert.equal('image' in context, false);
  assert.match(
    makePrompt({ prompt: 'Review board', context: {}, annotations: [layout] }),
    /supported edit operations affect schematics only/,
  );
});

test('Model captures retain PCB identity, screen view and immutable images through conversation recovery', () => {
  const project = exampleProject();
  const object = {
    ...annotationFixture(),
    ...capturePCBAnnotationSelection(project.pcb!, project.schematic, [
      project.pcb!.footprints[0].id,
    ]),
    target: 'object' as const,
    viewBasis: '10:123:456',
    title: '3D board · Model',
  };
  const session = { ...createSession(), annotations: [object] };
  const state = { sessions: [session], activeSessionId: session.id };
  assert.deepEqual(restoreSessions(JSON.parse(JSON.stringify(state))), state);
  for (const validate of [validateAnnotations, validateServiceAnnotations]) {
    assert.doesNotThrow(() => validate([object]));
    for (const bad of [
      { ...object, viewBasis: undefined },
      { ...object, viewBasis: '../camera' },
      { ...object, target: 'layout' },
      { ...object, boardId: undefined },
      { ...object, elements: annotationFixture().elements },
    ])
      assert.throws(() => validate([bad]));
  }
  const context = annotationContext([object])[0];
  assert.equal(context.target, 'object');
  assert.equal(context.viewBasis, object.viewBasis);
  assert.equal('image' in context, false);
  assert.match(
    makePrompt({ prompt: 'Review 3D', context: {}, annotations: [object] }),
    /screen coordinates/,
  );
});

test('layout chat context is a strictly bounded summary without geometry or executable fields', () => {
  const project = exampleProject();
  const context = layoutAnnotationContext(project.pcb!, project.schematic);
  assert.equal(context.counts.pads, 4);
  assert.equal(context.counts.graphics, 5);
  assert.equal(context.basis, pcbAnnotationFingerprint(project.pcb!, project.schematic));
  assert.ok(JSON.stringify(context).length < 500);
  for (const validate of [validateLayoutAnnotationContext, validateServiceLayoutContext]) {
    assert.doesNotThrow(() => validate(undefined));
    assert.doesNotThrow(() => validate(context));
    for (const bad of [
      { ...context, version: 2 },
      { ...context, tracks: project.pcb!.tracks },
      { ...context, path: 'C:\\private' },
      { ...context, layers: ['F.Cu'] },
      { ...context, thickness: NaN },
      { ...context, counts: { ...context.counts, pads: -1 } },
      { ...context, counts: { ...context.counts, pads: 4_000_001 } },
      { ...context, counts: { ...context.counts, pads: undefined } },
    ])
      assert.throws(() => validate(bad));
  }
});

test('bounded annotation snapshots survive session recovery and reject paths, URLs, malformed PNGs and unknown fields', () => {
  const annotation = annotationFixture();
  const session = { ...createSession('Unsent draft'), annotations: [annotation] };
  session.messages.push({
    id: 'sent',
    role: 'user',
    text: 'Previous message',
    annotations: [annotation],
  });
  const state = { sessions: [session, createSession()], activeSessionId: session.id };
  assert.deepEqual(restoreSessions(JSON.parse(JSON.stringify(state))), state);
  assert.equal('image' in annotationContext([annotation])[0], false);
  for (const validate of [validateAnnotations, validateServiceAnnotations]) {
    assert.doesNotThrow(() => validate([annotation]));
    const circuit = createReferenceExample('reference-lm2598-to220-7-buck').schematic;
    const source = circuit.parts.find((part) => part.ref === 'V1')!;
    const captured = captureAnnotationSelection(circuit, [fieldId(source.id, 'Sim.Params')]);
    assert.doesNotThrow(() => validate([{ ...annotation, ...captured }]));
    for (const value of [
      { ...annotation, image: { ...annotation.image, dataUrl: 'https://example.com/image.png' } },
      { ...annotation, image: { ...annotation.image, path: 'C:\\secret.png' } },
      { ...annotation, image: { ...annotation.image, width: 1601 } },
      { ...annotation, image: { ...annotation.image, width: 2 } },
      { ...annotation, image: { ...annotation.image, dataUrl: 'data:image/png;base64,AAAA' } },
      { ...annotation, comment: ' ' },
      { ...annotation, executable: 'anything' },
      { ...annotation, elements: [] },
    ])
      assert.throws(() => validate([value]));
    assert.throws(() => validate([annotation, annotation]), /Invalid annotation/);
    assert.throws(
      () => validate(Array.from({ length: 5 }, () => ({ ...annotation, id: crypto.randomUUID() }))),
      /up to 4/,
    );
  }
  assert.throws(
    () =>
      restoreSessions({
        sessions: [{ ...session, annotations: [{ ...annotation, comment: '' }] }],
      }),
    /Invalid annotation/,
  );
});

test('Codex and Claude transports receive real image blocks with the matching comment and selected properties', async () => {
  const annotation = annotationFixture();
  for (const provider of ['codex', 'claude'] as const) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-annotations-'));
    const events: any[] = [];
    const result = await runAgent(
      provider,
      {
        prompt: 'Review',
        context: { title: 'Fixture' },
        history: [],
        effort: 'high',
        model: 'fixture-model',
        annotations: [annotation],
      },
      cwd,
      (e) => events.push(e),
      new AbortController().signal,
      {
        resolve: async () => ({
          file: process.execPath,
          args: [path.resolve('tests/fixtures/agent-cli.mjs'), `${provider}-annotations`],
          env: process.env,
        }),
      },
    );
    assert.equal(result.outcome, 'completed', JSON.stringify(events));
    const input = JSON.parse(await readFile(path.join(cwd, 'annotation-input.json'), 'utf8'));
    if (provider === 'codex') assert.equal(input[1].url, annotation.image.dataUrl);
    else assert.equal(input.message.content[1].source.data, annotation.image.dataUrl.split(',')[1]);
    assert.match(JSON.stringify(input), new RegExp(annotation.elements[0].id));
  }
});

test('area and freehand annotations are bounded conversation snapshots, including empty schematic areas', () => {
  const annotation = annotationFixture();
  const bounds = { x: -10, y: 20, width: 40, height: 30 };
  const rectangle = { ...annotation, elements: [], bounds, markup: { kind: 'rectangle', bounds } };
  const freehand = {
    ...rectangle,
    markup: {
      kind: 'freehand',
      points: [
        { x: -10, y: 20 },
        { x: 30, y: 50 },
      ],
    },
  };
  for (const validate of [validateAnnotations, validateServiceAnnotations]) {
    assert.doesNotThrow(() => validate([rectangle]));
    assert.doesNotThrow(() => validate([freehand]));
    for (const bad of [
      { ...rectangle, bounds: { ...bounds, width: 0 } },
      { ...rectangle, bounds: { ...bounds, x: Infinity } },
      { ...rectangle, bounds: { ...bounds, path: 'private' } },
      { ...rectangle, bounds: undefined },
      { ...freehand, markup: { kind: 'freehand', points: [{ x: 0, y: 0 }] } },
      { ...freehand, markup: { kind: 'freehand', points: Array(513).fill({ x: 0, y: 0 }) } },
      {
        ...freehand,
        markup: {
          kind: 'freehand',
          points: [
            { x: NaN, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      },
      { ...freehand, markup: { kind: 'script', code: 'anything' } },
    ])
      assert.throws(() => validate([bad]));
  }
  const project = exampleProject();
  const before = structuredClone(project);
  const snapshot = captureAnnotationSelection(project.schematic, [], { kind: 'rectangle', bounds });
  bounds.x = 99;
  assert.equal(snapshot.markup?.kind === 'rectangle' && snapshot.markup.bounds.x, -10);
  assert.deepEqual(project, before);
});

test('HTTP rejects invalid attachments before starting any agent and forwards valid snapshots', async () => {
  const received: any[] = [];
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-annotation-http-'));
  const service = await startServer({
    dataDir,
    agentRunner: async (_provider, request) => {
      received.push(request);
      return { outcome: 'completed' };
    },
  });
  try {
    const annotation = annotationFixture();
    const body = {
      sessionId: 'annotation-session',
      provider: 'codex',
      prompt: 'Review',
      context: {},
      history: [],
      annotations: [annotation],
    };
    const post = (value: unknown) =>
      fetch(service.base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': service.token },
        body: JSON.stringify(value),
      });
    assert.equal(
      (
        await post({
          ...body,
          annotations: [
            { ...annotation, image: { ...annotation.image, dataUrl: 'file:///private.png' } },
          ],
        })
      ).status,
      400,
    );
    assert.equal(received.length, 0);
    const result = await post(body);
    assert.equal(result.status, 200);
    await result.text();
    assert.deepEqual(received[0].annotations, [annotation]);
    const project = exampleProject();
    const layout = layoutAnnotationContext(project.pcb!, project.schematic);
    assert.equal(
      (await post({ ...body, context: { layout: { ...layout, path: '/private' } } })).status,
      400,
    );
    assert.equal(received.length, 1);
    const pcbAnnotation = {
      ...annotation,
      ...capturePCBAnnotationSelection(project.pcb!, project.schematic, [
        project.pcb!.footprints[0].id,
      ]),
    };
    const layoutResult = await post({ ...body, context: { layout }, annotations: [pcbAnnotation] });
    assert.equal(layoutResult.status, 200);
    await layoutResult.text();
    assert.deepEqual(received[1].context.layout, layout);
    assert.deepEqual(received[1].annotations, [pcbAnnotation]);
  } finally {
    service.close();
  }
});
