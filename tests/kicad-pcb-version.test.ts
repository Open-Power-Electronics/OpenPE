import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCircuit } from '../lib/circuit';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { KICAD_PCB_VERSION } from '../lib/kicad-version';
import { child, parseSExpr, val } from '../lib/sexpr';

test('PCB admission accepts the stable format and other KiCad 10 release stamps', () => {
  const source = `(kicad_pcb
    (version ${KICAD_PCB_VERSION}) (generator "pcbnew")
    (general (thickness 1.6))
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    (setup (pad_to_mask_clearance 0)))`;
  const schematic = emptyCircuit();
  const read = (text: string) => parseKiCadPCB(text, schematic, schematic.id);
  assert.deepEqual(read(source).board.layers, ['F.Cu', 'B.Cu']);
  for (const version of ['20241229', '20250907', '20261201'])
    assert.throws(() => read(source.replace(KICAD_PCB_VERSION, version)), /Use KiCad 10/);
  const earlierStamp = source.replace(`(version ${KICAD_PCB_VERSION})`, '(version 20241229)');
  const withRelease = (release: string) =>
    earlierStamp.replace(
      '(generator "pcbnew")',
      `(generator "pcbnew") (generator_version "${release}")`,
    );
  assert.deepEqual(read(withRelease('10.0')).board.layers, ['F.Cu', 'B.Cu']);
  assert.deepEqual(read(withRelease('10.0.7')).board.layers, ['F.Cu', 'B.Cu']);
  for (const release of ['9.0', '10.99', '11.0'])
    assert.throws(() => read(withRelease(release)), /Use KiCad 10/);
  assert.throws(() => read(withRelease('10.0').replace('"pcbnew"', '"other"')), /Use KiCad 10/);
  assert.throws(
    () => read(withRelease('10.0').replace('(general', '(gr_unknown) (general')),
    /unsupported gr_unknown/,
  );
});

test('KiCad 10 files with another stamp retain original bytes and compile edits with the stable writer', () => {
  const name = 'Versioned.kicad_pcb';
  const source = `(kicad_pcb
    (version 20241229) (generator "pcbnew") (generator_version "10.0")
    (general (thickness 1.6))
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    (setup (pad_to_mask_clearance 0))
    (segment (start 1 2) (end 3 2) (width 0.25) (layer "F.Cu") (net "GND")
      (uuid "399713f7-f28d-45c1-9684-43f0296b41a5")))\n`;
  const project = projectFromNativeFiles({ entry: name, files: [{ name, source }] });
  const copy = projectNativeFiles(project, 'Copy.kicad_pro');
  assert.equal(copy.files.find((file) => file.name === 'Copy.kicad_pcb')?.source, source);

  const edited = projectNativeFiles({ ...project, pcb: { ...project.pcb!, thickness: 1.8 } });
  const board = edited.files.find((file) => file.name === name)!;
  assert.equal(val(child(parseSExpr(board.source), 'version')), KICAD_PCB_VERSION);
  const reopened = projectFromNativeFiles(edited);
  assert.equal(reopened.pcb?.thickness, 1.8);
  assert.deepEqual(reopened.pcb?.tracks, project.pcb?.tracks);
});
