import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCircuit, uid } from '../lib/circuit';
import { ownProject, ownProjectData } from '../lib/immutable-project';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { MODEL_CAD_EXTENSION } from '../lib/model-cad';
import type { BoardLine } from '../lib/pcb';
import { invalidatePCBFill } from '../lib/pcb';
import { exampleProject } from '../lib/project-example';
import {
  parseProject,
  projectNativeFiles,
  serializeProject,
  validateProject,
  type Project,
} from '../lib/project';

function copperPose(project: Project, delta: number): Project {
  const board = project.pcb!;
  return ownProject(
    {
      ...project,
      pcb: {
        ...board,
        tracks: board.tracks.map((track, index) =>
          index ? track : { ...track, start: { ...track.start, x: track.start.x + delta } },
        ),
      },
    },
    project,
  );
}

function warmProject(): Project {
  const project = ownProject(exampleProject());
  validateProject(project);
  const moved = copperPose(project, 0.01);
  assert.equal(moved.schematic, project.schematic);
  assert.equal(moved.pcb!.footprints, project.pcb!.footprints);
  assert.equal(moved.pcb!.nets, project.pcb!.nets);
  assert.equal(moved.pcb!.layers, project.pcb!.layers);
  assert.notEqual(moved.pcb, project.pcb);
  validateProject(moved);
  return project;
}

function failure(run: () => void): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail('Expected project validation to reject this candidate.');
}

function sameFailure(project: Project, expected: RegExp): void {
  const reference = failure(() => validateProject(structuredClone(project)));
  assert.match(reference, expected);
  assert.equal(
    failure(() => validateProject(project)),
    reference,
  );
}

test('warm owned footprint identities are rechecked against sheets, CAD, boards and tracks in original order', () => {
  const project = warmProject();
  const footprint = project.pcb!.footprints[0];
  const extra = emptyCircuit();
  delete extra.original;
  extra.id = footprint.id.toUpperCase();
  const cases: Project[] = [
    ownProject({ ...copperPose(project, 0.02), additionalSchematics: [extra] }, project),
    ownProject(
      {
        ...copperPose(project, 0.03),
        extensions: {
          ...project.extensions,
          [MODEL_CAD_EXTENSION]: {
            version: 1,
            objects: [
              {
                id: footprint.id,
                name: 'Collision fixture',
                kind: 'box',
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                size: { x: 10, y: 10, z: 10 },
                material: 'plastic',
                opacity: 1,
              },
            ],
          },
        },
      },
      project,
    ),
    ownProject(
      { ...project, pcb: { ...copperPose(project, 0.04).pcb!, id: footprint.id } },
      project,
    ),
    ownProject(
      {
        ...project,
        pcb: {
          ...copperPose(project, 0.05).pcb!,
          tracks: project.pcb!.tracks.map((track, index) =>
            index ? track : { ...track, id: footprint.pads[0].id },
          ),
        },
      },
      project,
    ),
  ];
  for (const candidate of cases) {
    assert.equal(candidate.pcb!.footprints, project.pcb!.footprints);
    assert.equal(candidate.pcb!.nets, project.pcb!.nets);
    assert.equal(candidate.pcb!.layers, project.pcb!.layers);
    sameFailure(candidate, /duplicate UUID/);
  }
  validateProject(copperPose(project, 0.06));
});

test('changed schematic, net and footprint contexts cannot retain stale local semantics', () => {
  const project = warmProject();
  const board = project.pcb!;
  const footprint = board.footprints[0];
  const schematic = ownProject(
    {
      ...copperPose(project, 0.02),
      schematic: {
        ...project.schematic,
        parts: project.schematic.parts.filter((part) => part.id !== footprint.symbolId),
      },
    },
    project,
  );
  assert.equal(schematic.pcb!.footprints, board.footprints);
  assert.notEqual(schematic.schematic, project.schematic);
  sameFailure(schematic, /missing schematic symbol/);

  const net = ownProject(
    {
      ...project,
      pcb: {
        ...copperPose(project, 0.03).pcb!,
        nets: board.nets.filter((net) => net.id !== footprint.pads[0].netId),
      },
    },
    project,
  );
  assert.equal(net.pcb!.footprints, board.footprints);
  assert.notEqual(net.pcb!.nets, board.nets);
  sameFailure(net, /missing PCB net/);

  const changedFootprint = ownProject(
    {
      ...project,
      pcb: {
        ...board,
        footprints: board.footprints.map((item, index) =>
          index
            ? item
            : {
                ...item,
                pads: item.pads.map((pad, index) =>
                  index ? pad : { ...pad, size: { ...pad.size, x: pad.size.x + 0.1 } },
                ),
              },
        ),
        // The earlier footprint error must still precede this later UUID error.
        tracks: board.tracks.map((track, index) =>
          index ? track : { ...track, id: footprint.id },
        ),
      },
    },
    project,
  );
  assert.notEqual(changedFootprint.pcb!.footprints, board.footprints);
  sameFailure(changedFootprint, /circular pads need equal/);
  validateProject(copperPose(project, 0.04));
});

test('a legal four-to-two copper stack change rechecks unchanged footprint artwork', () => {
  const project = warmProject();
  const four = ownProject(
    {
      ...project,
      pcb: {
        ...copperPose(project, 0.02).pcb!,
        layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'],
        footprints: project.pcb!.footprints.map((footprint, index) =>
          index
            ? footprint
            : {
                ...footprint,
                graphics: footprint.graphics.map((graphic, index): BoardLine =>
                  index ? graphic : { ...graphic, layer: 'In1.Cu' },
                ),
              },
        ),
      },
    },
    project,
  );
  validateProject(four);
  const two = ownProject(
    { ...four, pcb: { ...copperPose(four, 0.03).pcb!, layers: ['F.Cu', 'B.Cu'] } },
    four,
  );
  assert.equal(two.pcb!.footprints, four.pcb!.footprints);
  assert.notEqual(two.pcb!.layers, four.pcb!.layers);
  sameFailure(two, /PCB layer In1.Cu is not in the board copper stack/);
  validateProject(copperPose(four, 0.04));
});

test('unchanged footprint pours contribute to the 60000-vertex board limit and retain UUID error priority', () => {
  const project = warmProject();
  const board = project.pcb!;
  const triangle = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 2 },
  ];
  const points = Array.from({ length: 59997 }, (_, index) => ({ ...triangle[index % 3] }));
  const footprintZoneId = uid();
  const limit = ownProject(
    {
      ...project,
      pcb: {
        ...copperPose(project, 0.02).pcb!,
        footprints: board.footprints.map((footprint, index) =>
          index
            ? footprint
            : {
                ...footprint,
                zones: [{ ...board.zones[0], id: footprintZoneId, filledPolygons: [{ points }] }],
              },
        ),
        zones: [{ ...board.zones[0], filledPolygons: [{ points: triangle }] }],
      },
    },
    project,
  );
  validateProject(limit);
  const over = ownProject(
    {
      ...limit,
      pcb: {
        ...copperPose(limit, 0.03).pcb!,
        zones: [
          {
            ...limit.pcb!.zones[0],
            filledPolygons: [{ points: [...triangle, { ...triangle[0] }] }],
          },
        ],
      },
    },
    limit,
  );
  assert.equal(over.pcb!.footprints, limit.pcb!.footprints);
  sameFailure(over, /saved copper fills exceed the 60000-vertex board limit/);
  const duplicate = ownProject(
    {
      ...over,
      pcb: {
        ...copperPose(over, 0.04).pcb!,
        zones: over.pcb!.zones.map((zone) => ({ ...zone, id: footprintZoneId })),
      },
    },
    over,
  );
  sameFailure(duplicate, /duplicate UUID/);
  validateProject(copperPose(limit, 0.05));
});

test('mutable and caller-frozen collections retain fresh nested validation', () => {
  for (const frozen of [false, true]) {
    const caller = exampleProject();
    if (frozen) {
      Object.freeze(caller);
      Object.freeze(caller.pcb);
      Object.freeze(caller.pcb!.footprints);
    }
    validateProject(caller);
    caller.pcb!.footprints[0].pads[0].size.x += 0.1;
    sameFailure(caller, /circular pads need equal/);
  }
  const project = warmProject();
  const publicWrapper = { ...copperPose(project, 0.02) };
  validateProject(publicWrapper);
  publicWrapper.pcb = {
    ...publicWrapper.pcb!,
    footprints: publicWrapper.pcb!.footprints.map((footprint, index) =>
      index ? footprint : { ...footprint, symbolId: uid() },
    ),
  };
  sameFailure(publicWrapper, /missing schematic symbol/);
});

test('late failed candidates remain retryable with a new owned footprint collection', () => {
  const project = warmProject();
  const footprints = ownProjectData([...project.pcb!.footprints]);
  assert.notEqual(footprints, project.pcb!.footprints);
  const invalid = ownProject(
    {
      ...project,
      pcb: {
        ...copperPose(project, 0.02).pcb!,
        footprints,
        tracks: project.pcb!.tracks.map((track, index) =>
          index ? track : { ...track, netId: uid() },
        ),
      },
    },
    project,
  );
  for (let attempt = 0; attempt < 2; attempt++) sameFailure(invalid, /missing PCB net/);
  const accepted = ownProject(
    { ...project, pcb: { ...copperPose(project, 0.03).pcb!, footprints } },
    project,
  );
  assert.equal(accepted.pcb!.footprints, invalid.pcb!.footprints);
  validateProject(accepted);
  validateProject(copperPose(accepted, 0.04));
  const renamed = ownProject(
    { ...copperPose(accepted, 0.05), schematic: { ...accepted.schematic, title: 'New title' } },
    accepted,
  );
  validateProject(renamed);
  validateProject(copperPose(accepted, 0.06));
  assert.equal(serializeProject(renamed), serializeProject(structuredClone(renamed)));
});

test('owned copper commits retain complete Source/native bytes and independent public file containers', () => {
  const project = ownProject(projectFromNativeFiles(projectNativeFiles(exampleProject())));
  const core = new ProjectCore(project);
  for (const delta of [0.02, -0.03, 0.04, -0.05]) {
    const before = core.getSnapshot().project!;
    const board = copperPose(before, delta).pcb!;
    assert.equal(board.footprints, before.pcb!.footprints);
    assert.equal(board.nets, before.pcb!.nets);
    assert.equal(board.layers, before.pcb!.layers);
    const reference = structuredClone({
      ...before,
      pcb: invalidatePCBFill(before.pcb!, board),
    });
    const expectedSource = serializeProject(reference);
    const expectedFiles = projectNativeFiles(reference);
    assert.equal(core.replaceBoard(board), true);
    assert.equal(core.getSnapshot().source, expectedSource);
    assert.deepEqual(core.getNativeFiles(), expectedFiles);
    assert.equal(serializeProject(parseProject(core.getSnapshot().source)), expectedSource);
    const exposed = core.getNativeFiles()!;
    exposed.files[0].source = 'Caller mutation';
    exposed.files.reverse();
    assert.deepEqual(core.getNativeFiles(), expectedFiles);
  }
  const source = core.getSnapshot().source;
  core.undo();
  assert.notEqual(core.getSnapshot().source, source);
  core.redo();
  assert.equal(core.getSnapshot().source, source);
});
