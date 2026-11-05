import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { compileCapabilitySchema } from '../api/capability-schema';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { createPart, pinPositions, uid } from '../lib/circuit';
import { createProject, type Project } from '../lib/project';
import {
  createEmptyPCB,
  createPCBFootprint,
  flipPCBFootprint,
  setPCBTrackProperties,
} from '../lib/pcb-layout';
import {
  preparePCBFootprintProperties,
  setPCBPadProperties,
  setPCBTrackEndpoints,
} from '../lib/pcb-properties';
import {
  fieldId,
  moveText,
  placeNoConnect,
  saveAnnotation,
  saveLabel,
  simplifyWires,
} from '../lib/schematic-edit';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { displayName } from '../lib/display-name';
import { preparePartGeometry } from '../lib/part-properties';
import type { PCB } from '../lib/pcb';
import { findPCBRectangle, resizePCBRectangle } from '../lib/pcb-outline-resize';
import { setPCBLocked } from '../lib/pcb-lock';
import { registerLibraryCapabilities } from '../lib/library-capabilities';
import { parseSExpr } from '../lib/sexpr';

function fixture() {
  const project = createProject();
  const sheet = project.schematic;
  const part = createPart(sheet, 'R', 10.16, 10.16);
  sheet.parts.push(part);
  sheet.labels.push({ id: uid(), text: 'OUT', x: 0, y: 0, scope: 'global', shape: 'input' });
  sheet.wires = [
    { id: uid(), a: { x: 0, y: 0 }, b: { x: 2.54, y: 0 } },
    { id: uid(), a: { x: 2.54, y: 0 }, b: { x: 5.08, y: 0 } },
  ];
  project.schematic = saveAnnotation(sheet, 'Retained note', { x: 0, y: 5.08 }).circuit;
  const board = createEmptyPCB();
  const netId = uid();
  board.nets = [{ id: netId, name: 'OUT' }];
  board.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:Mechanical',
      reference: 'MH1',
      value: 'Mount',
      x: 10,
      y: 10,
      rotation: 0,
      side: 'front',
      graphics: [],
      pads: [
        {
          id: uid(),
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 2, y: 2 },
          netId: null,
          solderMaskMargin: 0.1,
        },
      ],
      models: [
        {
          path: '${KIPRJMOD}/models/part.step',
          offset: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      ],
    },
  ];
  board.tracks = [
    {
      id: uid(),
      netId,
      layer: 'F.Cu',
      width: 0.25,
      start: { x: 20, y: 20 },
      end: { x: 25, y: 20 },
    },
  ];
  board.vias = [{ id: uid(), netId, x: 25, y: 20, diameter: 1, drill: 0.4 }];
  board.zones = [
    {
      id: uid(),
      netId,
      layer: 'F.Cu',
      outline: [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 30 },
        { x: 0, y: 30 },
      ],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      filledPolygons: [
        {
          points: [
            { x: 1, y: 1 },
            { x: 29, y: 1 },
            { x: 29, y: 29 },
          ],
        },
      ],
    },
  ];
  board.graphics = [
    { id: uid(), layer: 'Dwgs.User', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 0.1 },
    {
      id: uid(),
      layer: 'Edge.Cuts',
      kind: 'polygon',
      start: { x: -5, y: -5 },
      points: [
        { x: 35, y: -5 },
        { x: 35, y: 35 },
      ],
      end: { x: -5, y: 35 },
      width: 0.05,
    },
  ];
  project.pcb = board;
  return project;
}

/** Compare native bytes, not only visible geometry or command metadata. */
async function parity(
  id: string,
  input: (project: Project) => Record<string, unknown>,
  human: (core: ProjectCore, project: Project) => string | void,
  createdId?: (result: any) => string,
) {
  const project = fixture();
  const gui = new ProjectCore(project),
    agent = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(agent.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, agent);
  const baseline = agent.getNativeFiles();
  const before = agent.getSnapshot();
  const args = input(before.project!);
  assert.equal(host.catalog().find((entry) => entry.id === id)?.available, true);
  const humanId = human(gui, gui.getSnapshot().project!);
  const result = await host.execute(id, args, {
    actor: 'agent',
    expectedRevision: String(before.revision),
  });
  const normalize = (value: unknown) => {
    const json = JSON.stringify(value);
    return humanId && createdId ? json.replaceAll(createdId(result), humanId) : json;
  };
  assert.equal(normalize(agent.query('project.get')), JSON.stringify(gui.query('project.get')));
  assert.equal(normalize(agent.getNativeFiles()), JSON.stringify(gui.getNativeFiles()));
  projectFromNativeFiles(agent.getNativeFiles());
  assert.equal(agent.getSnapshot().undoDepth, 1);
  assert.equal(gui.getSnapshot().undoDepth, 1);
  agent.undo();
  assert.deepEqual(agent.getNativeFiles(), baseline);
  // Every new design operation shares revision, Source and close barriers.
  await assert.rejects(
    host.execute(id, args, { actor: 'agent', expectedRevision: '-1' }),
    /changed/,
  );
  agent.updateSource(agent.getSnapshot().source + '\n');
  await assert.rejects(host.execute(id, args, { actor: 'agent' }), /Source/);
  agent.discardSource();
  agent.setEditingBlocked('This project is closing.');
  await assert.rejects(host.execute(id, args, { actor: 'agent' }), /closing/);
  dispose();
  host.dispose();
}

test('GUI and Agent object locks preserve the same native files and whole-project undo', async () => {
  await parity(
    'layout.lock',
    (project) => ({
      boardId: project.pcb!.id,
      targets: [
        { kind: 'footprint', id: project.pcb!.footprints[0].id },
        { kind: 'via', id: project.pcb!.vias[0].id },
        { kind: 'zone', id: project.pcb!.zones[0].id },
      ],
      locked: true,
    }),
    (core, project) => {
      core.replaceBoard(
        setPCBLocked(
          project.pcb!,
          [
            { kind: 'footprint', id: project.pcb!.footprints[0].id },
            { kind: 'via', id: project.pcb!.vias[0].id },
            { kind: 'zone', id: project.pcb!.zones[0].id },
          ],
          true,
        ),
      );
    },
  );
});

test('GUI and Agent project rename preserve the same native files and whole-project undo', async () => {
  await parity(
    'project.rename',
    () => ({ name: '  Converter  ' }),
    (core, project) => {
      core.commitProject({ ...project, name: displayName('  Converter  ') });
    },
  );
});

test('Model board thickness and Agent board Properties share native bytes, undo and edit barriers', async () => {
  await parity(
    'layout.properties',
    (project) => ({ boardId: project.pcb!.id, thickness: 2.4 }),
    (core, project) => {
      core.replaceBoard({ ...project.pcb!, thickness: 2.4 });
    },
  );
});

test('GUI and Agent numeric component Properties use the same grid, angular precision and normalization', async () => {
  await parity(
    'part.properties',
    (project) => ({
      schematicId: project.schematic.id,
      partId: project.schematic.parts[0].id,
      position: { x: 15.3, y: 12.6 },
      rotation: -37.123456,
    }),
    (core, project) => {
      const sheet = project.schematic;
      core.replaceSchematic({
        ...sheet,
        parts: sheet.parts.map((part) => ({
          ...part,
          x: preparePartGeometry('x', 15.3),
          y: preparePartGeometry('y', 12.6),
          rotation: preparePartGeometry('rotation', -37.123456),
        })),
      });
    },
  );
});

for (const scope of [undefined, 'global'] as const) {
  test(`GUI and Agent ${scope ?? 'local'} label placement share defaults, grid and fresh identities`, async () => {
    const position = { x: 15.3, y: 12.6 };
    await parity(
      'schematic.label',
      (project) => ({ schematicId: project.schematic.id, position, ...(scope ? { scope } : {}) }),
      (core, project) => {
        const result = saveLabel(project.schematic, { position, scope });
        core.replaceSchematic(result.circuit);
        return result.id;
      },
      (result) => result.selection[0],
    );
  });
}

test('GUI and Agent label Properties and text position preserve identity and metadata', async () => {
  await parity(
    'schematic.label',
    (project) => ({
      schematicId: project.schematic.id,
      id: project.schematic.labels[0].id,
      text: 'BUS_OUT',
      shape: 'bidirectional',
    }),
    (core, project) => {
      core.replaceSchematic(
        saveLabel(project.schematic, {
          id: project.schematic.labels[0].id,
          text: 'BUS_OUT',
          shape: 'bidirectional',
        }).circuit,
      );
    },
  );
  await parity(
    'schematic.text.position',
    (project) => ({
      schematicId: project.schematic.id,
      id: fieldId(project.schematic.parts[0].id, 'Reference'),
      position: { x: 25.6, y: 15.1 },
    }),
    (core, project) => {
      core.replaceSchematic(
        moveText(project.schematic, fieldId(project.schematic.parts[0].id, 'Reference'), {
          x: 25.6,
          y: 15.1,
        }),
      );
    },
  );
});

test('GUI and Agent no-connect placement and wire simplification use identical topology', async () => {
  await parity(
    'schematic.noConnect',
    (project) => ({
      schematicId: project.schematic.id,
      position: pinPositions(
        project.schematic.parts[0],
        project.schematic.libraries[project.schematic.parts[0].libId],
      )[0],
    }),
    (core, project) => {
      const sheet = project.schematic;
      const result = placeNoConnect(
        sheet,
        pinPositions(sheet.parts[0], sheet.libraries[sheet.parts[0].libId])[0],
      );
      core.replaceSchematic(result.circuit);
      return result.id;
    },
    (result) => result.selection[0],
  );
  await parity(
    'schematic.simplify',
    (project) => ({ schematicId: project.schematic.id }),
    (core, project) => {
      core.replaceSchematic(simplifyWires(project.schematic));
    },
  );
});

test('GUI and Agent pad edits normalize circle geometry, clear overrides and refresh fills once', async () => {
  await parity(
    'layout.pad.properties',
    (project) => ({
      boardId: project.pcb!.id,
      padId: project.pcb!.footprints[0].pads[0].id,
      changes: { shape: 'circle', size: { x: 3, y: 2 }, solderMaskMargin: null },
    }),
    (core, project) => {
      const board = project.pcb!;
      core.replaceBoard(
        setPCBPadProperties(board, board.footprints[0].pads[0].id, {
          shape: 'circle',
          size: { x: 3, y: 2 },
          solderMaskMargin: undefined,
        }),
      );
    },
  );
});

test('GUI and Agent exact track endpoints and existing via properties produce identical copper', async () => {
  const start = { x: 19.999999, y: 20 };
  await parity(
    'layout.track.properties',
    (project) => ({ boardId: project.pcb!.id, trackId: project.pcb!.tracks[0].id, start }),
    (core, project) => {
      core.replaceBoard(setPCBTrackEndpoints(project.pcb!, project.pcb!.tracks[0].id, { start }));
    },
  );
  await parity(
    'layout.via.properties',
    (project) => ({
      boardId: project.pcb!.id,
      viaId: project.pcb!.vias[0].id,
      changes: { x: 26, diameter: 1.2, drill: 0.5 },
    }),
    (core, project) => {
      const board = project.pcb!;
      core.replaceBoard({
        ...board,
        vias: board.vias.map((via) => ({ ...via, x: 26, diameter: 1.2, drill: 0.5 })),
      });
    },
  );
});

test('GUI and Agent footprint side and model transforms retain exact pads and paths', async () => {
  const models = [
    {
      path: '${KIPRJMOD}/models/part.step',
      offset: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 90, z: 30 },
      scale: { x: 1, y: 1, z: 1 },
      opacity: 0.5,
      hidden: false,
    },
  ];
  await parity(
    'layout.footprint.properties',
    (project) => ({
      boardId: project.pcb!.id,
      footprintId: project.pcb!.footprints[0].id,
      changes: { side: 'back', models },
    }),
    (core, project) => {
      const board = project.pcb!;
      core.replaceBoard({
        ...board,
        footprints: [{ ...flipPCBFootprint(board.footprints[0]), models }],
      });
    },
  );
  await parity(
    'layout.footprint.properties',
    (project) => ({
      boardId: project.pcb!.id,
      footprintId: project.pcb!.footprints[0].id,
      changes: { models: null },
    }),
    (core, project) => {
      const board = project.pcb!;
      const { models: _models, ...footprint } = board.footprints[0];
      core.replaceBoard({ ...board, footprints: [footprint] });
    },
  );
});

test('GUI and Agent board drawing creation and Properties retain UUIDs and native data', async () => {
  const graphic = {
    layer: 'Edge.Cuts' as const,
    kind: 'polygon' as const,
    start: { x: 0, y: 0 },
    points: [
      { x: 30, y: 0 },
      { x: 30, y: 30 },
    ],
    end: { x: 0, y: 30 },
    width: 0.1,
    fill: false,
  };
  await parity(
    'layout.graphic',
    (project) => ({ boardId: project.pcb!.id, graphic }),
    (core, project) => {
      const board = project.pcb!,
        id = uid();
      core.replaceBoard({ ...board, graphics: [...board.graphics, { ...graphic, id }] });
      return id;
    },
    (result) => result.graphicId,
  );
  await parity(
    'layout.graphic',
    (project) => ({
      boardId: project.pcb!.id,
      graphicId: project.pcb!.graphics[0].id,
      graphic: { ...graphic, layer: 'Dwgs.User' },
    }),
    (core, project) => {
      const board = project.pcb!;
      core.replaceBoard({
        ...board,
        graphics: board.graphics.map((item, index) =>
          index ? item : { ...graphic, layer: 'Dwgs.User', id: item.id },
        ),
      });
    },
  );
});

test('GUI and Agent boundary resizing retain zone identity and use the same bounds transform', async () => {
  const bounds = { minX: -5, minY: -5, maxX: 40, maxY: 50 };
  await parity(
    'layout.rectangle.resize',
    (project) => ({
      boardId: project.pcb!.id,
      selection: [{ kind: 'zone', id: project.pcb!.zones[0].id }],
      bounds,
    }),
    (core, project) => {
      const board = project.pcb!;
      const rectangle = findPCBRectangle(board, [{ kind: 'zone', id: board.zones[0].id }])!;
      core.replaceBoard(resizePCBRectangle(board, rectangle, bounds));
    },
  );
});

test('Agent footprint placement uses the Layout chooser preparation, rejects duplicates and stale library responses', async () => {
  const project = fixture();
  const core = new ProjectCore(project),
    gui = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const previousWindow = (globalThis as any).window,
    previousFetch = globalThis.fetch;
  const detail = {
    id: 'Test:TwoPin',
    footprint: parseSExpr(
      '(footprint "TwoPin" (layer "F.Cu") (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask")) (pad "2" thru_hole circle (at 2.54 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask")))',
    ),
  };
  let received: (() => void) | undefined, release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://127.0.0.1:1', token: 'fixture' }) },
  };
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/libraries\/footprints\?id=Test%3ATwoPin/);
    received?.();
    if (pending) await pending;
    return Response.json(detail);
  };
  const dispose = registerLibraryCapabilities(host, core);
  try {
    const snapshot = core.getSnapshot(),
      board = snapshot.project!.pcb!;
    const args = {
      boardId: board.id,
      partId: project.schematic.parts[0].id,
      libraryId: detail.id,
      position: { x: 30.123456, y: 15 },
      rotation: 90,
      side: 'back',
    };
    const humanBoard = gui.getSnapshot().project!.pcb!;
    const humanPart = createPCBFootprint(
      detail,
      gui.getSnapshot().project!.schematic,
      args.partId,
      args.position,
    );
    humanPart.rotation = 90;
    const footprint = flipPCBFootprint(humanPart);
    gui.replaceBoard({ ...humanBoard, footprints: [...humanBoard.footprints, footprint] });
    await host.execute('layout.place', args, {
      actor: 'agent',
      expectedRevision: String(snapshot.revision),
    });
    const placed = core.getSnapshot().project!.pcb!.footprints.at(-1)!;
    const identities = new Map<string, string>([
      [placed.id, footprint.id],
      ...placed.pads.map((pad, index) => [pad.id, footprint.pads[index].id] as [string, string]),
    ]);
    let native = JSON.stringify(core.getNativeFiles());
    for (const [agentId, humanId] of identities) native = native.replaceAll(agentId, humanId);
    assert.equal(native, JSON.stringify(gui.getNativeFiles()));
    assert.equal(core.getSnapshot().undoDepth, 1);
    const accepted = core.getSnapshot();
    await assert.rejects(host.execute('layout.place', args, { actor: 'agent' }), /already/);
    assert.equal(core.getSnapshot(), accepted);
    core.undo();
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loaded = new Promise<void>((resolve) => {
      received = resolve;
    });
    const request = host.execute('layout.place', args, { actor: 'agent' });
    await loaded;
    core.updateSource(core.getSnapshot().source + '\n');
    const draft = core.getSnapshot();
    release!();
    await assert.rejects(request, /changed/);
    assert.equal(core.getSnapshot(), draft);
  } finally {
    dispose();
    host.dispose();
    globalThis.fetch = previousFetch;
    (globalThis as any).window = previousWindow;
  }
});

test('property commands reject stale identities, immutable pad fields, invalid geometry and reserved fields atomically', async () => {
  const core = new ProjectCore(fixture());
  const host = createCapabilityHost();
  registerProjectCapabilities(host, core);
  const before = core.getSnapshot(),
    board = before.project!.pcb!;
  const cases: [string, object][] = [
    [
      'layout.pad.properties',
      { padId: board.footprints[0].pads[0].id, changes: { netId: board.nets[0].id } },
    ],
    ['layout.pad.properties', { padId: board.footprints[0].pads[0].id, changes: { x: null } }],
    ['layout.pad.properties', { padId: uid(), changes: { x: 3 } }],
    ['layout.pad.properties', { padId: board.footprints[0].pads[0].id, changes: { drill: 1 } }],
    ['layout.via.properties', { viaId: board.vias[0].id, changes: { diameter: 0.1, drill: 0.5 } }],
    ['layout.via.properties', { viaId: uid(), changes: { x: 3 } }],
    ['layout.footprint.properties', { footprintId: uid(), changes: { x: 3 } }],
    [
      'layout.graphic',
      {
        graphicId: uid(),
        graphic: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, layer: 'Dwgs.User', width: 0.1 },
      },
    ],
  ];
  for (const [id, args] of cases) {
    await assert.rejects(host.execute(id, { boardId: board.id, ...args }, { actor: 'agent' }));
    assert.equal(core.getSnapshot(), before);
  }
  await assert.rejects(
    host.execute('schematic.label', { schematicId: before.project!.schematic.id, text: ' ' }),
  );
  await assert.rejects(
    host.execute('schematic.noConnect', {
      schematicId: before.project!.schematic.id,
      position: { x: 999, y: 999 },
    }),
  );
  assert.equal(core.getSnapshot(), before);
  const read = (await host.query('layout.object', {
    boardId: board.id,
    kind: 'footprint',
    id: board.footprints[0].id,
  })) as PCB['footprints'][number];
  read.models![0].offset.z = 500;
  assert.equal(board.footprints[0].models![0].offset.z, 0);
  core.commitProject({
    ...before.project!,
    pcb: { ...board, tracks: [{ ...board.tracks[0], locked: true }] },
  });
  const locked = core.getSnapshot();
  await assert.rejects(
    host.execute('layout.track.properties', {
      boardId: board.id,
      trackId: board.tracks[0].id,
      start: { x: 19, y: 20 },
    }),
    /Unlock/,
  );
  assert.equal(core.getSnapshot(), locked);
  const unlocked = setPCBTrackProperties(locked.project!.pcb!, board.tracks[0].id, {
    locked: false,
  });
  const expected = setPCBTrackEndpoints(unlocked, board.tracks[0].id, { start: { x: 19, y: 20 } });
  await host.execute('layout.track.properties', {
    boardId: board.id,
    trackId: board.tracks[0].id,
    locked: false,
    start: { x: 19, y: 20 },
  });
  assert.deepEqual(core.getSnapshot().project!.pcb!.tracks, expected.tracks);
});

test('generated property precision is interpreted with the same bounded decimal tolerance as document validation', () => {
  const validate = compileCapabilitySchema({ type: 'number', multipleOf: 0.000001 });
  assert.equal(validate(19.999999).valid, true);
  assert.equal(validate(-0.000001).valid, true);
  assert.equal(validate(0.0000005).valid, false);
  assert.equal(validate(Number.MAX_VALUE).valid, false);
  for (const multipleOf of [0, -1, Infinity, '1'])
    assert.throws(() => compileCapabilitySchema({ type: 'number', multipleOf }), /multipleOf/);
});

test('shared model Properties preserve retained native paths through removal but reject new arbitrary paths', async () => {
  const project = fixture();
  const footprint = project.pcb!.footprints[0];
  const first = { ...footprint.models![0], path: 'C:/vendor/first.step' };
  const second = { ...footprint.models![0], path: 'C:/vendor/second.step' };
  footprint.models = [first, second];
  const core = new ProjectCore(project),
    gui = new ProjectCore(project);
  const host = createCapabilityHost();
  registerProjectCapabilities(host, core);
  const original = core.getSnapshot(),
    board = original.project!.pcb!;
  const args = {
    boardId: board.id,
    footprintId: footprint.id,
    changes: { models: [{ ...second, offset: { x: 0, y: 0, z: 2 } }] },
  };
  const guiBoard = gui.getSnapshot().project!.pcb!;
  gui.replaceBoard({
    ...guiBoard,
    footprints: [preparePCBFootprintProperties(guiBoard.footprints[0], args.changes)],
  });
  await host.execute('layout.footprint.properties', args, { actor: 'agent' });
  assert.deepEqual(core.getNativeFiles(), gui.getNativeFiles());
  const accepted = core.getSnapshot();
  for (const path of [
    'C:/outside/new.step',
    '${KIPRJMOD}/../outside.step',
    'https://example.com/model.step',
  ]) {
    await assert.rejects(
      host.execute('layout.footprint.properties', {
        ...args,
        changes: { models: [{ ...second, path }] },
      }),
      /project-relative/,
    );
    assert.equal(core.getSnapshot(), accepted);
  }
  await host.execute('layout.footprint.properties', args);
  assert.equal(core.getSnapshot(), accepted, 'Unchanged Properties create no undo step.');
  core.undo();
  assert.equal(core.getSnapshot().source, original.source);
});
