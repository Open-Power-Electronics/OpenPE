import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelCadObject } from '../lib/model-cad';
import {
  MODEL_CAD_SELECTION_LIMIT,
  DEFAULT_MODEL_CAD_SELECTION_FILTERS,
  filterModelCadSelection,
  modelCadSelectedBodyIds,
  modelCadSelectableFaceIds,
  modelCadSelectionKey,
  modelCadSelectionEligible,
  modelCadSelectionModeAvailable,
  pruneModelCadSelection,
  updateModelCadSelection,
  type ModelCadSelection,
  type ModelCadSelectionFilters,
} from '../lib/model-cad-selection';

const body = (id = '7d6a9000-0000-4000-a000-000000000001'): ModelCadObject => ({
  id,
  name: 'Body',
  kind: 'box',
  size: { x: 20, y: 16, z: 8 },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  material: 'aluminium',
  opacity: 1,
});

test('presentation topology selection replaces, adds and toggles without mutating or sharing containers', () => {
  const a: ModelCadSelection = { kind: 'body', objectId: 'a' };
  const b: ModelCadSelection = { kind: 'face', objectId: 'b', faceId: 'profile:top' };
  const before = [a];
  const result = updateModelCadSelection(before, b, { additive: true });
  assert.deepEqual(result, [a, b]);
  assert.notEqual(result[0], a);
  assert.notEqual(result[1], b);
  assert.deepEqual(before, [a]);
  assert.deepEqual(updateModelCadSelection(result, a, { additive: true }), [b]);
  assert.deepEqual(updateModelCadSelection(result, a, { additive: true, toggle: false }), [a, b]);
  assert.deepEqual(updateModelCadSelection(result, a), [a]);
  assert.deepEqual(updateModelCadSelection(result, null), []);
  assert.deepEqual(updateModelCadSelection(result, null, { additive: true }), [a, b]);
  assert.notEqual(
    modelCadSelectionKey({ kind: 'line', objectId: 'a', edgeId: 'side:0' }),
    modelCadSelectionKey({ kind: 'edge', objectId: 'a', edgeId: 'side:0' }),
  );
});

test('solid operands contain explicit body selections only, never owning bodies of subentities', () => {
  const selection: ModelCadSelection[] = [
    { kind: 'face', objectId: 'a', faceId: 'profile:top' },
    { kind: 'edge', objectId: 'b', edgeId: 'profile:top:0' },
    { kind: 'line', objectId: 'c', edgeId: 'side:0' },
    { kind: 'body', objectId: 'b' },
    { kind: 'body', objectId: 'd' },
    { kind: 'body', objectId: 'b' },
  ];
  assert.deepEqual(modelCadSelectedBodyIds(selection), ['b', 'd']);
  assert.deepEqual(modelCadSelectedBodyIds(selection.slice(0, 3)), []);
});

test('pruning removes stale topology and distinguishes circular edges from straight lines', () => {
  const object = body();
  const selection: ModelCadSelection[] = [
    { kind: 'body', objectId: object.id },
    { kind: 'face', objectId: object.id, faceId: 'profile:top' },
    { kind: 'face', objectId: object.id, faceId: 'hole:0' },
    { kind: 'edge', objectId: object.id, edgeId: 'hole:top:0' },
    { kind: 'line', objectId: object.id, edgeId: 'hole:top:0' },
    { kind: 'line', objectId: object.id, edgeId: 'side:0' },
    { kind: 'edge', objectId: object.id, edgeId: 'side:8' },
    { kind: 'body', objectId: 'missing' },
  ];
  assert.deepEqual(pruneModelCadSelection(selection, [object]), [
    selection[0],
    selection[1],
    selection[5],
  ]);
  assert.deepEqual(pruneModelCadSelection(selection, [{ ...object }]), [
    selection[0],
    selection[1],
    selection[5],
  ]);
  assert.deepEqual(
    pruneModelCadSelection(selection, [
      { ...object, edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges: ['side:0'] } },
    ]),
    [selection[0], selection[5]],
  );
  assert.deepEqual(pruneModelCadSelection(selection, []), []);
});

test('face identities bound untreated base topology and preserve whole-body selection after treatment', () => {
  assert.equal(modelCadSelectableFaceIds(body()).length, 6);
  const cylinder = { ...body(), kind: 'cylinder' as const, size: { x: 20, y: 20, z: 8 } };
  assert.deepEqual(modelCadSelectableFaceIds(cylinder), [
    'profile:top',
    'profile:bottom',
    'profile:wall',
  ]);
  assert.deepEqual(
    modelCadSelectableFaceIds({
      ...cylinder,
      edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges: ['profile:top:0'] },
    }),
    [],
  );
});

test('selection growth fails explicitly at the presentation bound without losing prior selection', () => {
  const previous: ModelCadSelection[] = Array.from(
    { length: MODEL_CAD_SELECTION_LIMIT },
    (_, index) => ({ kind: 'body', objectId: String(index) }),
  );
  assert.throws(
    () =>
      updateModelCadSelection(previous, { kind: 'body', objectId: 'extra' }, { additive: true }),
    /at most 256/,
  );
  assert.equal(previous.length, MODEL_CAD_SELECTION_LIMIT);
  assert.equal(
    updateModelCadSelection(previous, previous[0], { additive: true }).length,
    MODEL_CAD_SELECTION_LIMIT - 1,
  );
});

const topologySelection: ModelCadSelection[] = [
  { kind: 'body', objectId: 'a' },
  { kind: 'face', objectId: 'a', faceId: 'profile:top' },
  { kind: 'edge', objectId: 'a', edgeId: 'side:0' },
  { kind: 'line', objectId: 'a', edgeId: 'side:0' },
];

test('CAD selection defaults are immutable and each exact kind follows only its own filter', () => {
  assert.ok(Object.isFrozen(DEFAULT_MODEL_CAD_SELECTION_FILTERS));
  assert.deepEqual(DEFAULT_MODEL_CAD_SELECTION_FILTERS, {
    bodies: true,
    faces: true,
    edges: true,
    lines: true,
  });
  assert.equal(Reflect.set(DEFAULT_MODEL_CAD_SELECTION_FILTERS, 'bodies', false), false);
  for (const [index, key] of (['bodies', 'faces', 'edges', 'lines'] as const).entries()) {
    const filters: ModelCadSelectionFilters = {
      bodies: false,
      faces: false,
      edges: false,
      lines: false,
      [key]: true,
    };
    assert.deepEqual(
      topologySelection.map((item) => modelCadSelectionEligible(item, filters)),
      topologySelection.map((_, i) => i === index),
    );
    assert.deepEqual(filterModelCadSelection(topologySelection, filters), [
      topologySelection[index],
    ]);
  }
  assert.equal(DEFAULT_MODEL_CAD_SELECTION_FILTERS.bodies, true);
});

test('selection filters retain eligible entities in independent containers without promotion or mutation', () => {
  const before = structuredClone(topologySelection);
  const filtered = filterModelCadSelection(topologySelection, {
    bodies: false,
    faces: true,
    edges: false,
    lines: true,
  });
  assert.deepEqual(filtered, [topologySelection[1], topologySelection[3]]);
  assert.notEqual(filtered, topologySelection);
  assert.notEqual(filtered[0], topologySelection[1]);
  filtered[0].objectId = 'changed';
  assert.deepEqual(topologySelection, before);
  assert.deepEqual(
    modelCadSelectedBodyIds(filtered),
    [],
    'A retained face/line does not promote its body into solid operands.',
  );
  const all = filterModelCadSelection(topologySelection, DEFAULT_MODEL_CAD_SELECTION_FILTERS);
  assert.deepEqual(all, topologySelection);
  assert.ok(all.every((item, i) => item !== topologySelection[i]));
  assert.deepEqual(
    filterModelCadSelection(topologySelection, {
      bodies: false,
      faces: false,
      edges: false,
      lines: false,
    }),
    [],
  );
});

test('selection mode availability follows its exact category while Auto accepts any eligible kind', () => {
  const none = { bodies: false, faces: false, edges: false, lines: false };
  for (const mode of ['body', 'face', 'edge', 'line', 'auto'] as const) {
    assert.equal(modelCadSelectionModeAvailable(mode, none), false);
    assert.equal(modelCadSelectionModeAvailable(mode, DEFAULT_MODEL_CAD_SELECTION_FILTERS), true);
  }
  for (const [mode, category] of [
    ['body', 'bodies'],
    ['face', 'faces'],
    ['edge', 'edges'],
    ['line', 'lines'],
  ] as const) {
    const filters = { ...none, [category]: true };
    assert.equal(modelCadSelectionModeAvailable('auto', filters), true);
    assert.equal(modelCadSelectionModeAvailable(mode, filters), true);
    for (const other of ['body', 'face', 'edge', 'line'] as const)
      assert.equal(modelCadSelectionModeAvailable(other, filters), other === mode);
  }
});
