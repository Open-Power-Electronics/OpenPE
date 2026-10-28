import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { isOwnedProjectNode, ownProjectData } from '../lib/immutable-project';

type Board = { nets: { id: string; name: string }[]; layers: string[] };
type Part = { id: string; value: string };
type Prepared = {
  netOptions: { value: string; label: string }[];
  layerOptions: { value: string; label: string }[];
  part: Part | undefined;
};
// Run the actual component's preparation/dependency block without mounting UI.
// The local useMemo model retains only the previous render's dependency slot.
const source = await readFile(
  new URL('../components/LayoutProperties.tsx', import.meta.url),
  'utf8',
);
const start = source.indexOf('  const ownedNets = '),
  end = source.indexOf('  const attempt = ', start);
assert.ok(start >= 0 && end > start);
const prepared = await transform(source.slice(start, end), { loader: 'ts' });
const run = new Function(
  'useMemo',
  'isOwnedProjectNode',
  'board',
  'schematic',
  'footprint',
  prepared.code + '\nreturn {netOptions,layerOptions,part};',
);
function renderer() {
  let slots: { inputs: readonly unknown[]; value: unknown }[] = [];
  return (
    board: Board,
    schematic: { parts: Part[] } = { parts: [] },
    footprint?: { symbolId: string | null },
  ): Prepared => {
    let index = 0;
    const next: typeof slots = [];
    const useMemo = (create: () => unknown, inputs: readonly unknown[]) => {
      const previous = slots[index];
      const entry =
        previous &&
        previous.inputs.length === inputs.length &&
        previous.inputs.every((value, position) => Object.is(value, inputs[position]))
          ? previous
          : { inputs: [...inputs], value: create() };
      next[index++] = entry;
      return entry.value;
    };
    const result = run(useMemo, isOwnedProjectNode, board, schematic, footprint);
    slots = next;
    return result;
  };
}
const board = (): Board => ({
  nets: [
    { id: 'A', name: 'Input' },
    { id: 'B', name: 'Output' },
  ],
  layers: ['F.Cu', 'B.Cu'],
});

test('property options retain exact owned arrays and refresh changed native net/layer inputs independently', () => {
  const render = renderer(),
    firstBoard = ownProjectData(board()),
    first = render(firstBoard);
  const same = render(firstBoard);
  assert.equal(same.netOptions, first.netOptions);
  assert.equal(same.layerOptions, first.layerOptions);
  const renamed = ownProjectData(
    { ...firstBoard, nets: [{ ...firstBoard.nets[0], name: 'Renamed' }, firstBoard.nets[1]] },
    firstBoard,
  );
  const changed = render(renamed);
  assert.notEqual(changed.netOptions, first.netOptions);
  assert.deepEqual(changed.netOptions, [
    { value: 'A', label: 'Renamed' },
    { value: 'B', label: 'Output' },
  ]);
  assert.equal(changed.layerOptions, first.layerOptions);
  const four = ownProjectData(
    { ...renamed, layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] },
    renamed,
  );
  const multilayer = render(four);
  assert.equal(multilayer.netOptions, changed.netOptions);
  assert.deepEqual(
    multilayer.layerOptions.map((option) => option.value),
    four.layers,
  );
  const removed = ownProjectData({ ...four, nets: [] }, four);
  assert.deepEqual(render(removed).netOptions, []);
});

test('mutable and caller-frozen options remain fresh after nested input changes', () => {
  for (const freezeBoard of [false, true]) {
    const raw = board(),
      candidate = freezeBoard ? Object.freeze(raw) : raw,
      render = renderer();
    const first = render(candidate);
    raw.nets[0].name = 'Changed raw value';
    raw.layers.splice(1, 0, 'In1.Cu');
    const next = render(candidate);
    assert.notEqual(next.netOptions, first.netOptions);
    assert.notEqual(next.layerOptions, first.layerOptions);
    assert.equal(next.netOptions[0].label, 'Changed raw value');
    assert.deepEqual(
      next.layerOptions.map((option) => option.value),
      raw.layers,
    );
  }
  const frozen = board();
  Object.freeze(frozen.nets);
  Object.freeze(frozen.layers);
  const render = renderer(),
    first = render(frozen);
  frozen.nets[0].name = 'Nested array data remains caller owned';
  const next = render(frozen);
  assert.notEqual(next.netOptions, first.netOptions);
  assert.notEqual(next.layerOptions, first.layerOptions);
  assert.equal(next.netOptions[0].label, frozen.nets[0].name);
});

test('ownership belongs to the array and switching from owned inputs cannot retain stale options', () => {
  const owned = ownProjectData(board()),
    render = renderer(),
    saved = render(owned);
  const borrowed = { nets: [...owned.nets], layers: [...owned.layers] };
  const first = render(borrowed),
    second = render(borrowed);
  assert.notEqual(first.netOptions, saved.netOptions);
  assert.notEqual(second.netOptions, first.netOptions);
  assert.notEqual(second.layerOptions, first.layerOptions);
  borrowed.nets = [{ id: 'C', name: 'New' }];
  assert.deepEqual(render(borrowed).netOptions, [{ value: 'C', label: 'New' }]);
});

test('non-footprint inspection never scans schematic parts; assigned footprints observe current source', () => {
  const render = renderer(),
    owned = ownProjectData(board());
  let reads = 0;
  const unused = {
    get parts(): Part[] {
      reads++;
      throw new Error('Unrelated schematic scan');
    },
  };
  assert.equal(render(owned, unused).part, undefined);
  assert.equal(render(owned, unused, { symbolId: null }).part, undefined);
  assert.equal(render(owned, unused, { symbolId: '' }).part, undefined);
  assert.equal(reads, 0);
  const schematic = {
    parts: [
      { id: 'P', value: 'Before' },
      { id: 'Q', value: 'Other' },
    ],
  };
  assert.equal(render(owned, schematic, { symbolId: 'P' }).part, schematic.parts[0]);
  schematic.parts[0] = { id: 'P', value: 'After Source update' };
  assert.equal(render(owned, schematic, { symbolId: 'P' }).part?.value, 'After Source update');
  assert.equal(render(owned, schematic, { symbolId: 'Q' }).part, schematic.parts[1]);
  assert.equal(render(owned, { parts: [] }, { symbolId: 'P' }).part, undefined);
});
