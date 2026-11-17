import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectCore } from '../core/project-core';
import { createPart, emptyCircuit, uid } from '../lib/circuit';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject, parseProject, serializeProject } from '../lib/project';

for (const withFootprint of [false, true]) {
  test(`Save materialization retains the written native bytes for a new ${withFootprint ? 'populated' : 'empty'} PCB`, () => {
    const schematic = emptyCircuit();
    schematic.title = 'Native materialization';
    const project = createProject(schematic);
    project.pcb = createEmptyPCB();
    if (withFootprint) {
      const part = createPart(schematic, 'R', 25.4, 25.4);
      part.fields = { Footprint: 'Fixture:R' };
      schematic.parts.push(part);
      const netId = uid();
      project.pcb.nets = [{ id: netId, name: 'SIGNAL' }];
      project.pcb.footprints = [
        {
          id: uid(),
          symbolId: part.id,
          libraryId: 'Fixture:R',
          x: 10,
          y: 10,
          rotation: 0,
          side: 'front',
          graphics: [],
          pads: ['1', '2'].map((number, index) => ({
            id: uid(),
            number,
            x: index * 2.54,
            y: 0,
            rotation: 0,
            type: 'smd' as const,
            shape: 'rect' as const,
            size: { x: 1, y: 1 },
            netId: index ? netId : null,
          })),
        },
      ];
      project.pcb.tracks = [
        {
          id: uid(),
          start: { x: 10, y: 15 },
          end: { x: 20, y: 15 },
          width: 0.4,
          layer: 'F.Cu',
          netId,
        },
      ];
    }

    // Match the canonical project admitted through recovery/the private adapter.
    const core = new ProjectCore(parseProject(serializeProject(project)));
    const before = core.getSnapshot();
    const snapshot = before.project!;
    const entry = 'materialized.kicad_pro';
    // The native host parses the private Save payload before exporting it.
    const written = projectNativeFiles(parseProject(serializeProject(snapshot)), entry);
    const nativeFiles = projectNativeFiles(snapshot, entry);
    assert.deepEqual(nativeFiles, written, 'Renderer and host agree before Save materialization.');

    assert.equal(core.materialize(snapshot, { ...snapshot, nativeFiles }), true);
    core.setNativeEntryName(entry);
    const after = core.getSnapshot();
    assert.equal(after.undoDepth, before.undoDepth, 'Saving adds no design undo transaction.');
    assert.equal(after.redoDepth, before.redoDepth);
    assert.equal(after.project!.pcb, snapshot.pcb, 'Saving retains the canonical board geometry.');
    assert.equal(after.sourceDraft, null);
    assert.deepEqual(
      after.project!.nativeFiles,
      written,
      'Materialization retains the native backing supplied by the Save adapter.',
    );
    assert.deepEqual(
      core.getNativeFiles(),
      written,
      'Source must expose the exact filenames, encodings and bytes the native host wrote.',
    );
    assert.deepEqual(
      projectNativeFiles(parseProject(after.source), entry),
      written,
      'The saved private baseline must reproduce the same native file bytes.',
    );

    if (withFootprint) {
      const savedBoard = after.project!.pcb!;
      const track = savedBoard.tracks[0];
      const width = 0.6;
      assert.equal(
        core.replaceBoard({
          ...savedBoard,
          tracks: savedBoard.tracks.map((item) =>
            item.id === track.id ? { ...item, width } : item,
          ),
        }),
        true,
      );
      const edited = core.getSnapshot();
      assert.equal(edited.project!.pcb!.id, savedBoard.id);
      assert.equal(
        edited.undoDepth,
        after.undoDepth + 1,
        'A real copper edit adds one undo entry.',
      );
      const changed = core.getNativeFiles();
      assert.notEqual(
        changed.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source,
        written.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source,
        'A real track-width change cannot reuse the saved PCB backing bytes.',
      );
      const reparsed = projectFromNativeFiles(changed);
      assert.equal(reparsed.pcb!.tracks.find((item) => item.id === track.id)!.width, width);
      assert.deepEqual(
        changed.files.filter((file) => !file.name.endsWith('.kicad_pcb')),
        written.files.filter((file) => !file.name.endsWith('.kicad_pcb')),
        'Editing copper retains the unchanged project and schematic bytes.',
      );

      assert.equal(core.undo(), true);
      assert.equal(core.getSnapshot().project, after.project);
      assert.equal(core.getSnapshot().source, after.source);
      assert.equal(core.getSnapshot().undoDepth, after.undoDepth);
      assert.deepEqual(
        core.getNativeFiles(),
        written,
        'Undo to the saved state restores every original native byte.',
      );
    }
  });
}
