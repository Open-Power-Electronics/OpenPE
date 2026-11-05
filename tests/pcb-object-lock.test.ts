import assert from 'node:assert/strict';
import test from 'node:test';
import { createHomeExample } from '../lib/create-home-example';
import { uid } from '../lib/circuit';
import { ProjectCore } from '../core/project-core';
import { pcbLockObject, setPCBLocked, type PCBLockTarget } from '../lib/pcb-lock';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { invalidatePCBFill } from '../lib/pcb';
import { defaultPCBSelectionFilters, pcbSelectionEligible } from '../lib/pcb-selection';
import { movePCBSelection, deletePCBSelection, rotatePCBSelection } from '../lib/pcb-layout';

function fixture() {
  const project = createHomeExample('reference-lm2596-to220-5-buck');
  const board = project.pcb!;
  const text = { value: 'Locked text', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.15 };
  board.graphics.push(
    {
      id: uid(),
      kind: 'text',
      layer: 'F.SilkS',
      start: { x: 10, y: 10 },
      end: { x: 10, y: 10 },
      width: 0.15,
      text,
    },
    {
      id: uid(),
      kind: 'dimension',
      layer: 'Dwgs.User',
      start: { x: 10, y: 10 },
      end: { x: 20, y: 10 },
      width: 0.15,
      dimension: {
        type: 'aligned',
        height: 5,
        format: { prefix: '', suffix: '', units: 2, unitsFormat: 1, precision: 2 },
        style: { arrowLength: 1.27, textPositionMode: 2, extensionOffset: 0.5 },
        caption: { ...text, value: '10.00 mm', x: 15, y: 15 },
      },
    },
  );
  const { filledPolygons: _filledPolygons, ...ruleArea } = board.zones[0];
  board.zones.push({
    ...ruleArea,
    id: uid(),
    netId: null,
    keepout: { tracks: true, vias: true, pads: true, copperpour: true, footprints: true },
  });
  const targets: PCBLockTarget[] = [
    { kind: 'pad', id: board.footprints[0].pads[0].id },
    { kind: 'footprint', id: board.footprints[0].id },
    { kind: 'track', id: board.tracks[0].id },
    { kind: 'via', id: board.vias[0].id },
    { kind: 'graphic', id: board.graphics[0].id },
    { kind: 'zone', id: board.zones[0].id },
    { kind: 'zone', id: board.zones.at(-1)!.id },
    { kind: 'graphic', id: board.graphics.at(-2)!.id },
    { kind: 'graphic', id: board.graphics.at(-1)!.id },
  ];
  return { project, board, targets };
}

test('all selectable board object locks retain native state, fills and exact unlocked bytes', () => {
  const { project, board, targets } = fixture();
  const original = projectNativeFiles(project);
  const locked = setPCBLocked(board, targets, true);
  assert.equal(invalidatePCBFill(board, locked), locked);
  assert.equal(locked.zones[0].filledPolygons, board.zones[0].filledPolygons);
  const files = projectNativeFiles({ ...project, pcb: locked });
  const reopened = projectFromNativeFiles(files).pcb!;
  for (const target of targets)
    assert.equal(pcbLockObject(reopened, target)?.locked, true, target.kind);
  const unlocked = setPCBLocked(reopened, targets, false);
  for (const target of targets)
    assert.equal(Object.hasOwn(pcbLockObject(unlocked, target)!, 'locked'), false);
  assert.deepEqual(
    projectNativeFiles({ ...project, pcb: setPCBLocked(locked, targets, false) }),
    original,
  );
});

test('locked object filters and direct transformations cover every selectable category', () => {
  const { board, targets } = fixture();
  const locked = setPCBLocked(board, targets, true);
  for (const target of targets) {
    if (target.kind === 'pad') continue;
    assert.equal(
      pcbSelectionEligible(locked, target, defaultPCBSelectionFilters()),
      false,
      target.kind,
    );
    assert.equal(
      pcbSelectionEligible(locked, target, { ...defaultPCBSelectionFilters(), locked: true }),
      true,
    );
    assert.throws(() => movePCBSelection(locked, target, { x: 1, y: 1 }), /Unlock/);
    assert.throws(() => rotatePCBSelection(locked, target), /Unlock/);
    assert.throws(() => deletePCBSelection(locked, target), /Unlock/);
  }
});

test('object locks share Core undo, reject locked replacements and retain Source and revision barriers', () => {
  const { project, targets } = fixture();
  const core = new ProjectCore(project);
  const baseline = core.getNativeFiles();
  const boardId = project.pcb!.id;
  core.execute('layout.lock', { boardId, targets, locked: true });
  assert.equal(core.getSnapshot().undoDepth, 1);
  const board = core.getSnapshot().project!.pcb!;
  assert.throws(
    () =>
      core.replaceBoard({
        ...board,
        vias: board.vias.map((v, i) => (i ? v : { ...v, x: v.x + 1 })),
      }),
    /Unlock/,
  );
  assert.equal(core.getSnapshot().undoDepth, 1);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), baseline);
  core.redo();
  core.execute('layout.lock', { boardId, targets, locked: false });
  for (const target of targets)
    assert.equal(pcbLockObject(core.getSnapshot().project!.pcb!, target)?.locked, undefined);
  core.updateSource(core.getSnapshot().source + '\n');
  assert.throws(() => core.execute('layout.lock', { boardId, targets, locked: true }), /Source/);
});
