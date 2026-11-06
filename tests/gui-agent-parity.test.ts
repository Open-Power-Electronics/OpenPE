import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { compileCapabilitySchema } from '../api/capability-schema';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { createPart, pinPositions, uid } from '../lib/circuit';
import { createProject, parseProject, serializeProject, type Project } from '../lib/project';
import {
  createEmptyPCB,
  createPCBFootprint,
  flipPCBFootprint,
  flipPCBSelection,
  movePCBSelection,
  rotatePCBSelection,
  setPCBTrackProperties,
  type PCBSelection,
} from '../lib/pcb-layout';
import {
  preparePCBFootprintProperties,
  preparePCBZoneProperties,
  setPCBPadProperties,
  setPCBTrackEndpoints,
} from '../lib/pcb-properties';
import {
  fieldId,
  moveText,
  placeNoConnect,
  pasteSchematicSelection,
  saveAnnotation,
  saveLabel,
  simplifyWires,
} from '../lib/schematic-edit';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { displayName } from '../lib/display-name';
import { preparePartGeometry } from '../lib/part-properties';
import type { PCB } from '../lib/pcb';
import {
  findPCBRectangle,
  resizePCBRectangle,
  setPCBRectangleWidth,
} from '../lib/pcb-outline-resize';
import { setPCBLocked } from '../lib/pcb-lock';
import { registerLibraryCapabilities } from '../lib/library-capabilities';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import { previewSchematicMove, type SchematicMoveOperation } from '../lib/schematic-move';
import { projectNetGroups } from '../lib/project-net-groups';
import { schematicTexts } from '../lib/schematic-text';

/** Equivalent gestures receive the same fresh UUID stream without changing production uid. */
async function withStableIds<T>(operation: () => T | Promise<T>): Promise<T> {
  let sequence = 0;
  const replacement = mock.method(
    crypto,
    'randomUUID',
    () =>
      `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}` as ReturnType<
        typeof crypto.randomUUID
      >,
  );
  try {
    return await operation();
  } finally {
    replacement.mock.restore();
  }
}

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
  makeProject: () => Project = fixture,
) {
  const project = makeProject();
  const gui = new ProjectCore(project),
    agent = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(agent.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, agent);
  const baseline = agent.getNativeFiles();
  const before = agent.getSnapshot();
  const args = input(before.project!);
  assert.equal(host.catalog().find((entry) => entry.id === id)?.available, true);
  const humanId = await withStableIds(() => human(gui, gui.getSnapshot().project!));
  const result = await withStableIds(() =>
    host.execute(id, args, {
      actor: 'agent',
      expectedRevision: String(before.revision),
    }),
  );
  const accepted = agent.getSnapshot().project!;
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
  return accepted;
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

test('Agent connected pickup rotates, mirrors and moves the canvas pose with native-file and single-undo parity', async () => {
  const topology = (project: Project) =>
    projectNetGroups(project.schematic)
      .map((group) => [...group.pins].sort())
      .filter((pins) => pins.length)
      .sort();
  for (const operations of [
    ['rotate'],
    ['rotateReverse'],
    ['mirrorX'],
    ['rotate', 'mirrorY'],
  ] as SchematicMoveOperation[][]) {
    let original: Project;
    const accepted = await parity(
      'schematic.pose',
      (project) => ({
        schematicId: project.schematic.id,
        ids: [project.schematic.parts[0].id],
        anchor: { x: 25.4, y: 25.4 },
        target: { x: 30.48, y: 27.94 },
        operations,
        connected: true,
      }),
      (core, project) => {
        original = project;
        core.replaceSchematic(
          previewSchematicMove(
            project.schematic,
            [project.schematic.parts[0].id],
            { x: 25.4, y: 25.4 },
            { x: 30.48, y: 27.94 },
            operations,
            true,
          ),
        );
      },
      undefined,
      () => {
        const project = createProject(),
          sheet = project.schematic;
        sheet.parts.push(createPart(sheet, 'R', 25.4, 25.4), createPart(sheet, 'C', 76.2, 25.4));
        for (const part of sheet.parts) part.rotation = 180;
        const [a, b] = sheet.parts.map(
          (part) => pinPositions(part, sheet.libraries[part.libId])[0],
        );
        sheet.wires = [
          { id: uid(), a: { x: a.x, y: a.y }, b: { x: a.x, y: 40.64 } },
          { id: uid(), a: { x: a.x, y: 40.64 }, b: { x: b.x, y: 40.64 } },
          { id: uid(), a: { x: b.x, y: 40.64 }, b: { x: b.x, y: b.y } },
          { id: uid(), a: { x: 63.5, y: 35.56 }, b: { x: 63.5, y: 55.88 } },
        ];
        sheet.labels = [{ id: uid(), text: 'SIGNAL', x: a.x, y: a.y }];
        const otherPin = pinPositions(sheet.parts[0], sheet.libraries[sheet.parts[0].libId])[1];
        sheet.noConnects = [{ id: uid(), x: otherPin.x, y: otherPin.y }];
        return project;
      },
    );
    assert.deepEqual(topology(accepted), topology(original!));
    assert.deepEqual(accepted.schematic.parts[1], original!.schematic.parts[1]);
    assert.deepEqual(
      accepted.schematic.wires.find((wire) => wire.id === original!.schematic.wires[3].id),
      original!.schematic.wires[3],
    );
    const moved = accepted.schematic.parts[0],
      pins = pinPositions(moved, accepted.schematic.libraries[moved.libId]);
    assert.equal(moved.x, 30.48);
    assert.equal(moved.y, 27.94);
    assert.deepEqual(
      { x: accepted.schematic.labels[0].x, y: accepted.schematic.labels[0].y },
      { x: pins[0].x, y: pins[0].y },
    );
    assert.deepEqual(
      { x: accepted.schematic.noConnects![0].x, y: accepted.schematic.noConnects![0].y },
      { x: pins[1].x, y: pins[1].y },
    );
  }
});

test('Agent floating Move applies a compound pose while leaving unselected wires untouched', async () => {
  let wires: Project['schematic']['wires'];
  const accepted = await parity(
    'schematic.pose',
    (project) => ({
      schematicId: project.schematic.id,
      ids: [project.schematic.parts[0].id],
      anchor: { x: 10.16, y: 10.16 },
      target: { x: 15.24, y: 12.7 },
      operations: ['mirrorY', 'rotate'],
      connected: false,
    }),
    (core, project) => {
      wires = project.schematic.wires;
      core.replaceSchematic(
        previewSchematicMove(
          project.schematic,
          [project.schematic.parts[0].id],
          { x: 10.16, y: 10.16 },
          { x: 15.24, y: 12.7 },
          ['mirrorY', 'rotate'],
          false,
        ),
      );
    },
  );
  assert.deepEqual(accepted.schematic.wires, wires!);
});

test('Agent Layout pickup matches canvas ordered group rotation, anchored flip and final move in one undo', async () => {
  const anchor = { x: 20, y: 10 },
    target = { x: 35, y: 27 };
  const selected = (board: PCB): PCBSelection[] => [
    { kind: 'footprint', id: board.footprints[0].id },
    { kind: 'track', id: board.tracks[0].id },
    { kind: 'via', id: board.vias[0].id },
    { kind: 'graphic', id: board.graphics[0].id },
  ];
  const accepted = await parity(
    'layout.pose',
    (project) => ({
      boardId: project.pcb!.id,
      selection: selected(project.pcb!),
      anchor,
      target,
      operations: ['rotate', 'flip', 'rotateReverse'],
    }),
    (core, project) => {
      const board = project.pcb!,
        selection = selected(board);
      let preview = rotatePCBSelection(board, selection, 90, anchor);
      preview = flipPCBSelection(preview, selection, anchor);
      preview = rotatePCBSelection(preview, selection, -90, anchor);
      core.replaceBoard(
        movePCBSelection(preview, selection, { x: target.x - anchor.x, y: target.y - anchor.y }),
      );
    },
  );
  const board = accepted.pcb!,
    footprint = board.footprints[0];
  assert.deepEqual(
    { x: footprint.x, y: footprint.y, side: footprint.side, rotation: footprint.rotation },
    { x: 45, y: 27, side: 'back', rotation: 180 },
  );
  assert.deepEqual(board.tracks[0].start, { x: 35, y: 37 });
  assert.deepEqual(board.tracks[0].end, { x: 40, y: 37 });
  assert.deepEqual({ x: board.vias[0].x, y: board.vias[0].y }, { x: 40, y: 37 });
});

test('Agent zone override reset restores thermal relief, retains the net and refreshes saved copper like Properties', async () => {
  const accepted = await parity(
    'layout.zone',
    (project) => ({
      boardId: project.pcb!.id,
      zoneId: project.pcb!.zones[0].id,
      padConnection: null,
    }),
    (core, project) => {
      const board = project.pcb!;
      core.replaceBoard({
        ...board,
        zones: [preparePCBZoneProperties(board.zones[0], { padConnection: undefined })],
      });
    },
    undefined,
    () => {
      const project = fixture(),
        board = project.pcb!;
      board.zones[0].padConnection = 'yes';
      board.footprints[0].pads[0].netId = board.nets[0].id;
      return project;
    },
  );
  assert.equal(Object.hasOwn(accepted.pcb!.zones[0], 'padConnection'), false);
  assert.equal(accepted.pcb!.zones[0].netId, accepted.pcb!.nets[0].id);
  assert.ok(accepted.pcb!.zones[0].filledPolygons!.length > 0);
});

test('Agent rectangle line width changes all four native edges with Properties parity and one undo', async () => {
  const accepted = await parity(
    'layout.rectangle.properties',
    (project) => ({
      boardId: project.pcb!.id,
      selection: project
        .pcb!.graphics.filter((graphic) => graphic.layer === 'Edge.Cuts')
        .map((graphic) => ({ kind: 'graphic', id: graphic.id })),
      width: 0.2,
    }),
    (core, project) => {
      const board = project.pcb!,
        rectangle = findPCBRectangle(board, [{ kind: 'graphic', id: board.graphics[1].id }])!;
      core.replaceBoard(setPCBRectangleWidth(board, rectangle, 0.2));
    },
    undefined,
    () => {
      const project = fixture(),
        board = project.pcb!;
      const points = [
        { x: -5, y: -5 },
        { x: 35, y: -5 },
        { x: 35, y: 35 },
        { x: -5, y: 35 },
      ];
      board.graphics = [
        board.graphics[0],
        ...points.map((start, index) => ({
          id: uid(),
          layer: 'Edge.Cuts' as const,
          start,
          end: points[(index + 1) % 4],
          width: 0.05,
        })),
      ];
      return project;
    },
  );
  assert.deepEqual(
    accepted.pcb!.graphics.map((graphic) => graphic.width),
    [0.1, 0.2, 0.2, 0.2, 0.2],
  );
});

test('pickup, rectangle and zone capabilities discover exact inputs and reject invalid or locked edits atomically', async () => {
  const project = fixture(),
    board = project.pcb!;
  board.footprints[0].locked = true;
  board.graphics[1].locked = true;
  board.zones[0].locked = true;
  const core = new ProjectCore(project),
    host = createCapabilityHost();
  const dispose = registerProjectCapabilities(host, core),
    before = core.getSnapshot();
  const pose = {
    boardId: board.id,
    selection: [{ kind: 'footprint', id: board.footprints[0].id }],
    anchor: { x: 10, y: 10 },
    target: { x: 15, y: 12 },
    operations: ['rotate', 'flip'],
  };
  for (const [id, args, message] of [
    ['layout.pose', pose, /Unlock/],
    ['layout.pose', { ...pose, selection: [{ kind: 'via', id: uid() }] }, /no longer exists/],
    ['layout.pose', { ...pose, operations: ['mirrorX'] }, /operations/],
    [
      'layout.rectangle.properties',
      { boardId: board.id, selection: [{ kind: 'graphic', id: board.graphics[1].id }], width: 0.2 },
      /Unlock/,
    ],
    [
      'layout.rectangle.properties',
      { boardId: board.id, selection: [{ kind: 'graphic', id: board.graphics[0].id }], width: 0.2 },
      /rectangular/,
    ],
    [
      'layout.rectangle.properties',
      { boardId: board.id, selection: [{ kind: 'graphic', id: board.graphics[1].id }], width: 0 },
      /width/,
    ],
    [
      'layout.zone',
      { boardId: board.id, zoneId: board.zones[0].id, padConnection: 'yes' },
      /Unlock/,
    ],
    [
      'layout.zone',
      { boardId: board.id, zoneId: board.zones[0].id, thermalGap: null },
      /thermalGap/,
    ],
    [
      'schematic.pose',
      {
        schematicId: project.schematic.id,
        ids: [project.schematic.parts[0].id],
        anchor: { x: 0, y: 0 },
        target: { x: 0, y: 0 },
        operations: ['flip'],
        connected: true,
      },
      /operations/,
    ],
  ] as [string, object, RegExp][]) {
    await assert.rejects(host.execute(id, args, { actor: 'agent' }), message);
    assert.equal(core.getSnapshot(), before);
  }
  const definition = host.catalog().find((entry) => entry.id === 'layout.zone')!;
  const validate = compileCapabilitySchema(definition.inputSchema);
  assert.equal(
    validate({
      boardId: board.id,
      zoneId: board.zones[0].id,
      netId: null,
      padConnection: null,
      holes: null,
      keepout: null,
    }).valid,
    true,
  );
  assert.equal(
    validate({ boardId: board.id, zoneId: board.zones[0].id, outline: null }).valid,
    false,
  );
  dispose();
  host.dispose();
});

test('zone optional resets keep explicit unassigned netId null in the accepted native document', async () => {
  const accepted = await parity(
    'layout.zone',
    (project) => ({
      boardId: project.pcb!.id,
      zoneId: project.pcb!.zones[0].id,
      netId: null,
      padConnection: null,
      priority: null,
      islandRemovalMode: null,
      holes: null,
    }),
    (core, project) => {
      const board = project.pcb!;
      core.replaceBoard({
        ...board,
        zones: [
          preparePCBZoneProperties(board.zones[0], {
            netId: null,
            padConnection: undefined,
            priority: undefined,
            islandRemovalMode: undefined,
            holes: undefined,
          }),
        ],
      });
    },
    undefined,
    () => {
      const project = fixture(),
        zone = project.pcb!.zones[0];
      Object.assign(zone, {
        padConnection: 'no',
        priority: 2,
        islandRemovalMode: 1,
        holes: [
          [
            { x: 3, y: 3 },
            { x: 4, y: 3 },
            { x: 4, y: 4 },
            { x: 3, y: 4 },
          ],
        ],
      });
      delete zone.filledPolygons;
      return project;
    },
  );
  assert.equal(accepted.pcb!.zones[0].netId, null);
  for (const field of ['padConnection', 'priority', 'islandRemovalMode', 'holes'])
    assert.equal(Object.hasOwn(accepted.pcb!.zones[0], field), false);
});

test('unchanged complete poses and cleared absent zone overrides create no native change or undo', async () => {
  const core = new ProjectCore(fixture()),
    host = createCapabilityHost();
  const dispose = registerProjectCapabilities(host, core),
    before = core.getSnapshot();
  const project = before.project!,
    board = project.pcb!,
    position = { x: 10.16, y: 10.16 };
  const native = core.getNativeFiles();
  for (const [id, args] of [
    [
      'schematic.pose',
      {
        schematicId: project.schematic.id,
        ids: [project.schematic.parts[0].id],
        anchor: position,
        target: position,
        operations: [],
        connected: true,
      },
    ],
    [
      'layout.pose',
      {
        boardId: board.id,
        selection: [{ kind: 'footprint', id: board.footprints[0].id }],
        anchor: position,
        target: position,
        operations: [],
      },
    ],
    ['layout.zone', { boardId: board.id, zoneId: board.zones[0].id, padConnection: null }],
  ] as [string, object][]) {
    await host.execute(id, args, { actor: 'agent' });
    assert.equal(core.getSnapshot(), before);
    assert.deepEqual(core.getNativeFiles(), native);
  }
  dispose();
  host.dispose();
});

test('Agent paste retains copied old values, deleted objects and native annotations without replacing current objects', async () => {
  const copied = fixture(),
    sheet = copied.schematic;
  sheet.parts[0].value = '10k';
  sheet.parts.push(createPart(sheet, 'C', 20.32, 10.16));
  const annotation = saveAnnotation(sheet, 'Copied annotation', { x: 30.48, y: 30.48 });
  copied.schematic = annotation.circuit;
  const note = children(copied.schematic.original!, 'text').find(
    (node) => val(child(node, 'uuid')) === annotation.id,
  )!;
  child(child(note, 'effects')!, 'font')!.push('bold', ['color', '0.1', '0.2', '0.3', '1']);
  child(note, 'effects')!.push(['href', '"https://example.com/datasheet"']);
  note.push(['exclude_from_sim', 'yes']);
  const ids = [
    ...copied.schematic.parts.map((part) => part.id),
    sheet.wires[0].id,
    sheet.labels[0].id,
    annotation.id,
  ];
  const source = serializeProject(copied),
    current = parseProject(source);
  current.schematic.parts[0].value = '22k';
  current.schematic.parts.pop();
  current.schematic = saveAnnotation(
    current.schematic,
    'Live annotation',
    { x: 30.48, y: 30.48 },
    annotation.id,
  ).circuit;
  const gui = new ProjectCore(current),
    agent = new ProjectCore(current);
  const host = createCapabilityHost({ revision: () => String(agent.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, agent),
    before = agent.getSnapshot();
  const baseline = agent.getNativeFiles(),
    delta = { x: 10.16, y: 10.16 };
  const expected = await withStableIds(() => {
    const expected = pasteSchematicSelection(
      gui.getSnapshot().project!.schematic,
      copied.schematic,
      ids,
      delta,
    );
    gui.replaceSchematic(expected.circuit);
    return expected;
  });
  const input = { schematicId: current.schematic.id, source, ids, delta };
  const result = (await withStableIds(() =>
    host.execute('schematic.paste', input, {
      actor: 'agent',
      expectedRevision: String(before.revision),
    }),
  )) as { selection: string[] };
  assert.equal(result.selection.length, ids.length);
  assert.equal(new Set(result.selection).size, ids.length);
  assert.ok(result.selection.every((id) => !ids.includes(id)));
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const retained = new Set(JSON.stringify({ copied, current, baseline }).match(uuid));
  // Parsing a transport snapshot may allocate temporary UUIDs before copying.
  // Build one bijection for each result's selection, canonical data and native
  // files together; retained UUIDs cannot be normalized or substituted.
  const normalizedCopy = (selection: string[], core: ProjectCore) => {
    const fresh = new Map<string, string>();
    const source = JSON.stringify({
      selection,
      project: core.query('project.get'),
      files: core.getNativeFiles(),
    });
    const normalized = source.replace(uuid, (id) => {
      if (retained.has(id)) return id;
      if (!fresh.has(id)) fresh.set(id, `new-uuid-${fresh.size}`);
      return fresh.get(id)!;
    });
    return { normalized, count: fresh.size };
  };
  assert.deepEqual(
    normalizedCopy(result.selection, agent),
    normalizedCopy(expected.selection, gui),
  );
  const accepted = agent.getSnapshot().project!;
  assert.equal(
    accepted.schematic.parts.find((part) => part.id === sheet.parts[0].id)!.value,
    '22k',
  );
  assert.deepEqual(
    accepted.schematic.parts
      .filter((part) => result.selection.includes(part.id))
      .map((part) => [part.ref, part.value]),
    [
      ['R2', '10k'],
      ['C2', sheet.parts[1].value],
    ],
  );
  assert.deepEqual(
    schematicTexts(accepted.schematic.original).map((text) => text.text),
    ['Retained note', 'Live annotation', 'Copied annotation'],
  );
  assert.deepEqual(
    schematicTexts(projectFromNativeFiles(agent.getNativeFiles()).schematic.original).map(
      (text) => text.text,
    ),
    ['Retained note', 'Live annotation', 'Copied annotation'],
  );
  const copiedText = schematicTexts(accepted.schematic.original).find(
    (text) => text.text === 'Copied annotation',
  )!;
  assert.equal(copiedText.bold, true);
  assert.deepEqual(copiedText.color, [0.1, 0.2, 0.3, 1]);
  assert.equal(copiedText.href, 'https://example.com/datasheet');
  const acceptedNote = children(accepted.schematic.original!, 'text').find(
    (node) => val(child(node, 'uuid')) === copiedText.id,
  )!;
  assert.equal(val(child(acceptedNote, 'exclude_from_sim')), 'yes');
  assert.equal(agent.getSnapshot().undoDepth, 1);
  assert.equal(gui.getSnapshot().undoDepth, 1);
  agent.undo();
  assert.deepEqual(agent.getNativeFiles(), baseline);
  await assert.rejects(
    host.execute('schematic.paste', input, { actor: 'agent', expectedRevision: '-1' }),
    /changed/,
  );
  agent.updateSource(agent.getSnapshot().source + '\n');
  await assert.rejects(host.execute('schematic.paste', input, { actor: 'agent' }), /Source/);
  agent.discardSource();
  agent.setEditingBlocked('This project is closing.');
  await assert.rejects(host.execute('schematic.paste', input, { actor: 'agent' }), /closing/);
  dispose();
  host.dispose();
});

test('Agent and GUI paste reject foreign sheets or changed embedded symbols without an edit', async () => {
  const project = fixture(),
    snapshot = structuredClone(project),
    core = new ProjectCore(project);
  const host = createCapabilityHost(),
    dispose = registerProjectCapabilities(host, core);
  const before = core.getSnapshot(),
    ids = [project.schematic.parts[0].id];
  const input = { schematicId: project.schematic.id, ids, delta: { x: 10.16, y: 10.16 } };
  const different = createProject();
  assert.throws(
    () => pasteSchematicSelection(project.schematic, different.schematic, ids),
    /this document/,
  );
  await assert.rejects(
    host.execute('schematic.paste', { ...input, source: serializeProject(different) }),
    /this document/,
  );
  const library = snapshot.schematic.libraries[snapshot.schematic.parts[0].libId];
  library.push([
    'property',
    '"Snapshot note"',
    '"Changed"',
    ['at', '0', '0', '0'],
    ['effects', ['font', ['size', '1.27', '1.27']], ['hide', 'yes']],
  ]);
  assert.throws(
    () => pasteSchematicSelection(project.schematic, snapshot.schematic, ids),
    /embedded symbol changed/,
  );
  await assert.rejects(
    host.execute('schematic.paste', { ...input, source: serializeProject(snapshot) }),
    /embedded symbol changed/,
  );
  await assert.rejects(host.execute('schematic.paste', { ...input, source: '{}' }));
  assert.equal(core.getSnapshot(), before);
  dispose();
  host.dispose();
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
