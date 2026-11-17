import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCircuit, snap, type Circuit, type Point, type Wire } from '../lib/circuit';
import { parseSExpr } from '../lib/sexpr';
import {
  createSchematicWireTargetResolver,
  snapSchematicWireTarget,
  visibleSchematicPins,
} from '../lib/schematic-wire-target';

const grid = (point: Point) => ({ x: snap(point.x), y: snap(point.y) });
function withWire(wire: Wire) {
  const doc = emptyCircuit();
  doc.wires.push(wire);
  return doc;
}
function pinFixture(): Circuit {
  const doc = emptyCircuit();
  doc.parts = [
    {
      id: 'part',
      libId: 'Test:Pins',
      ref: 'U1',
      value: 'Pins',
      x: 10,
      y: 20,
      rotation: 90,
      mirror: 'y',
    },
  ];
  doc.libraries['Test:Pins'] = parseSExpr(`(symbol "Test:Pins"
    (symbol "Pins_0_1" (pin passive line (at 0 0 0) (length 1)))
    (symbol "Pins_1_1"
      (pin passive line (at 2 1 0) (length 1))
      (pin passive line (at 4 1 0) (length 1) hide)
      (pin passive line (at 6 1 0) (length 1) (hide yes)))
    (symbol "Pins_2_1" (pin passive line (at 20 10 0) (length 1))))`);
  return doc;
}

test('unmagnetized wire placement falls back to the fixed 1.27 mm grid', () => {
  const doc = emptyCircuit(),
    raw = { x: 1.6, y: -2.1 };
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(), raw, 0.5), { x: 1.27, y: -2.54 });
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(), raw, 0), grid(raw));
});

test('horizontal wire interiors retain their off-grid Y and use a grid tangential coordinate within the segment', () => {
  const doc = withWire({ id: 'wire', a: { x: 0.111, y: 2.343 }, b: { x: 10.333, y: 2.343 } }),
    raw = { x: 5.3, y: 2.4 };
  // Wire eligibility uses perpendicular distance, even when tangential grid
  // rounding moves farther than the zoom-aware magnetic tolerance.
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), raw, 0.1), {
    x: 5.08,
    y: 2.343,
  });
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), raw, 0.01), grid(raw));
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), { x: 5.3, y: 2.343 }, 0), {
    x: 5.08,
    y: 2.343,
  });
  for (let index = 0; index < 16; index++) {
    const x = 2.111 + index * 0.271;
    assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), { x, y: 2.343 }, 0), {
      x: snap(x),
      y: 2.343,
    });
  }
});

test('vertical wire interiors retain native X in either endpoint order', () => {
  for (const reverse of [false, true]) {
    const a = { x: 7.111, y: 0.333 },
      b = { x: 7.111, y: 10.777 },
      doc = withWire({ id: 'wire', a: reverse ? b : a, b: reverse ? a : b });
    assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), { x: 7.19, y: 5.4 }, 0.1), {
      x: 7.111,
      y: 5.08,
    });
  }
});

test('short segments use exact projection when tangential grid rounding would leave the native segment', () => {
  const doc = withWire({ id: 'wire', a: { x: 0.3, y: 2.25 }, b: { x: 0.6, y: 2.25 } });
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), { x: 0.35, y: 2.3 }, 0.1), {
    x: 0.35,
    y: 2.25,
  });
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), { x: 0.7, y: 2.25 }, 0.1), {
    x: 0.6,
    y: 2.25,
  });
});

test('diagonal interiors use exact projection instead of grid-rounded coordinates', () => {
  const doc = withWire({ id: 'wire', a: { x: 0.1, y: 0.2 }, b: { x: 3.1, y: 4.2 } }),
    raw = { x: 1.5, y: 2.2 },
    target = snapSchematicWireTarget(doc, new Set(['wire']), raw, 0.2);
  assert.ok(Math.abs(target.x - 1.564) < 1e-12);
  assert.ok(Math.abs(target.y - 2.152) < 1e-12);
  assert.ok(Math.abs((target.x - 0.1) * 4 - (target.y - 0.2) * 3) < 1e-12);
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), raw, 0.01), grid(raw));
});

test('nearest geometric targets win, with exact anchors preferred over wire projections at equal distances', () => {
  const doc = withWire({ id: 'lower', a: { x: -5, y: -1 }, b: { x: 5, y: -1 } });
  doc.labels = [{ id: 'label', x: 0, y: 1, text: 'SIGNAL' }];
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['lower', 'label']), { x: 0, y: 0 }, 1), {
    x: 0,
    y: 1,
  });
  doc.wires.push({ id: 'closer', a: { x: -5, y: 0.2 }, b: { x: 5, y: 0.2 } });
  assert.deepEqual(
    snapSchematicWireTarget(doc, new Set(['lower', 'label', 'closer']), { x: 0, y: 0 }, 1),
    { x: 0, y: 0.2 },
  );
  doc.labels.push({ id: 'closest', x: 0.01, y: 0, text: 'NEAR' });
  assert.deepEqual(
    snapSchematicWireTarget(
      doc,
      new Set(['lower', 'label', 'closer', 'closest']),
      { x: 0, y: 0 },
      1,
    ),
    { x: 0.01, y: 0 },
  );
});

test('labels and junctions override tangential grid snapping when exactly under the pointer', () => {
  const doc = withWire({ id: 'wire', a: { x: 7.111, y: 0.333 }, b: { x: 7.111, y: 10.777 } });
  doc.labels = [{ id: 'label', x: 7.111, y: 5.4, text: 'SIGNAL' }];
  doc.junctions = [{ id: 'junction', x: 7.111, y: 6.6 }];
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire', 'label']), doc.labels[0], 0), {
    x: 7.111,
    y: 5.4,
  });
  assert.deepEqual(
    snapSchematicWireTarget(doc, new Set(['wire', 'junction']), doc.junctions[0], 0),
    { x: 7.111, y: 6.6 },
  );
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), doc.labels[0], 0), {
    x: 7.111,
    y: 5.08,
  });
});

test('pin magnets follow selected-unit rotation and mirror transforms while omitting hidden pins and other units', () => {
  const doc = pinFixture(),
    visible = new Set(['part']);
  assert.deepEqual(snapSchematicWireTarget(doc, visible, { x: 11.04, y: 18.06 }, 0.1), {
    x: 11,
    y: 18,
  });
  assert.deepEqual(snapSchematicWireTarget(doc, visible, { x: 10.04, y: 20.06 }, 0.1), {
    x: 10,
    y: 20,
  });
  for (const raw of [
    { x: 11.04, y: 16.06 },
    { x: 11.04, y: 14.06 },
    { x: 20.03, y: 0.02 },
  ])
    assert.deepEqual(snapSchematicWireTarget(doc, visible, raw, 0.1), grid(raw));
  const second = structuredClone(doc);
  second.parts[0].unit = 2;
  assert.deepEqual(snapSchematicWireTarget(second, visible, { x: 20.03, y: 0.02 }, 0.1), {
    x: 20,
    y: 0,
  });
});

test('shared visible-pin geometry retains native selected-unit pin indexes after hiding pins and transforming the symbol', () => {
  const doc = pinFixture(),
    part = doc.parts[0],
    before = structuredClone(doc);
  assert.deepEqual(visibleSchematicPins(part, doc.libraries[part.libId]), [
    { point: { x: 10, y: 20 }, index: 0 },
    { point: { x: 11, y: 18 }, index: 1 },
  ]);
  const second = { ...part, unit: 2 };
  assert.deepEqual(visibleSchematicPins(second, doc.libraries[second.libId]), [
    { point: { x: 10, y: 20 }, index: 0 },
    { point: { x: 20, y: 0 }, index: 1 },
  ]);
  const interleaved = parseSExpr(`(symbol "Test:Interleaved" (symbol "Interleaved_1_1"
    (pin passive line (at 0 0 0) (length 1) hide)
    (pin passive line (at 2 1 0) (length 1))
    (pin passive line (at 4 1 0) (length 1) (hide yes))
    (pin passive line (at 6 1 0) (length 1))))`);
  assert.deepEqual(visibleSchematicPins(part, interleaved), [
    { point: { x: 11, y: 18 }, index: 1 },
    { point: { x: 11, y: 14 }, index: 3 },
  ]);
  assert.deepEqual(doc, before);
});

test('hidden symbols, wires, labels and junctions cannot contribute magnetic targets', () => {
  const doc = pinFixture(),
    pinRaw = { x: 11.04, y: 18.06 };
  assert.deepEqual(
    snapSchematicWireTarget(doc, new Set(['field/part/Reference']), pinRaw, 0.1),
    grid(pinRaw),
  );
  doc.wires = [{ id: 'wire', a: { x: 0.111, y: 2.343 }, b: { x: 10.333, y: 2.343 } }];
  doc.labels = [{ id: 'label', x: 12.34, y: 23.45, text: 'SIGNAL' }];
  doc.junctions = [{ id: 'junction', x: 34.56, y: 45.67 }];
  for (const raw of [
    { x: 5.3, y: 2.4 },
    { x: 12.35, y: 23.46 },
    { x: 34.57, y: 45.68 },
  ])
    assert.deepEqual(snapSchematicWireTarget(doc, new Set(), raw, 0.1), grid(raw));
});

test('off-grid endpoints, segment boundaries and degenerate wires remain exact anchor targets', () => {
  const doc = withWire({ id: 'wire', a: { x: 0.111, y: 2.343 }, b: { x: 10.333, y: 2.343 } });
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), { x: 10.38, y: 2.4 }, 0.1), {
    x: 10.333,
    y: 2.343,
  });
  doc.wires.push({ id: 'point', a: { x: 2.34, y: 3.45 }, b: { x: 2.34, y: 3.45 } });
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['point']), { x: 2.4, y: 3.5 }, 0.1), {
    x: 2.34,
    y: 3.45,
  });
  assert.deepEqual(
    snapSchematicWireTarget(doc, new Set(['point']), { x: 2.4, y: 3.5 }, 0.01),
    grid({ x: 2.4, y: 3.5 }),
  );
});

test('tolerance boundaries are inclusive and points outside the tolerance fall back to the grid', () => {
  const doc = emptyCircuit();
  doc.labels = [{ id: 'anchor', x: 1.125, y: 2.25, text: 'ANCHOR' }];
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['anchor']), { x: 1.25, y: 2.25 }, 0.125), {
    x: 1.125,
    y: 2.25,
  });
  assert.deepEqual(
    snapSchematicWireTarget(doc, new Set(['anchor']), { x: 1.25, y: 2.25 }, 0.124999),
    grid({ x: 1.25, y: 2.25 }),
  );
  doc.wires.push({ id: 'wire', a: { x: 1.125, y: 2.25 }, b: { x: 8.125, y: 2.25 } });
  assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), { x: 5.1, y: 2.375 }, 0.125), {
    x: 5.08,
    y: 2.25,
  });
  assert.deepEqual(
    snapSchematicWireTarget(doc, new Set(['wire']), { x: 5.1, y: 2.375 }, 0.124999),
    grid({ x: 5.1, y: 2.375 }),
  );
});

test('distant geometry does not affect exact boundary, diagonal, endpoint or tied targets', () => {
  const local = pinFixture();
  local.wires = [
    { id: 'diagonal', a: { x: -4, y: -2 }, b: { x: 2, y: 6 } },
    { id: 'horizontal', a: { x: -8, y: 3.25 }, b: { x: -2, y: 3.25 } },
    { id: 'vertical', a: { x: 4.125, y: -8 }, b: { x: 4.125, y: -2 } },
    { id: 'point', a: { x: -3.5, y: -3.5 }, b: { x: -3.5, y: -3.5 } },
  ];
  local.labels = [{ id: 'label', x: -5.125, y: 3.5, text: 'TIE' }];
  const crowded = structuredClone(local);
  for (let index = 0; index < 400; index++) {
    const x = 100 + (index % 20) * 12.7,
      y = 100 + Math.floor(index / 20) * 12.7;
    crowded.wires.push({ id: `far-${index}`, a: { x, y }, b: { x: x + 5, y: y + 7 } });
    crowded.labels.push({ id: `far-label-${index}`, x, y, text: 'FAR' });
  }
  const targets = (doc: Circuit) =>
      new Set([...doc.parts, ...doc.wires, ...doc.labels].map((item) => item.id)),
    resolveLocal = createSchematicWireTargetResolver(local, targets(local)),
    resolveCrowded = createSchematicWireTargetResolver(crowded, targets(crowded));
  const cases = [
    { raw: { x: -1, y: 2 }, expected: { x: -1, y: 2 }, tolerance: 0 },
    { raw: { x: -1.125, y: 2 }, expected: { x: -1.045, y: 1.94 }, tolerance: 0.125 },
    { raw: { x: -5.125, y: 3.375 }, expected: { x: -5.125, y: 3.5 }, tolerance: 0.125 },
    { raw: { x: 4.25, y: -4.1 }, expected: { x: 4.125, y: -3.81 }, tolerance: 0.125 },
    { raw: { x: -3.375, y: -3.5 }, expected: { x: -3.5, y: -3.5 }, tolerance: 0.125 },
    { raw: { x: 11.04, y: 18.06 }, expected: { x: 11, y: 18 }, tolerance: 0.1 },
  ];
  for (const { raw, expected, tolerance } of cases) {
    const actual = resolveCrowded(raw, tolerance);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-12, JSON.stringify({ raw, actual, expected }));
    assert.ok(Math.abs(actual.y - expected.y) < 1e-12, JSON.stringify({ raw, actual, expected }));
    for (const radius of [0, 0.01, tolerance, 0.5, 2])
      assert.deepEqual(resolveCrowded(raw, radius), resolveLocal(raw, radius));
  }
});

test('zero-tolerance diagonal projections retain floating-point endpoint rounding', () => {
  for (const reverse of [false, true]) {
    const endpoints = [
        { x: 10, y: 10 },
        { x: 0.1, y: 0.2 },
      ],
      a = endpoints[reverse ? 1 : 0],
      b = endpoints[reverse ? 0 : 1],
      doc = withWire({ id: 'wire', a, b }),
      raw = { x: a.x + (b.x - a.x), y: a.y + (b.y - a.y) };
    assert.deepEqual(snapSchematicWireTarget(doc, new Set(['wire']), raw, 0), raw);
  }
});

test('snapping preserves the document, caller point and anchor storage', () => {
  const doc = pinFixture(),
    before = structuredClone(doc),
    raw = { x: 11.04, y: 18.06 },
    result = snapSchematicWireTarget(doc, new Set(['part']), raw, 0.1);
  result.x = 999;
  assert.deepEqual(doc, before);
  assert.deepEqual(raw, { x: 11.04, y: 18.06 });
});

test('temporarily disabling magnetic snapping retains the fixed grid near pins and wire interiors', () => {
  const doc = pinFixture();
  doc.wires = [{ id: 'wire', a: { x: 0.111, y: 2.343 }, b: { x: 10.333, y: 2.343 } }];
  const visible = new Set(['part', 'wire']),
    resolve = createSchematicWireTargetResolver(doc, visible);
  for (const raw of [
    { x: 11.04, y: 18.06 },
    { x: 5.3, y: 2.4 },
    { x: 10.38, y: 2.4 },
  ]) {
    assert.notDeepEqual(resolve(raw, 0.1), grid(raw));
    assert.deepEqual(resolve(raw, 0.1, false), grid(raw));
    assert.deepEqual(snapSchematicWireTarget(doc, visible, raw, 0.1, false), grid(raw));
    assert.deepEqual(resolve(raw, 0.1), snapSchematicWireTarget(doc, visible, raw, 0.1));
  }
  // Disabling magnetism does not make an exact grid-coincident connection false.
  doc.labels = [{ id: 'grid-label', x: 12.7, y: 25.4, text: 'SIGNAL' }];
  assert.deepEqual(
    snapSchematicWireTarget(doc, new Set(['grid-label']), { x: 12.7, y: 25.4 }, 1, false),
    { x: 12.7, y: 25.4 },
  );
});

test('prepared targets own their geometry and results until explicitly rebuilt for a changed document or visibility', () => {
  const doc = pinFixture();
  doc.wires = [{ id: 'wire', a: { x: 0.111, y: 2.343 }, b: { x: 10.333, y: 2.343 } }];
  doc.labels = [{ id: 'label', x: 12.34, y: 23.45, text: 'SIGNAL' }];
  const visible = new Set(['part', 'wire', 'label']),
    resolve = createSchematicWireTargetResolver(doc, visible),
    points = [
      { x: 11.04, y: 18.06 },
      { x: 5.3, y: 2.4 },
      { x: 12.35, y: 23.46 },
    ],
    expected = points.map((raw) => resolve(raw, 0.1));
  resolve(points[0], 0.1).x = 999;
  doc.parts[0].x += 100;
  doc.wires[0].a.y = 200;
  doc.wires[0].b.y = 200;
  doc.labels[0].x += 100;
  visible.clear();
  for (let index = 0; index < points.length; index++)
    assert.deepEqual(resolve(points[index], 0.1), expected[index]);
  const changed = createSchematicWireTargetResolver(doc, visible);
  for (const raw of points) assert.deepEqual(changed(raw, 0.1), grid(raw));
});

test('prepared targets reuse transformed symbol geometry across pointer samples', () => {
  const doc = pinFixture(),
    libraries = doc.libraries;
  let libraryReads = 0;
  doc.libraries = new Proxy(libraries, {
    get(target, key, receiver) {
      libraryReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const resolve = createSchematicWireTargetResolver(doc, new Set(['part'])),
    preparedReads = libraryReads;
  assert.ok(preparedReads > 0);
  for (let index = 0; index < 100; index++) {
    assert.deepEqual(resolve({ x: 11.04, y: 18.06 }, 0.1), { x: 11, y: 18 });
    resolve({ x: index, y: index / 2 }, 0.1);
  }
  assert.equal(libraryReads, preparedReads, 'Pointer samples never reread or transform libraries.');
});

test('nonfinite coordinates and invalid tolerances fail before examining document geometry', () => {
  const doc = emptyCircuit(),
    resolve = createSchematicWireTargetResolver(doc, new Set());
  for (const raw of [
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
    { x: -Infinity, y: 0 },
  ])
    assert.throws(
      () => snapSchematicWireTarget(doc, new Set(), raw, 0.1),
      /coordinates must be finite/,
    );
  for (const magnetic of [true, false]) {
    assert.throws(() => resolve({ x: NaN, y: 0 }, 0.1, magnetic), /coordinates must be finite/);
    assert.throws(() => resolve({ x: 0, y: 0 }, -1, magnetic), /nonnegative/);
  }
  for (const tolerance of [NaN, Infinity, -0.1])
    assert.throws(
      () => snapSchematicWireTarget(doc, new Set(), { x: 0, y: 0 }, tolerance),
      /nonnegative/,
    );
});
