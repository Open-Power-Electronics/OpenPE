import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlankProject } from '../lib/create-blank-project';
import { createPart, emptyCircuit } from '../lib/circuit';
import { resolveComponentHighlight } from '../components/component-highlight';

function fixture() {
  const project = createBlankProject();
  const part = createPart(project.schematic, 'R', 12.7, 25.4);
  part.ref = 'R42';
  project.schematic.parts.push(part);
  const footprint = {
    id: 'package',
    symbolId: part.id as string | null,
    libraryId: 'Resistor_SMD:R_0603',
    reference: part.ref,
    value: part.value,
    x: 30,
    y: 40,
    rotation: 0,
    side: 'front' as const,
    pads: [],
    graphics: [],
  };
  project.pcb!.footprints.push(footprint);
  return { project, part, footprint };
}

test('component highlighting resolves all six directions from the native symbol association', () => {
  const { project, part, footprint } = fixture();
  const before = JSON.stringify(project);
  const schematic = { view: 'canvas' as const, sheetId: project.schematic.id, id: part.id };
  for (const view of ['layout', '3d'] as const) {
    const target = resolveComponentHighlight(project, schematic, view);
    assert.deepEqual(target, {
      view,
      board: project.pcb,
      footprintId: footprint.id,
      location: { x: 30, y: 40 },
    });
    assert.equal(target.board, project.pcb);
  }
  for (const originView of ['layout', '3d'] as const) {
    const origin = { view: originView, id: footprint.id };
    assert.deepEqual(resolveComponentHighlight(project, origin, 'canvas'), {
      view: 'canvas',
      sheetId: project.schematic.id,
      partId: part.id,
      location: { x: 12.7, y: 25.4 },
    });
    const view = originView === 'layout' ? '3d' : 'layout';
    assert.deepEqual(resolveComponentHighlight(project, origin, view), {
      view,
      board: project.pcb,
      footprintId: footprint.id,
      location: { x: 30, y: 40 },
    });
  }
  assert.equal(
    JSON.stringify(project),
    before,
    'Highlighting changes no native data, placement or model assignments.',
  );
});

test('missing or removed footprints never fall back to a matching reference', () => {
  const { project, part, footprint } = fixture();
  const origin = { view: 'canvas' as const, sheetId: project.schematic.id, id: part.id };
  footprint.symbolId = null;
  assert.throws(
    () => resolveComponentHighlight(project, origin, 'layout'),
    /no linked PCB footprint/,
  );
  assert.throws(
    () => resolveComponentHighlight(project, { view: 'layout', id: footprint.id }, 'canvas'),
    /no linked schematic component/,
  );
  assert.equal(
    resolveComponentHighlight(project, { view: 'layout', id: footprint.id }, '3d').view,
    '3d',
    'A board-only footprint can be highlighted in Model.',
  );
  project.pcb = null;
  assert.throws(() => resolveComponentHighlight(project, origin, '3d'), /no linked PCB footprint/);
  assert.throws(
    () => resolveComponentHighlight(project, { view: '3d', id: footprint.id }, 'layout'),
    /no longer available/,
  );
});

test('independent sheets and ambiguous native links cannot highlight an unrelated footprint', () => {
  const { project, part, footprint } = fixture();
  const extra = emptyCircuit();
  const secondary = createPart(extra, 'R', 1, 2);
  secondary.ref = part.ref;
  extra.parts.push(secondary);
  project.additionalSchematics = [extra];
  assert.throws(
    () =>
      resolveComponentHighlight(
        project,
        { view: 'canvas', sheetId: extra.id, id: secondary.id },
        'layout',
      ),
    /sheet has no linked PCB/,
  );
  project.pcb!.footprints.push({ ...footprint, id: 'duplicate-link' });
  assert.throws(
    () =>
      resolveComponentHighlight(
        project,
        { view: 'canvas', sheetId: project.schematic.id, id: part.id },
        '3d',
      ),
    /more than one linked footprint/,
  );
});

test('navigation re-resolves current identities and rejects stale selections', () => {
  const { project, part, footprint } = fixture();
  const origin = { view: 'canvas' as const, sheetId: project.schematic.id, id: part.id };
  footprint.x = 99;
  assert.equal(resolveComponentHighlight(project, origin, 'layout').location.x, 99);
  assert.throws(() => resolveComponentHighlight(project, origin, 'canvas'), /already in this mode/);
  project.schematic.parts = [];
  assert.throws(() => resolveComponentHighlight(project, origin, 'layout'), /no longer available/);
  assert.throws(
    () => resolveComponentHighlight(project, { view: '3d', id: footprint.id }, 'canvas'),
    /no linked schematic component/,
  );
});
