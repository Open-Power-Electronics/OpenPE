import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { child, children, parseSExpr, val } from '../lib/sexpr';

const name = 'Identity.kicad_pcb';
const shortTrack = '0-0-0-0-000000000001';
const shortGroup = '0-0-0-0-000000000002';
const source = `(kicad_pcb (version 20260206) (generator "pcbnew")
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (setup (pad_to_mask_clearance 0))
  (segment (start 2 3) (end 4 3) (width .2) (layer "F.Cu") (net "GND") (uuid "${shortTrack}"))
  (group "${shortTrack}" (uuid "${shortGroup}") (members "${shortTrack}")))\n`;

test('compact KiCad 10 UUIDs retain copper, text, group references and clean native bytes', () => {
  const open = (source: string) =>
    projectFromNativeFiles({ entry: name, files: [{ name, source }] });
  const project = open(source);
  const board = project.pcb!;
  const id = board.tracks[0].id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(open(source).pcb!.tracks[0].id, id);
  const copy = projectNativeFiles(project, 'Copy.kicad_pro');
  assert.equal(copy.files.find((file) => file.name === 'Copy.kicad_pcb')!.source, source);
  const edited = projectNativeFiles({ ...project, pcb: { ...board, thickness: 2 } });
  const updated = edited.files.find((file) => file.name === name)!.source;
  const [group] = children(parseSExpr(updated), 'group');
  assert.equal(val(group), shortTrack);
  assert.equal(val(child(group, 'members')), id);
  assert.deepEqual(projectFromNativeFiles(edited).pcb!.tracks, board.tracks);
  assert.throws(() => open(source.replace(shortGroup, shortTrack)), /group metadata/i);
});

test('repeated property UUIDs in separate footprints retain text and independent editor identities', () => {
  const propertyId = '41871c7d-910b-442c-8065-11a0396c6463';
  const footprints = ['H1', 'H2'].map(
    (reference, index) => `
    (footprint "Test:Mount" (layer "F.Cu") (at ${10 + index} 20)
      (uuid "0c4d085b-1b04-4af7-869c-4e413d67045${index}")
      (property "Reference" "${reference}" (at 0 0) (layer "F.Fab") (uuid "${propertyId}")
        (effects (font (size 1 1) (thickness 0.15)))))`,
  );
  const native = source.replace('(segment', footprints.join(' ') + ' (segment');
  const project = projectFromNativeFiles({ entry: name, files: [{ name, source: native }] });
  const labels = project.pcb!.footprints.map((item) => item.graphics[0]);
  assert.notEqual(labels[0].id, labels[1].id);
  assert.deepEqual(
    project.pcb!.footprints.map(({ reference }) => reference),
    ['H1', 'H2'],
  );
  assert.equal(
    projectNativeFiles(project).files.find((file) => file.name === name)?.source,
    native,
  );
});
