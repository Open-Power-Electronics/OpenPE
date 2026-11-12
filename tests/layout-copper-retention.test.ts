import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement, Fragment } from 'react';
import { build } from 'esbuild';
import type { PCBFillPreview } from '../components/pcbFillPreview';

// Exercise the actual editor dependency arrays/drawing block and existing
// retention hooks without a browser. Only commit publishes layout effects;
// an abandoned render discards its memo/effect slots, as a suspended render can.
const source = await readFile(new URL('../components/LayoutEditor.tsx', import.meta.url), 'utf8');
const section = (start: string, end: string) => {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0, start);
  const finish = source.indexOf(end, offset);
  assert.ok(finish > offset, end);
  return source.slice(offset, finish);
};
const statement = (start: string) => section(start, ';') + ';';
type Slot = { value?: unknown; dependencies?: readonly unknown[] };
type Work = { slots: Slot[]; index: number; effects: (() => void)[] };
let active: { committed: Slot[]; work: Work } | undefined;
const equal = (a: readonly unknown[] | undefined, b: readonly unknown[]) =>
  a?.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const runtime = {
  createElement,
  Fragment,
  useRef(value: unknown) {
    assert.ok(active);
    const index = active.work.index++;
    const slot = active.committed[index] ?? { value: { current: value } };
    active.work.slots[index] = slot;
    return slot.value;
  },
  useMemo(prepare: () => unknown, dependencies: readonly unknown[]) {
    assert.ok(active);
    const index = active.work.index++;
    const previous = active.committed[index];
    const slot =
      previous && equal(previous.dependencies, dependencies)
        ? previous
        : { value: prepare(), dependencies: [...dependencies] };
    active.work.slots[index] = slot;
    return slot.value;
  },
  useLayoutEffect(effect: () => void, dependencies: readonly unknown[]) {
    assert.ok(active);
    const index = active.work.index++;
    if (!equal(active.committed[index]?.dependencies, dependencies))
      active.work.effects.push(effect);
    active.work.slots[index] = { dependencies: [...dependencies] };
  },
};
const key = '__openpeCopperRetentionTest';
(globalThis as Record<string, unknown>)[key] = runtime;
const compiled = await build({
  stdin: {
    contents: `import * as React from 'react';import {useMemo} from 'react';
      import useRetainedElements from './components/useRetainedElements';
      import useRetainedElementBatches from './components/useRetainedElementBatches';
      type BoardLayer=string;type ReactNode=unknown;
      const LayoutZoneFillDrawing='zone-fill',LayoutZoneOutlineDrawing='zone-outline',LayoutTrackDrawing='track';
      export default function draw(input){
        const {copperLayers,layers,copperZones,copperPaths,fillPreview,fillPreviewZones,boardSurface,pattern,zoneOwners,zoneOutlinePaths,selectionPaint,highlightNets,placed,netNames}=input;
        const motionBoard=placed;
        const showFootprintMotion=false;
        const footprintMotionIds=null;
        const visibleLayer=(name)=>Boolean(layers[name]);
        ${section('  const copperFillInputs = [', '  const footprintPasses = useMemo(')}
        ${statement('  const retainTrack = useRetainedElements(')}
        ${statement('  const retainTrackBatches = useRetainedElementBatches(')}
        ${statement('  const retainFill = useRetainedElements(')}
        ${statement('  const retainOutline = useRetainedElements(')}
        ${section('  const copperFillDrawing = useMemo(', '  const footprintDrawing = useMemo(')}
        return {fills:copperFillDrawing,outlines:copperOutlineDrawing,copper:copperDrawing};
      }`,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'pure-react-hook-commit-model',
      setup(plugin) {
        plugin.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hooks' }));
        plugin.onLoad({ filter: /.*/, namespace: 'hooks' }, () => ({
          contents: `const r=globalThis[${JSON.stringify(key)}];export const createElement=r.createElement,Fragment=r.Fragment,useMemo=r.useMemo,useRef=r.useRef,useLayoutEffect=r.useLayoutEffect;`,
        }));
      },
    },
  ],
});
const draw = (
  await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
  )
).default;
delete (globalThis as Record<string, unknown>)[key];
type Element = { key: string; props: Record<string, any> };
type Drawing = {
  fills: Map<string, Element[]>;
  outlines: Map<string, Element[]>;
  copper: Map<string, Element>;
};
function renderer() {
  let committed: Slot[] = [];
  return (input: ReturnType<typeof fixture>, commit = true): Drawing => {
    const work: Work = { slots: [], index: 0, effects: [] };
    active = { committed, work };
    let result: Drawing;
    try {
      result = draw(input);
    } finally {
      active = undefined;
    }
    if (commit) {
      committed = work.slots;
      for (const effect of work.effects) effect();
    }
    return result;
  };
}
function fixture() {
  const zones = [
    { id: 'A', layer: 'F.Cu', netId: 'N' },
    { id: 'B', layer: 'F.Cu', netId: 'N' },
    { id: 'C', layer: 'B.Cu', netId: null },
  ];
  return {
    copperLayers: ['F.Cu', 'B.Cu'],
    layers: { 'F.Cu': true, 'B.Cu': true, copper: true, zoneOutlines: true },
    copperZones: zones,
    copperPaths: new Map(zones.map((zone) => [zone.id, `fill-${zone.id}`])),
    fillPreview: { changed: false, zones: [] } as PCBFillPreview,
    fillPreviewZones: new Map<string, PCBFillPreview['zones'][number]>(),
    boardSurface: 'board-outline',
    pattern: 'test-layout',
    zoneOwners: new Map([['A', 'footprint-owner']]),
    zoneOutlinePaths: new Map<string, { path: string; target?: string }>(
      zones.map((zone) => [zone.id, { path: `outline-${zone.id}` }]),
    ),
    selectionPaint: {},
    highlightNets: new Set<string>(),
    placed: { zones, tracks: [{ id: 'T', layer: 'F.Cu', netId: 'N', start: { x: 0, y: 0 } }] },
    netNames: new Map([['N', 'Net']]),
  };
}

test('track coordinate previews retain ordered zone preparations and update track props', () => {
  const render = renderer(),
    basis = fixture(),
    first = render(basis);
  const next = {
    ...basis,
    placed: { ...basis.placed, tracks: [{ ...basis.placed.tracks[0], start: { x: 7, y: -3 } }] },
  };
  const preview = render(next);
  assert.equal(preview.fills, first.fills);
  assert.equal(preview.outlines, first.outlines);
  assert.equal(preview.copper.get('F.Cu')!.props.children[0], first.fills.get('F.Cu'));
  assert.equal(preview.copper.get('F.Cu')!.props.children[1], first.outlines.get('F.Cu'));
  const track = preview.copper.get('F.Cu')!.props.children[2][0].props.children[0];
  assert.equal(track.props.track, next.placed.tracks[0]);
  assert.deepEqual(track.props.track.start, { x: 7, y: -3 });
  assert.deepEqual(
    preview.fills.get('F.Cu')!.map((element) => element.key),
    ['A', 'B'],
  );
  assert.deepEqual(
    preview.outlines.get('F.Cu')!.map((element) => element.key),
    ['A', 'B'],
  );
});

test('fill invalidation, ownership, highlight and outline paths invalidate only their drawing inputs', () => {
  const render = renderer(),
    basis = fixture(),
    first = render(basis);
  const unfilled = { ...basis, copperPaths: new Map<string, string>() };
  const cleared = render(unfilled);
  assert.equal(cleared.fills.get('F.Cu')![0].props.path, '');
  assert.equal(cleared.outlines, first.outlines);
  const restored = render({
    ...basis,
    zoneOwners: new Map([['A', 'new-owner']]),
    highlightNets: new Set(['N']),
  });
  assert.equal(restored.fills.get('F.Cu')![0].props.path, 'fill-A');
  assert.equal(restored.fills.get('F.Cu')![0].props.ownerId, 'new-owner');
  assert.equal(restored.fills.get('F.Cu')![0].props.highlightNets.has('N'), true);
  assert.equal(restored.outlines, first.outlines);
  const outline = render({
    ...basis,
    zoneOutlinePaths: new Map([
      ...basis.zoneOutlinePaths,
      ['A', { path: 'resized-A', target: 'full-A' }],
    ]),
  });
  assert.equal(outline.outlines.get('F.Cu')![0].props.path, 'resized-A');
  assert.equal(outline.outlines.get('F.Cu')![0].props.target, 'full-A');
  assert.equal(outline.outlines.get('F.Cu')![1], first.outlines.get('F.Cu')![1]);
});

test('layer visibility, fill toggles and zone ordering retain the original fill-outline-track slots', () => {
  const render = renderer(),
    basis = fixture();
  render(basis);
  const reordered = {
    ...basis,
    copperLayers: ['B.Cu', 'F.Cu'],
    copperZones: [...basis.copperZones].reverse(),
    placed: { ...basis.placed, zones: [...basis.placed.zones].reverse() },
  };
  const next = render(reordered);
  assert.deepEqual([...next.copper.keys()], ['B.Cu', 'F.Cu']);
  assert.deepEqual(
    next.fills.get('F.Cu')!.map((element) => element.key),
    ['B', 'A'],
  );
  assert.deepEqual(
    next.outlines.get('F.Cu')!.map((element) => element.key),
    ['B', 'A'],
  );
  const hidden = render({ ...basis, layers: { ...basis.layers, 'B.Cu': false, copper: false } });
  assert.equal(hidden.copper.has('B.Cu'), false);
  assert.equal(hidden.copper.get('F.Cu')!.props.children[0], undefined);
  assert.equal(hidden.copper.get('F.Cu')!.props.children[1], hidden.outlines.get('F.Cu'));
  const selection = {};
  const selected = render({ ...basis, selectionPaint: selection });
  assert.equal(selected.fills.get('F.Cu')![0].props.selection, selection);
  assert.equal(selected.outlines.get('F.Cu')![0].props.selection, selection);
});

test('abandoned zone preparation cannot replace the committed retention maps', () => {
  const render = renderer(),
    basis = fixture(),
    first = render(basis);
  const proposed = {
    ...basis,
    copperPaths: new Map([...basis.copperPaths, ['A', 'abandoned-fill']]),
    zoneOutlinePaths: new Map([...basis.zoneOutlinePaths, ['A', { path: 'abandoned-outline' }]]),
  };
  const abandoned = render(proposed, false);
  assert.equal(abandoned.fills.get('F.Cu')![0].props.path, 'abandoned-fill');
  const resumed = render({
    ...basis,
    placed: { ...basis.placed, tracks: [{ ...basis.placed.tracks[0], start: { x: 1, y: 2 } }] },
  });
  assert.equal(resumed.fills, first.fills);
  assert.equal(resumed.outlines, first.outlines);
  assert.equal(resumed.fills.get('F.Cu')![0], first.fills.get('F.Cu')![0]);
  const committed = render(proposed);
  assert.equal(committed.fills.get('F.Cu')![0].props.path, 'abandoned-fill');
  assert.equal(committed.outlines.get('F.Cu')![0].props.path, 'abandoned-outline');
});

test('worker fill frames and preview masks replace affected zones while retaining untouched drawings', () => {
  const render = renderer(),
    basis = fixture(),
    first = render(basis);
  const frame = {
    ...basis,
    copperPaths: new Map([...basis.copperPaths, ['A', 'worker-fill-A']]),
  };
  const filled = render(frame);
  assert.equal(filled.fills.get('F.Cu')![0].props.path, 'worker-fill-A');
  assert.notEqual(filled.fills.get('F.Cu')![0], first.fills.get('F.Cu')![0]);
  assert.equal(filled.fills.get('F.Cu')![1], first.fills.get('F.Cu')![1]);
  assert.equal(filled.fills.get('B.Cu')![0], first.fills.get('B.Cu')![0]);
  assert.equal(filled.outlines, first.outlines);

  const zones: PCBFillPreview['zones'] = basis.copperZones.map((zone) => ({
    ...zone,
    layer: zone.layer as 'F.Cu' | 'B.Cu',
    outline: `preview-outline-${zone.id}`,
    needsMask: zone.id === 'A',
    blockers: zone.id === 'A' ? [{ path: 'M 3 4 L 8 4', strokeWidth: 1 }] : [],
  }));
  const maskedInput = {
    ...frame,
    fillPreview: { changed: true, zones },
    fillPreviewZones: new Map(zones.map((zone) => [zone.id, zone])),
  };
  const masked = render(maskedInput);
  assert.deepEqual(masked.fills.get('F.Cu')![0].props.preview, {
    ...zones[0],
    id: 'test-layout-fill-preview-A',
    boardOutline: 'board-outline',
  });
  assert.equal(masked.fills.get('F.Cu')![1], filled.fills.get('F.Cu')![1]);
  assert.equal(masked.fills.get('B.Cu')![0], filled.fills.get('B.Cu')![0]);
  assert.equal(masked.outlines, first.outlines);
  assert.equal(masked.copper.get('F.Cu')!.props.children[0], masked.fills.get('F.Cu'));

  const settled = render(frame);
  assert.equal(settled.fills.get('F.Cu')![0].props.preview, undefined);
  assert.equal(settled.fills.get('F.Cu')![0].props.path, 'worker-fill-A');
  assert.equal(settled.fills.get('F.Cu')![1], masked.fills.get('F.Cu')![1]);
  assert.equal(settled.fills.get('B.Cu')![0], masked.fills.get('B.Cu')![0]);
  assert.equal(settled.copper.get('F.Cu')!.props.children[0], settled.fills.get('F.Cu'));
});
