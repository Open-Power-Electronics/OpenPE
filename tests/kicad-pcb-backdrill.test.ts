import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LayoutViaDrillDrawing } from '../components/LayoutBoardDrawing';
import { createLayoutSelection } from '../components/LayoutSelection';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { exportProjectFile } from '../lib/manufacturing-export';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { pcbViaBackdrillDiameterOnLayer } from '../lib/pcb-native-via';
import { child, children, parseSExpr } from '../lib/sexpr';

const name = 'Backdrills.kicad_pcb';
const backdrill = '(backdrill (size 0.33) (layers "F.Cu" "In1.Cu"))';
const tertiary = '(tertiary_drill (size 0.42) (layers "B.Cu" "In4.Cu"))';
const source = `(kicad_pcb
  (version 20260206) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal)
    (8 "In3.Cu" signal) (10 "In4.Cu" signal) (2 "B.Cu" signal))
  (setup (pad_to_mask_clearance 0))
  (via (at 10 20) (size 0.6) (drill 0.3) ${backdrill} ${tertiary}
    (layers "F.Cu" "B.Cu") (net "GND") (uuid "8eac83fc-8499-4404-9e9e-e99bd125f517"))
  (via (at 20 30) (size 0.6) (drill 0.3) ${tertiary}
    (layers "F.Cu" "B.Cu") (net "GND") (uuid "255eb0af-640b-4bbf-bcf8-e11ab7bed1da"))
)\n`;
const open = (sourceText = source) =>
  projectFromNativeFiles({ entry: name, files: [{ name, source: sourceText }] });

test('native via backdrill records keep both slot geometries in Layout, Save and reopen', () => {
  const project = open();
  const board = project.pcb!;
  const [via, backOnly] = board.vias;
  assert.deepEqual(via.backdrills, {
    secondary: { diameter: 0.33, start: 'F.Cu', end: 'In1.Cu' },
    tertiary: { diameter: 0.42, start: 'B.Cu', end: 'In4.Cu' },
  });
  assert.deepEqual(backOnly.backdrills, { tertiary: via.backdrills.tertiary });
  assert.deepEqual(
    board.layers.map((layer) => pcbViaBackdrillDiameterOnLayer(via, layer)),
    [0.33, 0.33, 0, 0, 0.42, 0.42],
  );
  const svg = renderToStaticMarkup(
    createElement(LayoutViaDrillDrawing, {
      via,
      selection: createLayoutSelection(),
      highlightNets: new Set<string>(),
    }),
  );
  assert.match(svg, /<circle cx="10" cy="20" r="0\.15"/);
  assert.match(
    svg,
    /data-backdrill-diameter="0\.33" data-backdrill-start="F\.Cu" data-backdrill-end="In1\.Cu"/,
  );
  assert.match(
    svg,
    /data-backdrill-diameter="0\.42" data-backdrill-start="B\.Cu" data-backdrill-end="In4\.Cu"/,
  );
  assert.equal((svg.match(/<path /g) ?? []).length, 4);

  const core = new ProjectCore(project);
  const native = () => core.getNativeFiles().files.find((f) => f.name === name)!.source;
  assert.equal(native(), source);
  assert.equal(core.replaceBoard({ ...board, thickness: 1.7 }), true);
  const [compiled] = children(parseSExpr(native()), 'via');
  assert.deepEqual(child(compiled, 'backdrill'), parseSExpr(backdrill));
  assert.deepEqual(child(compiled, 'tertiary_drill'), parseSExpr(tertiary));
  assert.deepEqual(open(native()).pcb!.vias, board.vias);
  assert.equal(exportProjectFile(project, 'drill', name).name, 'Backdrills-drill.zip');
});

test('backdrill DRC distinguishes unplated entry layers from retained same-net copper', () => {
  const tracks = ['F.Cu', 'In2.Cu'].map(
    (layer) =>
      `(segment (start 10.45 19.95) (end 10.45 20.05) (width 0.16) (layer "${layer}") (net "GND"))`,
  );
  const board = open(
    source
      .replace('  (via (at 10 20)', `  ${tracks.join('\n  ')}\n  (via (at 10 20)`)
      .replace('(size 0.33)', '(size 0.50)'),
  ).pcb!;
  const result = runPCBDesignRules(board, { copperToHole: 0.15 });
  const issues = result.issues.filter((issue) => issue.ruleId === 'pcb.copper-hole');
  assert.deepEqual(
    issues.map((issue) => issue.objectIds),
    [[board.tracks[0].id, board.vias[0].id]],
  );
  assert.match(issues[0].message, /non-plated.*0\.12 mm/);
});

test('backdrill DRC cannot credit an entry-layer land with a removed barrel connection', () => {
  const lands = ['F.Cu', 'B.Cu'].map(
    (layer, index) => `(footprint "Land${index}" (layer "${layer}") (at 10.26 20)
      (pad "1" smd rect (at 0 0) (size 0.16 0.16) (layers "${layer}") (net "GND")))`,
  );
  const withBackdrill = source
    .replaceAll(tertiary, '')
    .replace('  (via (at 10 20)', `  ${lands.join('\n  ')}\n  (via (at 10 20)`);
  const unconnected = (text: string) =>
    runPCBDesignRules(open(text).pcb!).issues.filter((issue) => issue.ruleId === 'pcb.unrouted');
  assert.equal(unconnected(withBackdrill).length, 1);
  assert.equal(unconnected(withBackdrill.replace(backdrill, '')).length, 0);
});

test('native backdrill layer, precision and field validation reject unsupported geometry', () => {
  assert.throws(
    () => open(source.replace('"F.Cu" "In1.Cu"', '"F.Cu" "In5.Cu"')),
    /within the via span/,
  );
  assert.throws(
    () => open(source.replace('(size 0.33) (layers', '(size 0.33) (size 0.34) (layers')),
    /backdrill diameter or layer range/,
  );
  assert.throws(
    () => open(source.replace('(size 0.33)', '(size 0.3300001)')),
    /backdrills\/secondary\/diameter.*0\.000001/,
  );
});
