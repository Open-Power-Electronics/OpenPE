import test from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../lib/circuit';
import type { BoardLine } from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject } from '../lib/project';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import {
  pcbDimensionOverrideValue,
  pcbDimensionUnitSuffix,
  setPCBDimensionOverrideValue,
  type FormattedPCBDimension,
} from '../lib/pcb-dimension-text';

function dimension(): FormattedPCBDimension {
  return {
    type: 'aligned',
    height: 5,
    format: { prefix: 'L=', suffix: ' nominal', units: 2, unitsFormat: 1, precision: 2 },
    style: { arrowLength: 1.27, textPositionMode: 2, extensionOffset: 0.5 },
    caption: {
      x: 7,
      y: 11,
      value: 'L=10.00 mm nominal',
      rotation: 15,
      size: { x: 1, y: 1.5 },
      thickness: 0.2,
    },
  };
}

test('dimension override separates affixes and updates native authority without duplicating them', () => {
  const original = dimension();
  assert.equal(pcbDimensionOverrideValue(original), '10.00');
  const edited = setPCBDimensionOverrideValue(original, '11.25 ±0.1');
  assert.equal(edited.format.overrideValue, '11.25 ±0.1');
  assert.equal(edited.caption.value, 'L=11.25 ±0.1 mm nominal');
  assert.equal(pcbDimensionOverrideValue(edited), '11.25 ±0.1');
  assert.deepEqual({ ...edited.caption, value: original.caption.value }, original.caption);
  assert.equal(edited.style, original.style);
  assert.equal(original.format.overrideValue, undefined);
  const again = setPCBDimensionOverrideValue(edited, '12.50');
  assert.equal(again.caption.value, 'L=12.50 mm nominal');
});

test('dimension overrides retain resolved automatic units and parenthetical unit formatting', () => {
  const original = dimension();
  original.format = { ...original.format, units: 3, unitsFormat: 2 };
  original.caption.value = 'L=0.40 (in) nominal';
  assert.equal(pcbDimensionOverrideValue(original), '0.40');
  assert.equal(setPCBDimensionOverrideValue(original, '0.45').caption.value, 'L=0.45 (in) nominal');
  original.format.unitsFormat = 0;
  original.caption.value = 'L=10 nominal';
  assert.equal(setPCBDimensionOverrideValue(original, '').caption.value, 'L= nominal');
  original.format.unitsFormat = 1;
  assert.equal(pcbDimensionUnitSuffix(original), null);
  assert.throws(() => setPCBDimensionOverrideValue(original, '10'), /automatic units/);
});

test('dimension caption and override survive actual native board export, reopen and Core undo', () => {
  const graphic: BoardLine = {
    id: uid(),
    kind: 'dimension',
    layer: 'Dwgs.User',
    start: { x: 0, y: 0 },
    end: { x: 10, y: 0 },
    width: 0.2,
    dimension: dimension(),
  };
  const project = createProject();
  project.pcb = { ...createEmptyPCB(), graphics: [graphic] };
  const core = new ProjectCore(project);
  const initial = core.getNativeFiles();
  const board = core.getSnapshot().project!.pcb!;
  const updated = setPCBDimensionOverrideValue(board.graphics[0].dimension!, '12.50');
  assert.equal(
    core.replaceBoard({ ...board, graphics: [{ ...board.graphics[0], dimension: updated }] }),
    true,
  );
  assert.equal(core.getSnapshot().undoDepth, 1);
  const files = core.getNativeFiles();
  const boardFile = files.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
  const native = children(parseSExpr(boardFile.source), 'dimension')[0];
  assert.equal(val(child(child(native, 'format')!, 'override_value')), '12.50');
  assert.equal(val(child(native, 'gr_text')), 'L=12.50 mm nominal');
  const reopened = projectFromNativeFiles(files);
  assert.deepEqual(reopened.pcb!.graphics[0].dimension, updated);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), initial);
});
