import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { nativeIdentity } from '../lib/kicad-project-identity';
import { parseProject, serializeProject } from '../lib/project';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { child, children, parseSExpr, quote, val } from '../lib/sexpr';

const firstTrack = '82ab1144-e343-4349-bbe5-e49e7cbec575';
const secondTrack = '119ea80d-ea3b-4c63-8364-7ae5a25466f7';
const innerGroup = '2cbff415-2fef-4e0c-ba59-3b603815a555';
const outerGroup = '860e276e-078c-4457-9849-4e0f60ef7392';
const missingItem = '6a23588a-aa6a-483e-b281-e5147885af47';
const boardName = 'Grouped.kicad_pcb';
const nativeProperty = '(property "AUTHOR" "Board author")';
const inner = `(group "Inside" (uuid "${innerGroup}") (members "${firstTrack}"))`;
const outer = `(group "Outside" (uuid "${outerGroup}") (members "${innerGroup}" "${secondTrack}"))`;

function fixture(metadata: string) {
  const source = `(kicad_pcb
    (version 20260206)
    (generator "pcbnew")
    (general (thickness 1.6))
    (paper "A4")
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    (setup (pad_to_mask_clearance 0))
    (net 0 "")
    (net 1 "GND")
    (segment (start 10 10) (end 15 10) (width 0.25) (layer "F.Cu") (net "GND") (uuid "${firstTrack}"))
    (segment (start 10 20) (end 15 20) (width 0.25) (layer "F.Cu") (net "GND") (uuid "${secondTrack}"))
    ${metadata}
  )\n`;
  return { entry: boardName, files: [{ name: boardName, source }] };
}

test('native board groups follow track deletion and whole-project undo while retaining properties', () => {
  const bundle = fixture(`${nativeProperty} ${inner} ${outer}`);
  const project = projectFromNativeFiles(bundle);
  const core = new ProjectCore(project);
  const source = () => core.getNativeFiles().files.find((file) => file.name === boardName)!.source;
  assert.equal(source(), bundle.files[0].source);
  const saved = projectNativeFiles(project).files.find((file) => file.name === boardName)!;
  assert.deepEqual(children(parseSExpr(saved.source), 'group'), [
    parseSExpr(inner),
    parseSExpr(outer),
  ]);

  core.execute('layout.delete', {
    boardId: project.pcb!.id,
    selection: [{ kind: 'track', id: firstTrack }],
  });
  const edited = source();
  const board = parseSExpr(edited);
  assert.deepEqual(children(board, 'group'), [
    parseSExpr(`(group "Outside" (uuid "${outerGroup}") (members "${secondTrack}"))`),
  ]);
  assert.deepEqual(child(board, 'property'), parseSExpr(nativeProperty));
  assert.equal(val(child(board, 'version')), '20260206');
  assert.equal(core.undo(), true);
  assert.equal(source(), bundle.files[0].source);
  assert.equal(core.redo(), true);
  assert.equal(source(), edited);
});

test('native board metadata rejects unsupported group authority and invalid references', () => {
  assert.throws(
    () => projectFromNativeFiles(fixture(inner.replace('(members', '(locked maybe) (members'))),
    /Invalid or unsupported PCB group metadata/,
  );
  assert.throws(
    () => projectFromNativeFiles(fixture(inner.replace(firstTrack, missingItem))),
    /missing or unsupported board item/,
  );
  assert.throws(
    () => projectFromNativeFiles(fixture(`${inner.replace(firstTrack, outerGroup)} ${outer}`)),
    /membership cycle/,
  );
  assert.throws(
    () => projectFromNativeFiles(fixture(`${nativeProperty} ${nativeProperty}`)),
    /repeated PCB board property/,
  );
});

test('repeated native membership uses the last group and retains all surviving declarations', () => {
  const earlier = `(group "Former" (uuid "${innerGroup}") (locked yes) (members "${firstTrack}" "${firstTrack}"))`;
  const later = `(group "Current" (uuid "${outerGroup}") (members "${firstTrack}"))`;
  const bundle = fixture(`${earlier} ${later}`);
  const project = projectFromNativeFiles(bundle);
  const core = new ProjectCore(project);
  const saved = () => core.getNativeFiles().files.find(({ name }) => name === boardName)!.source;
  assert.equal(saved(), bundle.files[0].source);
  assert.equal(project.pcb!.groupLocks, undefined);
  core.execute('layout.track.properties', {
    boardId: project.pcb!.id,
    trackId: firstTrack,
    width: 0.3,
  });
  assert.deepEqual(children(parseSExpr(saved()), 'group'), [
    parseSExpr(earlier),
    parseSExpr(later),
  ]);
  core.execute('layout.delete', {
    boardId: project.pcb!.id,
    selection: [{ kind: 'track', id: firstTrack }],
  });
  assert.deepEqual(children(parseSExpr(saved()), 'group'), [
    parseSExpr(`(group "Former" (uuid "${innerGroup}") (locked yes) (members))`),
  ]);
  assert.equal(
    projectFromNativeFiles({ entry: boardName, files: [{ name: boardName, source: saved() }] }).pcb!
      .groupLocks,
    undefined,
  );
});

test('native board properties expand for Layout while Save preserves the literal expression', () => {
  const text =
    '(gr_text "${AUTHOR}" (at 10 10) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))';
  const bundle = fixture(`${nativeProperty} ${text}`);
  const project = projectFromNativeFiles(bundle);
  const label = project.pcb!.graphics[0].text!;
  assert.equal(label.value, '${AUTHOR}');
  assert.equal(label.nativeExpansion?.value, val(parseSExpr(nativeProperty), 2));
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === bundle.entry)!.source,
    bundle.files[0].source,
  );
});

test('group membership follows every split zone layer and deletes only the removed zone member', () => {
  const zone = 'd3f5c1b4-1fdc-4d89-a95a-f6ce3b63f942';
  const back = nativeIdentity(`${zone}:layer:B.Cu`);
  const group = `(group "Both layers" (uuid "${outerGroup}") (members "${zone}"))`;
  const bundle = fixture(`
    (zone (net "GND") (layers "F.Cu" "B.Cu") (uuid "${zone}") (hatch edge 0.5)
      (connect_pads (clearance 0.2)) (min_thickness 0.25)
      (fill (thermal_gap 0.3) (thermal_bridge_width 0.3))
      (polygon (pts (xy 30 30) (xy 40 30) (xy 40 40) (xy 30 40))))
    ${group}
  `);
  const project = projectFromNativeFiles(bundle);
  const boardId = project.pcb!.id;
  const core = new ProjectCore(project);
  const board = () =>
    parseSExpr(core.getNativeFiles().files.find((file) => file.name === boardName)!.source);
  const clean = projectNativeFiles(project).files.find((file) => file.name === boardName)!;
  assert.deepEqual(child(parseSExpr(clean.source), 'group'), parseSExpr(group));
  assert.equal(children(parseSExpr(clean.source), 'zone').length, 1);
  assert.deepEqual(
    project.pcb!.zones.map(({ id, layer }) => [id, layer]),
    [
      [zone, 'F.Cu'],
      [back, 'B.Cu'],
    ],
  );

  core.execute('layout.delete', { boardId, selection: [{ kind: 'track', id: firstTrack }] });
  assert.deepEqual(child(child(board(), 'group')!, 'members'), [
    'members',
    quote(zone),
    quote(back),
  ]);
  core.execute('layout.delete', { boardId, selection: [{ kind: 'zone', id: zone }] });
  assert.deepEqual(child(child(board(), 'group')!, 'members'), ['members', quote(back)]);
  assert.deepEqual(
    children(board(), 'zone').map((item) => val(child(item, 'uuid'))),
    [back],
  );
});

test('locked nested board groups protect members and keep native lock provenance', () => {
  const lockedOuter = outer.replace('(members', '(locked yes) (members');
  const bundle = fixture(`${inner} ${lockedOuter}`);
  // One member also has its own native lock and must retain both.
  bundle.files[0].source = bundle.files[0].source.replace(
    `(net "GND") (uuid "${secondTrack}")`,
    `(net "GND") (locked yes) (uuid "${secondTrack}")`,
  );
  const project = projectFromNativeFiles(bundle);
  assert.deepEqual(project.pcb!.groupLocks, [firstTrack, secondTrack].sort());
  assert.equal(
    project.pcb!.tracks.every((track) => track.locked),
    true,
  );
  assert.deepEqual(
    parseProject(serializeProject(project)).pcb!.groupLocks,
    project.pcb!.groupLocks,
  );
  const core = new ProjectCore(project);
  const boardId = project.pcb!.id;
  const selection = [{ kind: 'track', id: firstTrack }];
  assert.throws(
    () => core.execute('layout.lock', { boardId, targets: selection, locked: false }),
    /native group in Source/,
  );
  assert.throws(() => core.execute('layout.delete', { boardId, selection }), /Unlock/i);
  assert.throws(
    () =>
      core.commitProject({
        ...project,
        pcb: {
          ...project.pcb!,
          tracks: project.pcb!.tracks.map((track) =>
            track.id === firstTrack ? { ...track, width: 0.5 } : track,
          ),
        },
      }),
    /native group in Source/,
  );
  assert.equal(core.replaceBoard({ ...project.pcb!, thickness: 1.5 }), true);
  const saved = core.getNativeFiles();
  const board = parseSExpr(saved.files.find((file) => file.name === boardName)!.source);
  assert.deepEqual(children(board, 'group'), [parseSExpr(inner), parseSExpr(lockedOuter)]);
  assert.deepEqual(
    children(board, 'segment').map((segment) => val(child(segment, 'locked'))),
    ['', 'yes'],
  );
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.groupLocks, project.pcb!.groupLocks);
});

test('footprint groups retain local membership across edits and lock the owning footprint', () => {
  const footprintId = 'b33c7bfd-ef19-48c4-a076-d63e1e6c7c6a';
  const graphicId = 'b622cdaa-f43f-4532-97db-9f8ca45b47a4';
  const local = `(group "Package Artwork" (uuid "${innerGroup}") (members "${graphicId}"))`;
  const footprint = `(footprint "OpenPE:Example" (layer "F.Cu") (at 15 15) (uuid "${footprintId}")
    (property "Reference" "X1") (property "Value" "Example")
    (fp_line (start 0 0) (end 3 0) (stroke (width 0.15) (type default)) (layer "F.SilkS") (uuid "${graphicId}"))
    ${local})`;
  const project = projectFromNativeFiles(fixture(footprint));
  const core = new ProjectCore(project);
  const boardId = project.pcb!.id;
  const node = () =>
    child(
      parseSExpr(core.getNativeFiles().files.find((file) => file.name === boardName)!.source),
      'footprint',
    )!;
  core.execute('layout.delete', { boardId, selection: [{ kind: 'track', id: firstTrack }] });
  assert.deepEqual(child(node(), 'group'), parseSExpr(local));
  const board = core.getSnapshot().project!.pcb!;
  const fp = board.footprints[0];
  assert.equal(
    core.replaceBoard({
      ...board,
      footprints: [{ ...fp, graphics: fp.graphics.filter((graphic) => graphic.id !== graphicId) }],
    }),
    true,
  );
  assert.equal(child(node(), 'group'), undefined);

  const lockedLocal = local.replace('(members', '(locked yes) (members');
  const locked = projectFromNativeFiles(fixture(footprint.replace(local, lockedLocal)));
  assert.deepEqual(locked.pcb!.groupLocks, [footprintId, graphicId].sort());
  assert.equal(locked.pcb!.footprints[0].locked, true);
  assert.equal(locked.pcb!.footprints[0].graphics[0].locked, true);
  const lockedCore = new ProjectCore(locked);
  assert.throws(
    () =>
      lockedCore.execute('layout.move', {
        boardId: locked.pcb!.id,
        selection: [{ kind: 'footprint', id: footprintId }],
        delta: { x: 2, y: 2 },
      }),
    /Unlock/i,
  );
  assert.equal(lockedCore.replaceBoard({ ...locked.pcb!, thickness: 1.5 }), true);
  const written = child(
    parseSExpr(lockedCore.getNativeFiles().files.find((file) => file.name === boardName)!.source),
    'footprint',
  )!;
  assert.equal(child(written, 'locked'), undefined);
  assert.equal(child(child(written, 'fp_line')!, 'locked'), undefined);
  assert.deepEqual(child(written, 'group'), parseSExpr(lockedLocal));
});

test('native net ties preserve distinct pads and require Source for copper changes', () => {
  const footprint = `(footprint "OpenPE:NetTie" (layer "F.Cu") (at 15 15)
    (property "Reference" "NT1") (property "Value" "Net tie")
    (net_tie_pad_groups "1, 2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))
    (pad "2" smd rect (at 0.9 0) (size 1 1) (layers "F.Cu") (net "Return")))`;
  const project = projectFromNativeFiles(fixture(footprint));
  const board = project.pcb!;
  const native = board.footprints[0];
  assert.deepEqual(native.netTiePadGroups, ['1, 2']);
  assert.notEqual(native.pads[0].netId, native.pads[1].netId);
  assert.deepEqual(runPCBDesignRules(board, { scopes: ['clearance'] }).issues, []);
  const withoutTie = projectFromNativeFiles(
    fixture(footprint.replace('(net_tie_pad_groups "1, 2")', '')),
  ).pcb!;
  assert.equal(
    runPCBDesignRules(withoutTie, { scopes: ['clearance'] }).issues[0]?.ruleId,
    'pcb.short',
  );
  const core = new ProjectCore(project);
  assert.throws(
    () => core.replaceBoard({ ...board, footprints: [{ ...native, x: native.x + 1 }] }),
    /native footprint net ties require native Source/,
  );
  assert.equal(core.replaceBoard({ ...board, thickness: 1.5 }), true);
  const saved = core.getNativeFiles();
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.footprints[0].netTiePadGroups, ['1, 2']);
  assert.throws(
    () => projectFromNativeFiles(fixture(footprint.replace('1, 2', '1, 3'))),
    /distinct existing electrical pad numbers/,
  );
});

test('native net-tie copper connects only declared terminals and keeps unrelated shorts visible', () => {
  const tie = `(footprint "OpenPE:NetTie" (layer "F.Cu") (at 30 30)
    (property "Reference" "NT1") (property "Value" "Net tie")
    (net_tie_pad_groups "1, 2")
    (fp_line (start 0 0) (end 2 0) (stroke (width 0.3) (type solid)) (layer "F.Cu"))
    (fp_line (start 2 0) (end 4 0) (stroke (width 0.3) (type solid)) (layer "F.Cu"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))
    (pad "2" smd rect (at 4 0) (size 1 1) (layers "F.Cu") (net "Return")))`;
  const remote = `(footprint "OpenPE:Terminal" (layer "F.Cu") (at 32 33)
    (property "Reference" "X1") (property "Value" "Terminal")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND")))
    (segment (start 32 33) (end 32 30) (width 0.25) (layer "F.Cu") (net "GND"))`;
  const run = (metadata: string) =>
    runPCBDesignRules(projectFromNativeFiles(fixture(metadata)).pcb!, {
      scopes: ['clearance', 'connectivity'],
    }).issues;
  const throughTerminal = remote.replace('(end 32 30)', '(end 30 30)');
  assert.deepEqual(run(tie + throughTerminal), []);
  const midside = run(tie + remote);
  assert.equal(midside.filter(({ ruleId }) => ruleId === 'pcb.short').length, 1);
  assert.equal(midside.filter(({ ruleId }) => ruleId === 'pcb.unrouted').length, 1);

  const foreignTrack =
    '(segment (start 31 28) (end 31 30) (width 0.25) (layer "F.Cu") (net "Other"))';
  assert.ok(run(tie + throughTerminal + foreignTrack).some(({ ruleId }) => ruleId === 'pcb.short'));
  const broken = tie.replace('(start 0 0) (end 2 0)', '(start 1 0) (end 2 0)');
  assert.ok(run(broken + remote).some(({ ruleId }) => ruleId === 'pcb.unrouted'));

  const unauthorized = `${tie.slice(0, -1)}
    (pad "3" smd rect (at 1 0) (size 0.4 0.4) (layers "F.Cu") (net "Other")))`;
  assert.ok(
    run(unauthorized + remote).some(
      ({ ruleId, message }) =>
        ruleId === 'pcb.short' && /pads 1 and 3 .*declared net-tie group/.test(message),
    ),
  );
});
