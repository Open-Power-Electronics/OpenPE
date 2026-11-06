import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { compileCapabilitySchema } from '../api/capability-schema';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { emptyCircuit, pinPositions, uid } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import { partFields } from '../lib/library';
import { updatePCBFromSchematic } from '../lib/pcb-sync';
import { createProject, projectFromNativeFiles, type Project } from '../lib/project';
import {
  prepareSymbolDrawing,
  readSymbolDrawing,
  type SymbolDrawingInput,
} from '../lib/symbol-drawing';
import { readFootprintDrawing, type FootprintDrawingInput } from '../lib/footprint-drawing';

async function stableIds<T>(operation: () => T | Promise<T>): Promise<T> {
  let sequence = 0;
  const replacement = mock.method(
    crypto,
    'randomUUID',
    () =>
      `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}` as ReturnType<
        typeof crypto.randomUUID
      >,
  );
  try {
    return await operation();
  } finally {
    replacement.mock.restore();
  }
}

function symbolInput(): SymbolDrawingInput {
  return {
    name: 'Controller',
    referencePrefix: 'U',
    value: 'Controller',
    position: { x: 25.4, y: 25.4 },
    drawing: {
      graphics: [
        {
          type: 'rectangle',
          start: { x: -2.54, y: -2.54 },
          end: { x: 2.54, y: 2.54 },
          fill: 'background',
          width: 0.254,
        },
      ],
      pins: [
        {
          number: '1',
          name: 'IN',
          x: -5.08,
          y: 0,
          rotation: 0,
          length: 2.54,
          type: 'input',
          shape: 'line',
        },
        {
          number: '2',
          name: 'OUT',
          x: 5.08,
          y: 0,
          rotation: 180,
          length: 2.54,
          type: 'output',
          shape: 'line',
        },
      ],
    },
  };
}
function footprintInput(): FootprintDrawingInput {
  return {
    name: 'Controller',
    position: { x: 50, y: 50 },
    drawing: {
      pads: [
        { number: '1', x: -2, y: 0, rotation: 0, type: 'smd', shape: 'rect', size: { x: 2, y: 2 } },
        { number: '2', x: 2, y: 0, rotation: 0, type: 'smd', shape: 'rect', size: { x: 2, y: 2 } },
      ],
      graphics: [{ start: { x: -3, y: -2 }, end: { x: 3, y: -2 }, layer: 'F.SilkS', width: 0.15 }],
    },
  };
}
function fixture(linked = false) {
  const project = createProject(emptyCircuit());
  project.pcb = createEmptyPCB();
  if (linked) {
    project.schematic = prepareSymbolDrawing(project.schematic, symbolInput()).circuit;
    const part = project.schematic.parts[0];
    part.fields = { Manufacturer: 'Retained evidence' };
    const pins = pinPositions(part, project.schematic.libraries[part.libId]);
    project.schematic.labels = pins.map((point, i) => ({
      id: uid(),
      ...point,
      text: i === 0 ? 'INPUT' : 'OUTPUT',
    }));
    project.schematic.wires = pins.map((point, i) => ({
      id: uid(),
      a: point,
      b: { x: point.x + (i ? 5.08 : -5.08), y: point.y },
    }));
  }
  return project;
}
function coreFor(project: Project) {
  return new ProjectCore(project, {
    prepare: (next) => {
      if (!next.pcb) return next;
      const synchronized = updatePCBFromSchematic(next.schematic, next.pcb, new Map());
      return synchronized.board === next.pcb ? next : { ...next, pcb: synchronized.board };
    },
  });
}
function harness(project: Project) {
  const core = coreFor(project);
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const unregister = registerProjectCapabilities(host, core);
  return {
    core,
    host,
    dispose: () => {
      unregister();
      host.dispose();
    },
  };
}
async function assertGates(h: ReturnType<typeof harness>, id: string, input: unknown) {
  const baseline = h.core.getSnapshot(),
    files = h.core.getNativeFiles();
  await assert.rejects(
    h.host.execute(id, input, { actor: 'agent', expectedRevision: '-1' }),
    /changed/,
  );
  assert.equal(h.core.getSnapshot().revision, baseline.revision);
  assert.deepEqual(h.core.getNativeFiles(), files);
  h.core.updateSource(baseline.source + '\n');
  const pending = h.core.getSnapshot(),
    draft = pending.sourceDraft;
  await assert.rejects(h.host.execute(id, input, { actor: 'agent' }), /Source/);
  assert.equal(h.core.getSnapshot().sourceDraft, draft);
  assert.equal(h.core.getSnapshot().revision, pending.revision);
  assert.equal(h.core.getSnapshot().undoDepth, baseline.undoDepth);
  h.core.discardSource();
  h.core.setEditingBlocked('This project is closing.');
  await assert.rejects(h.host.execute(id, input, { actor: 'agent' }), /closing/);
  assert.deepEqual(h.core.getNativeFiles(), files);
  assert.equal(h.core.getSnapshot().undoDepth, baseline.undoDepth);
  h.core.setEditingBlocked(null);
}

test('drawing discovery exposes editable geometry and rejects native data/connectivity injection', (t) => {
  const h = harness(fixture());
  t.after(h.dispose);
  const symbol = h.host.catalog().find((entry) => entry.id === 'schematic.symbol.draw')!;
  const footprint = h.host.catalog().find((entry) => entry.id === 'layout.footprint.draw')!;
  const getter = h.host.catalog().find((entry) => entry.id === 'schematic.symbol.get')!;
  for (const command of [symbol, footprint]) {
    assert.equal(command.owner, 'core');
    assert.equal(command.level, 'object');
    assert.equal(command.mutation, 'document');
    assert.equal(command.available, true);
  }
  assert.equal(getter.kind, 'query');
  assert.equal(getter.mutation, false);
  const shape = symbol.inputSchema as any;
  assert.ok(
    shape.properties.drawing.properties.graphics.items.oneOf.some(
      (item: any) => item.properties.type.const === 'polyline',
    ),
  );
  assert.ok(
    shape.properties.drawing.properties.pins.items.properties.type.enum.includes('power_in'),
  );
  const checkSymbol = compileCapabilitySchema(symbol.inputSchema);
  const args = { schematicId: h.core.getSnapshot().project!.schematic.id, ...symbolInput() };
  assert.equal(checkSymbol(args).valid, true);
  assert.equal(checkSymbol({ ...args, raw: ['symbol'] }).valid, false);
  const checkFootprint = compileCapabilitySchema(footprint.inputSchema);
  const packageArgs = { boardId: h.core.getSnapshot().project!.pcb!.id, ...footprintInput() };
  assert.equal(checkFootprint(packageArgs).valid, true);
  const injected = structuredClone(packageArgs) as any;
  injected.drawing.pads[0].netId = uid();
  assert.equal(checkFootprint(injected).valid, false);
  injected.drawing.pads[0].locked = true;
  delete injected.drawing.pads[0].netId;
  assert.equal(checkFootprint(injected).valid, false);
});

test('GUI and Agent symbol drawing share native bytes, queries, undo and document gates', async (t) => {
  const project = fixture(),
    gui = harness(project),
    h = harness(project);
  t.after(h.dispose);
  t.after(gui.dispose);
  const baseline = h.core.getNativeFiles(),
    args = { schematicId: project.schematic.id, ...symbolInput() };
  await stableIds(() =>
    gui.host.execute('schematic.symbol.draw', args, { actor: 'human', expectedRevision: '0' }),
  );
  const result = (await stableIds(() =>
    h.host.execute('schematic.symbol.draw', args, { actor: 'agent', expectedRevision: '0' }),
  )) as any;
  assert.deepEqual(h.core.getNativeFiles(), gui.core.getNativeFiles());
  assert.equal(h.core.getSnapshot().undoDepth, 1);
  assert.equal(gui.core.getSnapshot().undoDepth, 1);
  const partId = result.selection[0];
  assert.deepEqual(
    await h.host.query(
      'schematic.symbol.get',
      { schematicId: project.schematic.id, partId },
      { actor: 'agent' },
    ),
    { schematicId: project.schematic.id, partId, ...symbolInput() },
  );
  const reopened = projectFromNativeFiles(h.core.getNativeFiles());
  assert.deepEqual(readSymbolDrawing(reopened.schematic, partId), symbolInput());
  const accepted = h.core.getNativeFiles();
  await h.host.execute('history.undo', {}, { actor: 'human' });
  assert.deepEqual(h.core.getNativeFiles(), baseline);
  await h.host.execute('history.redo', {}, { actor: 'agent' });
  assert.deepEqual(h.core.getNativeFiles(), accepted);
  await assertGates(h, 'schematic.symbol.draw', args);
});

test('GUI and Agent standalone footprint drawing share native geometry and one undo edit', async (t) => {
  const project = fixture(),
    gui = harness(project),
    h = harness(project);
  t.after(h.dispose);
  t.after(gui.dispose);
  const baseline = h.core.getNativeFiles(),
    args = { boardId: project.pcb!.id, ...footprintInput() };
  await stableIds(() =>
    gui.host.execute('layout.footprint.draw', args, { actor: 'human', expectedRevision: '0' }),
  );
  const result = (await stableIds(() =>
    h.host.execute('layout.footprint.draw', args, { actor: 'agent', expectedRevision: '0' }),
  )) as any;
  assert.deepEqual(h.core.getNativeFiles(), gui.core.getNativeFiles());
  assert.equal(h.core.getSnapshot().undoDepth, 1);
  assert.equal(gui.core.getSnapshot().undoDepth, 1);
  const reopened = projectFromNativeFiles(h.core.getNativeFiles());
  assert.equal(reopened.pcb!.footprints[0].id, result.footprintId);
  assert.equal(reopened.pcb!.footprints[0].symbolId, null);
  assert.equal(reopened.pcb!.footprints[0].pads.length, 2);
  assert.ok(
    reopened.pcb!.footprints[0].graphics.some(
      (graphic) =>
        graphic.id === h.core.getSnapshot().project!.pcb!.footprints[0].graphics[0].id &&
        graphic.kind === undefined,
    ),
  );
  await h.host.execute('history.undo', {}, { actor: 'agent' });
  assert.deepEqual(h.core.getNativeFiles(), baseline);
  await assertGates(h, 'layout.footprint.draw', args);
});

test('linked drawing assigns package and pin nets in the same native undo; artwork edits retain them', async (t) => {
  const project = fixture(true),
    gui = harness(project),
    h = harness(project);
  t.after(h.dispose);
  t.after(gui.dispose);
  const partId = project.schematic.parts[0].id;
  const drawingArgs = { ...footprintInput(), partId };
  const args = { boardId: project.pcb!.id, ...drawingArgs };
  const baseline = h.core.getNativeFiles();
  await stableIds(() =>
    gui.host.execute('layout.footprint.draw', args, { actor: 'human', expectedRevision: '0' }),
  );
  const result = (await stableIds(() =>
    h.host.execute('layout.footprint.draw', args, { actor: 'agent', expectedRevision: '0' }),
  )) as any;
  assert.deepEqual(h.core.getNativeFiles(), gui.core.getNativeFiles());
  const accepted = h.core.getSnapshot().project!,
    footprint = accepted.pcb!.footprints[0];
  assert.equal(footprint.symbolId, partId);
  assert.equal(footprint.id, result.footprintId);
  assert.equal(partFields(accepted.schematic.parts[0]).Footprint, 'OpenPE:Controller');
  assert.equal(partFields(accepted.schematic.parts[0]).Manufacturer, 'Retained evidence');
  assert.deepEqual(
    footprint.pads.map((pad) => accepted.pcb!.nets.find((net) => net.id === pad.netId)!.name),
    ['INPUT', 'OUTPUT'],
  );
  assert.equal(h.core.getSnapshot().undoDepth, 1);
  const native = h.core.getNativeFiles();
  const reopened = projectFromNativeFiles(native);
  assert.equal(partFields(reopened.schematic.parts[0]).Footprint, 'OpenPE:Controller');
  assert.deepEqual(
    reopened.pcb!.footprints[0].pads.map(
      (pad) => reopened.pcb!.nets.find((net) => net.id === pad.netId)!.name,
    ),
    ['INPUT', 'OUTPUT'],
  );
  const edit = readFootprintDrawing(footprint);
  edit.graphics[0].end.x += 1;
  const editArgs = {
    boardId: accepted.pcb!.id,
    footprintId: footprint.id,
    name: 'Controller',
    drawing: edit,
  };
  await stableIds(() =>
    gui.host.execute('layout.footprint.draw', editArgs, {
      actor: 'human',
      expectedRevision: String(gui.core.getSnapshot().revision),
    }),
  );
  await stableIds(() =>
    h.host.execute('layout.footprint.draw', editArgs, {
      actor: 'agent',
      expectedRevision: String(h.core.getSnapshot().revision),
    }),
  );
  assert.deepEqual(h.core.getNativeFiles(), gui.core.getNativeFiles());
  assert.deepEqual(h.core.getSnapshot().project!.pcb!.footprints[0].pads, footprint.pads);
  assert.equal(h.core.getSnapshot().undoDepth, 2);
  await h.host.execute('history.undo');
  assert.deepEqual(h.core.getNativeFiles(), native);
  await h.host.execute('history.undo');
  assert.deepEqual(h.core.getNativeFiles(), baseline);
  await assertGates(h, 'layout.footprint.draw', args);
});
