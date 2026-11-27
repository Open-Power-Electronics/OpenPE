import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { GerberLayer } from '../lib/manufacturing-gerber';
import { analyzePCBConnectivity } from '../lib/pcb-connectivity';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { pcbBounds } from '../lib/pcb-layout';
import { fillCopperZones } from '../lib/pcb-polygons';
import { createPCBRouter } from '../lib/pcb-routing';
import { parseProject, serializeProject } from '../lib/project';
import { children, parseSExpr } from '../lib/sexpr';

const name = 'Copper.kicad_pcb';
const arcId = 'b33c7bfd-ef19-48c4-a076-d63e1e6c7c6a';
const source = `(kicad_pcb
 (version 20260206) (generator pcbnew)
 (general (thickness 1.6))
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (setup (pad_to_mask_clearance 0))
 (net 1 "GND")
 (arc (start 4 8) (mid 8 4) (end 12 8) (width 0.25)
  (layer "F.Cu") (net "GND") (locked yes) (uuid "${arcId}"))
)
`;
const open = (boardSource = source) =>
  projectFromNativeFiles({ entry: name, files: [{ name, source: boardSource }] });

test('native arc tracks survive project snapshots and an exact KiCad 10 save', () => {
  const project = open();
  const board = project.pcb!;
  const track = board.arcTracks![0];
  assert.deepEqual(track, {
    id: arcId,
    start: { x: 4, y: 8 },
    mid: { x: 8, y: 4 },
    end: { x: 12, y: 8 },
    width: 0.25,
    layer: 'F.Cu',
    netId: board.nets[0].id,
    locked: true,
  });
  assert.equal(board.tracks.length, 0);
  assert.deepEqual(parseProject(serializeProject(project)).pcb!.arcTracks, board.arcTracks);
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === name)!.source,
    source,
  );
  assert.deepEqual(pcbBounds(board), { minX: 3.875, minY: 3.875, maxX: 12.125, maxY: 8.125 });
  const saved = projectNativeFiles(project);
  const upgraded = saved.files.find((file) => file.name === name)!.source;
  assert.match(upgraded, /\(version 20260206\)/);
  assert.match(upgraded, /\(arc\b[\s\S]*\(mid 8 4\)[\s\S]*\(net "GND"\)/);
  assert.deepEqual(projectFromNativeFiles(saved).pcb!.arcTracks, board.arcTracks);
  assert.throws(() => open(source.replace('(mid 8 4)', '(mid 8 8)')), /non-collinear/);

  const plot = new GerberLayer('Copper,L1,Top');
  plot.graphic({ ...track, kind: 'arc' });
  assert.match(plot.finish(), /G02X12000000Y-8000000I4000000J0D01\*/);
});

test('arc boards do not run straight-only copper operations or accept their geometry edits', () => {
  const project = open();
  const core = new ProjectCore(project);
  const board = project.pcb!;
  const track = board.arcTracks![0];
  assert.throws(() => analyzePCBConnectivity(board), /imported arc tracks/);
  assert.ok(
    runPCBDesignRules(board, { scopes: ['dimensions'], minTrackWidth: 0.3 }).issues.some(
      (issue) => issue.ruleId === 'pcb.track-width' && issue.objectIds.includes(track.id),
    ),
  );
  assert.throws(() => fillCopperZones(board), /imported arc tracks/);
  assert.throws(
    () =>
      createPCBRouter(board, {
        layer: track.layer,
        netId: track.netId,
        width: 0.25,
        clearance: 0.25,
      }),
    /imported arc tracks/,
  );
  assert.throws(
    () =>
      core.replaceBoard({
        ...board,
        arcTracks: [{ ...track, mid: { x: 8, y: 5 } }],
      }),
    /native Source/,
  );
  assert.equal(core.getNativeFiles().files.find((file) => file.name === name)!.source, source);
});

test('native tuning settings and members survive a save and a non-routing edit', () => {
  const pattern = `(generated
   (uuid "12f782a5-856f-4eca-9590-bb5fa4d16049")
   (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu")
   (origin (xy 4 8)) (end (xy 12 8)) (base_line (pts (xy 4 8) (xy 12 8)))
   (rounded yes) (single_sided no) (tuning_mode "single")
   (last_tuning "18 mm (tuned)") (target_length 18)
   (members "${arcId}"))`;
  const tuned = source.slice(0, source.lastIndexOf(')')) + pattern + ')';
  const straight = tuned.replace('(arc (start 4 8) (mid 8 4)', '(segment (start 4 8)');
  for (const boardSource of [tuned, straight]) {
    const project = open(boardSource);
    const expected = [parseSExpr(pattern)];
    assert.deepEqual(parseProject(serializeProject(project)).pcb!.tuningPatterns, expected);
    let saved = projectNativeFiles(project);
    assert.deepEqual(projectFromNativeFiles(saved).pcb!.tuningPatterns, expected);

    const core = new ProjectCore(project);
    assert.equal(core.replaceBoard({ ...project.pcb!, thickness: 1.5 }), true);
    saved = core.getNativeFiles();
    const boardText = saved.files.find((file) => file.name === name)!.source;
    assert.deepEqual(children(parseSExpr(boardText), 'generated'), expected);
    const { tuningPatterns: _patterns, ...withoutPatterns } = project.pcb!;
    assert.throws(() => core.replaceBoard(withoutPatterns), /native Source/);
  }
  assert.throws(
    () =>
      open(
        tuned.replace(`(members "${arcId}")`, '(members "6cf4c865-efd1-420d-a208-81e899d82e0e")'),
      ),
    /invalid PCB tuning pattern field members/,
  );
});
