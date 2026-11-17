import { switchingStageFixture } from './fixtures/switching-stage';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  exportKiCad,
  importDocument,
  MAX_PROJECT_BYTES,
  parseProject,
  serializeProject,
  validateProject,
} from '../lib/project';
import { exampleProject } from '../lib/project-example';
import { parseCircuit, serializeCircuit } from '../lib/circuit';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import { ownProject } from '../lib/immutable-project';
import { toProjectDocument } from '../lib/project-document';
import { formatProjectJson } from '../lib/project-json';

test('project parsing retains its UTF-8 limit and error priority at exactly 8 MB', () => {
  for (const source of ['a'.repeat(MAX_PROJECT_BYTES + 1), '中'.repeat(2_666_667)])
    assert.throws(() => parseProject(source), {
      message: 'Invalid OpenPE project: file exceeds 8 MB.',
    });
  for (const source of ['a'.repeat(MAX_PROJECT_BYTES), '中'.repeat(2_666_666) + 'aa'])
    assert.throws(() => parseProject(source), {
      message:
        'Invalid OpenPE project: expected a valid internal project snapshot. Open native KiCad files through Open project.',
    });
});

test('JSON round trip preserves schematic, PCB, identities and extension data exactly', () => {
  const p = exampleProject();
  p.extensions['example.org'] = { note: '汉字 Ω " \\ newline\n', data: [true, null, 42] };
  assert.equal(serializeProject(parseProject(serializeProject(p))), serializeProject(p));
  const source = serializeProject(p);
  p.schematic.parts[0].value = '2k';
  p.schematic.parts[0].ref = 'R42';
  const reopened = parseProject(serializeProject(p));
  assert.deepEqual(reopened.pcb, parseProject(source).pcb);
  const pcb = exportKiCad(reopened, 'pcb');
  assert.match(pcb, /"Reference" "R42"/);
  assert.match(pcb, /"Value" "2k"/);
  assert.equal(serializeProject(reopened), serializeProject(p));
});
test('KiCad imports retain original syntax metadata and never invent PCB data', () => {
  const original = serializeCircuit(switchingStageFixture());
  const project = importDocument(original);
  assert.equal(project.pcb, null);
  assert.equal(
    serializeProject(parseProject(serializeProject(project))),
    serializeProject(project),
  );
  assert.equal(parseCircuit(exportKiCad(project, 'schematic')).id, parseCircuit(original).id);
  assert.throws(() => exportKiCad(project, 'pcb'), /no PCB layout/);
  assert.notEqual(createProject().id, createProject().id);
});
test('KiCad export contains every supported PCB object, stable links, pad rotations and footprint assignments', () => {
  const p = exampleProject();
  const b = p.pcb!;
  const pcb = parseSExpr(exportKiCad(p, 'pcb'));
  assert.equal(pcb[0], 'kicad_pcb');
  assert.equal(val(child(pcb, 'version')), '20260206');
  assert.equal(val(child(children(pcb, 'segment')[0], 'net')), '/OUT');
  assert.equal(val(child(children(pcb, 'zone')[0], 'net')), 'GND');
  for (const [kind, expected] of [
    ['footprint', 2],
    ['segment', 2],
    ['via', 1],
    ['zone', 1],
    ['gr_line', 4],
    ['net', 3],
  ] as const)
    assert.equal(children(pcb, kind).length, expected);
  const footprints = children(pcb, 'footprint');
  assert.equal(val(child(footprints[1], 'path')), `/${p.schematic.id}/${b.footprints[1].symbolId}`);
  assert.equal(val(child(footprints[1], 'uuid')), b.footprints[1].id);
  assert.equal(val(child(children(footprints[1], 'pad')[0], 'at'), 3), '90');
  const sch = parseSExpr(exportKiCad(p, 'schematic'));
  assert.equal(val(child(sch, 'version')), '20260306');
  const footprintProperty = children(children(sch, 'symbol')[0], 'property').find(
    (v) => val(v) === 'Footprint',
  )!;
  assert.equal(val(child(footprintProperty, 'hide')), 'yes');
  assert.equal(child(child(footprintProperty, 'effects')!, 'hide'), undefined);
  assert.equal(
    val(
      children(children(sch, 'symbol')[0], 'property').find((v) => val(v) === 'Footprint'),
      2,
    ),
    b.footprints[0].libraryId,
  );
});
test('rejects unsupported versions, unknown fields, dangling links, bad dimensions and duplicate UUIDs', () => {
  const cases: ((p: any) => void)[] = [
    (p) => (p.version = 2),
    (p) => (p.units = 'inch'),
    (p) => (p.pcb.unknown = 3),
    (p) => (p.schematic.parts[0].x = Infinity),
    (p) => (p.pcb.tracks[0].netId = p.id),
    (p) => (p.pcb.footprints[0].symbolId = p.id),
    (p) => p.schematic.parts.splice(0, 1),
    (p) => (p.pcb.footprints[0].pads[0].number = 'nonexistent'),
    (p) => (p.pcb.vias[0].id = p.pcb.tracks[0].id),
    (p) => (p.pcb.footprints[0].pads[0].drill = 10),
    (p) => (p.pcb.footprints[1].pads[0].drill = 0.2),
    (p) => (p.pcb.vias[0].drill = p.pcb.vias[0].diameter),
    (p) => (p.pcb.tracks[0].layer = 'In1.Cu'),
    (p) =>
      (p.pcb.zones[0].outline = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ]),
    (p) => (p.pcb.nets[1].name = p.pcb.nets[0].name),
  ];
  for (const mutate of cases) {
    const p = exampleProject();
    mutate(p);
    assert.throws(() => validateProject(p), /Invalid OpenPE project/);
  }
});
test('repeated validation trusts only successful immutable project trees', () => {
  const caller = exampleProject();
  const owned = ownProject(caller);
  const expectedSchematic = exportKiCad(caller, 'schematic');
  const expectedPCB = exportKiCad(caller, 'pcb');
  for (let index = 0; index < 3; index++) {
    validateProject(owned);
    assert.equal(exportKiCad(owned, 'schematic'), expectedSchematic);
    assert.equal(exportKiCad(owned, 'pcb'), expectedPCB);
  }

  // Caller freezing is shallow, so an earlier successful check cannot certify
  // descendants that the caller can still change before the next export.
  Object.freeze(caller);
  validateProject(caller);
  const track = caller.pcb!.tracks[0];
  const netId = track.netId;
  track.netId = caller.id;
  for (let index = 0; index < 2; index++) {
    assert.throws(() => validateProject(caller), /Invalid OpenPE project/);
    assert.throws(() => exportKiCad(caller, 'pcb'), /Invalid OpenPE project/);
  }
  const invalidOwned = ownProject(caller);
  for (let index = 0; index < 2; index++)
    assert.throws(() => validateProject(invalidOwned), /Invalid OpenPE project/);
  track.netId = netId;
  validateProject(caller);
  assert.equal(exportKiCad(caller, 'pcb'), expectedPCB);
  assert.equal(exportKiCad(owned, 'pcb'), expectedPCB);
});

test('reused immutable board validation still checks new root UUIDs, symbol links, pin maps and changed geometry', () => {
  const project = ownProject(exampleProject());
  validateProject(project);
  const board = project.pcb!;
  const colliding = ownProject({ ...project, id: board.tracks[0].id }, project);
  assert.equal(colliding.pcb, board);
  assert.throws(() => validateProject(colliding), /duplicate UUID/);
  const removed = ownProject(
    { ...project, schematic: { ...project.schematic, parts: project.schematic.parts.slice(1) } },
    project,
  );
  assert.equal(removed.pcb, board);
  assert.throws(() => validateProject(removed), /missing schematic symbol/);
  const draft = structuredClone(project);
  const part = draft.schematic.parts[0];
  const pad = board.footprints.find((footprint) => footprint.symbolId === part.id)!.pads[0];
  const library = draft.schematic.libraries[part.libId];
  for (const unit of children(library, 'symbol'))
    for (const pin of children(unit, 'pin'))
      if (val(child(pin, 'number')) === pad.number) child(pin, 'number')![1] = '"99"';
  const remapped = ownProject(draft, project);
  assert.equal(remapped.pcb, board);
  assert.notEqual(remapped.schematic.libraries, project.schematic.libraries);
  assert.throws(() => validateProject(remapped), /has no pin/);
  const edited = ownProject(
    {
      ...project,
      pcb: {
        ...board,
        tracks: board.tracks.map((track, index) => (index ? track : { ...track, width: -1 })),
      },
    },
    project,
  );
  assert.throws(() => validateProject(edited), /Invalid OpenPE project/);
  const extra = ownProject(
    {
      ...project,
      additionalSchematics: [{ ...createProject().schematic, id: board.tracks[0].id }],
    },
    project,
  );
  assert.throws(() => validateProject(extra), /duplicate UUID/);
  validateProject(project);
});

test('cached structural bounds retain the complete combined node and nesting limits', () => {
  const project = ownProject(exampleProject());
  const branch = Array.from({ length: 10000 }, () => ({ value: true }));
  const bounded = ownProject({ ...project, extensions: { branch } }, project);
  validateProject(bounded);
  const overflow = ownProject(
    {
      ...bounded,
      extensions: { repeated: Array.from({ length: 20 }, () => bounded.extensions.branch) },
    },
    bounded,
  );
  assert.throws(() => validateProject(overflow), /object count/);
  let nested: unknown = bounded.extensions.branch;
  for (let depth = 0; depth < 79; depth++) nested = [nested];
  assert.throws(() => validateProject({ ...project, extensions: { nested } }), /nesting/);
});

test('private immutable geometry reuse keeps canonical bytes and public conversions independent', () => {
  const project = ownProject(exampleProject());
  const expected = serializeProject(project);
  for (let index = 0; index < 3; index++) {
    const document = toProjectDocument(project);
    assert.equal(formatProjectJson(document), expected);
    const footprint = document.schematic.components?.flatMap((part) => part.footprints ?? [])[0];
    assert.ok(footprint);
    footprint.pads[0].size.x = 99;
    if (document.pcb?.graphics?.[0]) document.pcb.graphics[0].width = 99;
    assert.equal(serializeProject(project), expected);
    assert.equal(serializeProject(parseProject(expected)), expected);
  }
  const caller = exampleProject();
  const oldBytes = exportKiCad(caller, 'pcb');
  Object.freeze(caller.pcb);
  caller.pcb!.tracks[0].width += 0.1;
  assert.notEqual(exportKiCad(caller, 'pcb'), oldBytes);
});

test('returned private conversions cannot replace a cached sheet library map', () => {
  const project = ownProject(exampleProject());
  const expected = serializeProject(structuredClone(project));
  const document = toProjectDocument(project, true);
  assert.ok(document.libraries);
  assert.throws(() => {
    document.libraries!.symbols = {};
  }, /read only|readonly|Cannot assign/);
  assert.equal(serializeProject(project), expected);
  assert.equal(serializeProject(parseProject(serializeProject(project))), expected);
});
test('rejects altered raw syntax and excessive nesting before either serializer can lose data', () => {
  const p = importDocument(serializeCircuit(switchingStageFixture()));
  p.schematic.parts[0].raw![0] = 'wire';
  assert.throws(() => serializeProject(p));
  const p2 = exampleProject();
  p2.schematic.libraries['Device:R'][0] = 'symbol) (evil';
  assert.throws(() => serializeProject(p2), /atom/);
  const p3 = createProject();
  let nested: any = {};
  for (let i = 0; i < 100; i++) nested = { nested };
  p3.extensions.deep = nested;
  assert.throws(() => serializeProject(p3), /nesting/);
});

test('KiCad 10 export reimports its supported subset and rejects future and alternate-body documents', () => {
  const p = exampleProject();
  const source = exportKiCad(p, 'schematic');
  const imported = importDocument(source);
  assert.equal(imported.schematic.id, p.schematic.id);
  assert.deepEqual(
    imported.schematic.parts.map((p) => [p.id, p.ref, p.value, p.x, p.y, p.rotation]),
    p.schematic.parts.map((p) => [p.id, p.ref, p.value, p.x, p.y, p.rotation]),
  );
  assert.throws(() => importDocument(source.replace('20260306', '20990101')), /version/);
  assert.throws(
    () => importDocument(source.replace('(unit 1)', '(unit 1) (body_style 2)')),
    /alternate-body/,
  );
});
