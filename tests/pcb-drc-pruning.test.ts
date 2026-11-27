import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { resolvePCBPrunedCopper } from '../lib/pcb-pruned-copper';

const filename = 'Layer-pruning.kicad_pcb';
const padId = '4ba2937b-1df1-499f-8857-7bb284fd5b50';
const viaId = '4ba2937b-1df1-499f-8857-7bb284fd5b51';
const trace = (start: string, end: string, layer: string, net = 'A') =>
  `(segment (start ${start}) (end ${end}) (width 0.1) (layer "${layer}") (net "${net}"))`;
const boardWith = (extra: string) => `(kicad_pcb (version 20260206) (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (gr_rect (start 0 0) (end 30 30) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts"))
  (footprint "Test:Conditional" (layer "F.Cu") (at 10 10)
    (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 0.8) (layers "*.Cu" "*.Mask")
      (remove_unused_layers yes) (keep_end_layers yes) (zone_layer_connections "In2.Cu")
      (net "A") (uuid "${padId}")))
  (via (at 20 10) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (remove_unused_layers yes)
    (zone_layer_connections "In2.Cu") (net "A") (uuid "${viaId}"))
  ${trace('10.95 9', '10.95 11', 'In1.Cu', 'B')}
  ${trace('20.65 9', '20.65 11', 'In1.Cu', 'B')}
  ${extra})`;
const open = (source: string) =>
  projectFromNativeFiles({ entry: filename, files: [{ name: filename, source }] });
const shorted = (source: string) => {
  const project = open(source);
  const result = runPCBDesignRules(project.pcb!, { clearance: 0.05, copperToHole: 0 });
  assert.ok(result.checkedRules.includes('pcb.unrouted'));
  assert.equal(
    projectNativeFiles(project).files.find(({ name }) => name === filename)?.source,
    source,
  );
  return [
    ...new Set(
      result.issues
        .filter(({ ruleId }) => ruleId === 'pcb.short')
        .flatMap(({ objectIds }) => objectIds),
    ),
  ];
};

test('conditional rings retain end or saved zone layers and flash where same-layer same-net tracks touch the bore', () => {
  const shallow = boardWith(trace('10.55 10', '10.7 10', 'In1.Cu'));
  const idle = open(shallow).pcb!;
  const before = resolvePCBPrunedCopper(idle, () => {});
  assert.deepEqual(before.pads.get(idle.footprints[0].pads[0]), ['F.Cu', 'In2.Cu', 'B.Cu']);
  assert.deepEqual([...before.vias.get(idle.vias[0])!], ['In2.Cu']);
  assert.deepEqual(shorted(shallow), []);

  const connected = boardWith(`${trace('8 10', '10 10', 'In1.Cu')}
    (arc (start 17 10) (mid 18.5 11.5) (end 20 10) (width 0.1) (layer "In1.Cu") (net "A"))`);
  const live = open(connected).pcb!;
  const after = resolvePCBPrunedCopper(live, () => {});
  assert.deepEqual(after.pads.get(live.footprints[0].pads[0]), [
    'F.Cu',
    'In1.Cu',
    'In2.Cu',
    'B.Cu',
  ]);
  assert.deepEqual([...after.vias.get(live.vias[0])!], ['In1.Cu', 'In2.Cu']);
  const shorts = shorted(connected);
  assert.ok(shorts.includes(padId));
  assert.ok(shorts.includes(viaId));
});

test('pads only flash for matching same-layer copper and do not seed another conditional pad', () => {
  const nonMatching = open(
    boardWith(`${trace('8 10', '10 10', 'B.Cu')}
    ${trace('8 10', '10 10', 'In1.Cu', 'B')}
    (footprint "Test:Unused" (layer "F.Cu") (at 10.1 10)
      (pad "1" thru_hole circle (at 0 0) (size 0.8 0.8) (drill 0.5) (layers "*.Cu")
        (remove_unused_layers yes) (net "A")))`),
  ).pcb!;
  const pruning = resolvePCBPrunedCopper(nonMatching, () => {});
  assert.deepEqual(pruning.pads.get(nonMatching.footprints[0].pads[0]), ['F.Cu', 'In2.Cu', 'B.Cu']);
});
