import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardLine, BoardZone, Footprint, PCB } from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';
import {
  EMC_REVIEW_CHECKS,
  EMC_REVIEW_DEFAULT_LIMITS,
  EMC_REVIEW_LIMITS,
  reviewEmcLayout,
  validateEmcReviewResult,
  type EmcReviewInput,
} from '../plugins/emc-analysis/domain/review';

const rectangle = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
function outline(id: string, x0: number, y0: number, x1: number, y1: number): BoardLine[] {
  const points = rectangle(x0, y0, x1, y1);
  return points.map((start, index) => ({
    id: `${id}${index}`,
    layer: 'Edge.Cuts',
    width: 0.05,
    start,
    end: points[(index + 1) % points.length],
  }));
}
function board(): PCB {
  return {
    ...createEmptyPCB(),
    nets: [
      { id: 'fast', name: 'Clock' },
      { id: 'victim', name: 'Sense' },
      { id: 'return', name: 'Reference' },
      { id: 'supply', name: 'Supply' },
    ],
    graphics: outline('edge', 0, 0, 20, 20),
    tracks: [
      {
        id: 'critical',
        netId: 'fast',
        layer: 'F.Cu',
        width: 0.4,
        start: { x: 2, y: 2 },
        end: { x: 18, y: 2 },
      },
      {
        id: 'sensitive',
        netId: 'victim',
        layer: 'F.Cu',
        width: 0.6,
        start: { x: 2, y: 3 },
        end: { x: 18, y: 3 },
      },
    ],
  };
}
function input(patch: Partial<EmcReviewInput> = {}): EmcReviewInput {
  return {
    nets: [
      { netId: 'fast', role: 'fast', referenceNetId: 'return', referenceLayer: 'B.Cu' },
      { netId: 'victim', role: 'sensitive' },
    ],
    limits: { ...EMC_REVIEW_DEFAULT_LIMITS },
    decoupling: [],
    edgeConnectorIds: [],
    ...patch,
  };
}
function fill(points = [rectangle(0, 0, 20, 20)]): BoardZone {
  return {
    id: 'plane',
    netId: 'return',
    layer: 'B.Cu',
    outline: rectangle(0, 0, 20, 20),
    clearance: 0.2,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    filledPolygons: points.map((points) => ({ points })),
  };
}
function footprint(
  id: string,
  x: number,
  y: number,
  rotation = 0,
  side: 'front' | 'back' = 'front',
): Footprint {
  return {
    id,
    x,
    y,
    rotation,
    side,
    symbolId: null,
    libraryId: 'Fixture:ExplicitRole',
    graphics: [],
    pads: [],
  };
}
function pad(id: string, x: number, y: number, netId: string) {
  return {
    id,
    number: id,
    x,
    y,
    netId,
    rotation: 0,
    type: 'smd' as const,
    shape: 'rect' as const,
    size: { x: 1, y: 1 },
  };
}
const check = (result: ReturnType<typeof reviewEmcLayout>, id: string) =>
  result.checks.find((entry) => entry.id === id)!;
const findings = (result: ReturnType<typeof reviewEmcLayout>, id: string) =>
  result.findings.filter((entry) => entry.checkId === id);
const close = (actual: number, expected: number, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('EMC review returns original explicit-intent checks with independent edge and copper separation values', () => {
  const pcb = board();
  pcb.zones = [fill()];
  const result = reviewEmcLayout(pcb, input());
  assert.equal(result.completeness, 'partial');
  assert.deepEqual(
    result.checks.map(({ id }) => id),
    EMC_REVIEW_CHECKS.map(({ id }) => id),
  );
  close(findings(result, 'edge-clearance')[0].measured!.value, 1.8);
  close(findings(result, 'net-separation')[0].measured!.value, 0.5);
  assert.equal(check(result, 'reference-fill').status, 'checked');
  assert.equal(findings(result, 'reference-fill').length, 0);
  assert.equal(check(result, 'connector-edge').status, 'not-applicable');
  assert.equal('score' in result, false);
  assert.equal('passed' in result, false);
  assert.deepEqual(result.summary, { warning: 2, info: 0, notVerified: 0 });
});

test('routed budget uses the whole selected-net branch sum independently of native segmentation', () => {
  const pcb = board();
  pcb.tracks.push({ ...pcb.tracks[0], id: 'stub', start: { x: 2, y: 2 }, end: { x: 2, y: 6 } });
  const request = input({
    nets: [{ netId: 'fast', role: 'supply' }],
    limits: { ...EMC_REVIEW_DEFAULT_LIMITS, maxTrackLengthMm: 18 },
  });
  const result = reviewEmcLayout(pcb, request);
  close(findings(result, 'route-length')[0].measured!.value, 20);
  pcb.tracks.splice(
    0,
    1,
    { ...pcb.tracks[0], end: { x: 10, y: 2 } },
    { ...pcb.tracks[0], id: 'second-half', start: { x: 10, y: 2 } },
  );
  close(findings(reviewEmcLayout(pcb, request), 'route-length')[0].measured!.value, 20);
});

test('board cutouts and critical copper radius are included, with missing/open outlines explicitly unverified', () => {
  const pcb = board();
  pcb.graphics.push(...outline('cutout', 8, 1, 12, 3));
  const result = reviewEmcLayout(pcb, input());
  const finding = findings(result, 'edge-clearance')[0];
  assert.match(finding.title, /outside the board surface/);
  close(finding.measured!.value, -0.2);
  pcb.graphics = [];
  assert.equal(check(reviewEmcLayout(pcb, input()), 'edge-clearance').status, 'not-verified');
  pcb.graphics = outline('edge', 0, 0, 20, 20).slice(0, 3);
  assert.equal(check(reviewEmcLayout(pcb, input()), 'edge-clearance').status, 'not-verified');
});

test('crossed board outlines never establish checked edge geometry', () => {
  const pcb = board();
  const points = [
    { x: 0, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
    { x: 20, y: 0 },
  ];
  pcb.graphics = points.map((start, index) => ({
    id: `cross${index}`,
    layer: 'Edge.Cuts',
    width: 0.05,
    start,
    end: points[(index + 1) % 4],
  }));
  assert.equal(check(reviewEmcLayout(pcb, input()), 'edge-clearance').status, 'not-verified');
});

test('same-layer separation includes crossings but does not infer broadside coupling', () => {
  const pcb = board();
  pcb.tracks[1].start = { x: 10, y: 0 };
  pcb.tracks[1].end = { x: 10, y: 10 };
  close(findings(reviewEmcLayout(pcb, input()), 'net-separation')[0].measured!.value, -0.5);
  pcb.tracks[1].layer = 'B.Cu';
  const result = reviewEmcLayout(pcb, input());
  assert.equal(findings(result, 'net-separation').length, 0);
  assert.match(check(result, 'net-separation').notes.join(' '), /broadside/);
});

test('reference coverage partitions all saved-fill hole crossings and reports exact uncovered length', () => {
  const pcb = board();
  pcb.zones = [
    fill([
      rectangle(0, 0, 8, 20),
      rectangle(12, 0, 20, 20),
      rectangle(8, 0, 12, 1),
      rectangle(8, 3, 12, 20),
    ]),
  ];
  const result = reviewEmcLayout(pcb, input());
  const gap = findings(result, 'reference-fill')[0];
  close(gap.measured!.value, 4);
  assert.equal(gap.confidence, 'limited');
  close(gap.location!.x, 10);
  close(gap.location!.y, 2);
  assert.match(gap.message, /connectivity are not established/);
  // A gap much smaller than a conventional sampling interval is still found.
  pcb.zones = [fill([rectangle(0, 0, 8, 20), rectangle(8.0002, 0, 20, 20)])];
  close(findings(reviewEmcLayout(pcb, input()), 'reference-fill')[0].measured!.value, 0.0002);
});

test('reference evidence distinguishes missing, disabled, completed-empty and same-layer copper', () => {
  const pcb = board();
  for (const zones of [
    [],
    [{ ...fill(), filledPolygons: undefined }],
    [{ ...fill(), fillEnabled: false }],
  ]) {
    pcb.zones = zones;
    const result = reviewEmcLayout(pcb, input());
    assert.equal(check(result, 'reference-fill').status, 'not-verified');
    assert.equal(findings(result, 'reference-fill')[0].severity, 'not-verified');
  }
  pcb.zones = [fill([])];
  const empty = reviewEmcLayout(pcb, input());
  assert.equal(check(empty, 'reference-fill').status, 'checked');
  close(findings(empty, 'reference-fill')[0].measured!.value, 16);
  pcb.zones = [{ ...fill(), layer: 'F.Cu' }];
  const same = reviewEmcLayout(
    pcb,
    input({
      nets: [{ netId: 'fast', role: 'fast', referenceNetId: 'return', referenceLayer: 'F.Cu' }],
    }),
  );
  assert.equal(check(same, 'reference-fill').status, 'not-verified');
});

test('reference evidence declares canonical fill precision instead of claiming native subgrid coverage', () => {
  const pcb = board();
  pcb.tracks[0].start = { x: 1, y: 5 };
  pcb.tracks[0].end = { x: 9, y: 5 };
  pcb.zones = [fill([rectangle(0, 0, 4, 20), rectangle(4.00004, 0, 20, 20)])];
  const result = reviewEmcLayout(pcb, input());
  assert.equal(findings(result, 'reference-fill').length, 0);
  assert.match(check(result, 'reference-fill').notes.join(' '), /0\.0001 mm normalization grid/);
  assert.match(
    check(result, 'reference-fill').notes.join(' '),
    /Smaller native gaps are not resolved/,
  );
});

test('user geometric budgets are compared without an implicit tolerance that changes their limit', () => {
  const request = input({
    limits: { ...EMC_REVIEW_DEFAULT_LIMITS, minNetSeparationMm: 0.50000000001 },
  });
  assert.equal(findings(reviewEmcLayout(board(), request), 'net-separation').length, 1);
  request.limits.minNetSeparationMm = 0.5;
  assert.equal(findings(reviewEmcLayout(board(), request), 'net-separation').length, 0);
});

test('footprint-owned rotated saved fills provide world-space reference evidence without changing bytes', () => {
  const pcb = board();
  const plane = footprint('plane-owner', 0, 20, 90, 'back');
  plane.zones = [fill()];
  pcb.footprints = [plane];
  const original = JSON.stringify(pcb);
  const result = reviewEmcLayout(pcb, input());
  assert.equal(findings(result, 'reference-fill').length, 0);
  assert.equal(check(result, 'reference-fill').status, 'checked');
  assert.equal(JSON.stringify(pcb), original);
});

test('reference-via spacing measures only the explicit reference net and preserves its limited claim', () => {
  const pcb = board();
  pcb.vias = [
    { id: 'signal-via', netId: 'fast', x: 10, y: 2, diameter: 0.6, drill: 0.3 },
    { id: 'wrong-nearby', netId: 'supply', x: 10.1, y: 2, diameter: 0.6, drill: 0.3 },
    { id: 'reference-via', netId: 'return', x: 13, y: 6, diameter: 0.6, drill: 0.3 },
  ];
  const result = reviewEmcLayout(
    pcb,
    input({ limits: { ...EMC_REVIEW_DEFAULT_LIMITS, maxVias: 0 } }),
  );
  close(findings(result, 'reference-vias')[0].measured!.value, 5);
  assert.equal(findings(result, 'via-budget')[0].measured!.value, 1);
  assert.equal(findings(result, 'reference-vias')[0].confidence, 'limited');
  pcb.vias[2].x = 11;
  pcb.vias[2].y = 2;
  assert.equal(findings(reviewEmcLayout(pcb, input()), 'reference-vias').length, 0);
  pcb.vias = pcb.vias.filter((via) => via.netId !== 'return');
  assert.equal('measured' in findings(reviewEmcLayout(pcb, input()), 'reference-vias')[0], false);
});

test('decoupling assignments use exact supply/reference pads and native rotation, never footprint names', () => {
  const pcb = board();
  const target = footprint('target', 10, 10, 90, 'back');
  target.pads = [pad('supply-pad', 0, 0, 'supply')];
  const capacitor = footprint('explicit-cap', 10, 10, 90, 'back');
  capacitor.pads = [pad('cap-supply', 0, 8, 'supply'), pad('cap-return', 0, 9, 'return')];
  pcb.footprints = [target, capacitor];
  const request = input({
    nets: [],
    decoupling: [
      { targetPadId: 'supply-pad', capacitorFootprintId: 'explicit-cap', referenceNetId: 'return' },
    ],
  });
  const result = reviewEmcLayout(pcb, request);
  close(findings(result, 'decoupling-distance')[0].measured!.value, 8);
  assert.deepEqual(findings(result, 'decoupling-distance')[0].location, { x: 10, y: 10 });
  capacitor.pads[1].netId = 'victim';
  const missing = reviewEmcLayout(pcb, request);
  assert.equal(check(missing, 'decoupling-distance').status, 'not-verified');
  assert.equal(findings(missing, 'decoupling-distance')[0].severity, 'not-verified');
});

test('edge-intended connectors use rotated pad centers and require explicit mechanical intent', () => {
  const pcb = board();
  const connector = footprint('connector', 10, 10, 90, 'back');
  connector.pads = [pad('connector-pad', 0, 0, 'supply')];
  pcb.footprints = [connector];
  const request = input({
    nets: [],
    edgeConnectorIds: ['connector'],
    limits: { ...EMC_REVIEW_DEFAULT_LIMITS, maxConnectorEdgeDistanceMm: 3 },
  });
  close(findings(reviewEmcLayout(pcb, request), 'connector-edge')[0].measured!.value, 10);
  connector.pads[0].x = 9;
  assert.equal(findings(reviewEmcLayout(pcb, request), 'connector-edge').length, 0);
  connector.pads[0].x = 12;
  assert.match(findings(reviewEmcLayout(pcb, request), 'connector-edge')[0].title, /outside/);
  connector.pads.push(pad('inside-pad', 0, 9.5, 'supply'));
  const outside = findings(reviewEmcLayout(pcb, request), 'connector-edge')[0];
  close(outside.measured!.value, -2);
  assert.deepEqual(outside.location, { x: 10, y: -2 });
  assert.equal(check(reviewEmcLayout(pcb, input()), 'connector-edge').status, 'not-applicable');
});

test('schema rejects unknown/duplicate/stale intents, nonfinite budgets, invalid references and all-empty review', () => {
  const pcb = board();
  for (const invalid of [
    { ...input(), path: 'private.kicad_pcb' },
    { ...input(), limits: { ...input().limits, minEdgeClearanceMm: NaN } },
    { ...input(), limits: { ...input().limits, maxVias: 1.5 } },
    { ...input(), nets: [{ netId: 'missing', role: 'fast' }] },
    {
      ...input(),
      nets: [
        { netId: 'fast', role: 'fast' },
        { netId: 'fast', role: 'supply' },
      ],
    },
    { ...input(), nets: [{ netId: 'fast', role: 'fast', referenceNetId: 'fast' }] },
    { ...input(), nets: [{ netId: 'fast', role: 'fast', referenceLayer: 'In1.Cu' }] },
    { ...input(), nets: [] },
    { ...input(), edgeConnectorIds: ['missing'] },
    {
      ...input(),
      decoupling: [
        { targetPadId: 'missing', capacitorFootprintId: 'missing', referenceNetId: 'return' },
      ],
    },
  ])
    assert.throws(() => reviewEmcLayout(pcb, invalid));
});

test('results, findings and returned input are detached while mutable and caller-frozen boards stay fresh', () => {
  const pcb = board(),
    request = input();
  pcb.zones = [fill()];
  const before = JSON.stringify({ pcb, request });
  const result = reviewEmcLayout(pcb, request);
  assert.equal(JSON.stringify({ pcb, request }), before);
  result.input.nets[0].role = 'supply';
  result.findings[0].objectIds.length = 0;
  result.checks[0].notes[0] = 'changed';
  assert.deepEqual(reviewEmcLayout(pcb, request).summary, { warning: 2, info: 0, notVerified: 0 });
  Object.freeze(pcb);
  pcb.tracks[0].start.y = 8;
  pcb.tracks[0].end.y = 8;
  assert.equal(findings(reviewEmcLayout(pcb, request), 'edge-clearance').length, 1);
  // The remaining edge finding is on the right endpoint x=18, not a stale y=2 measurement.
  close(findings(reviewEmcLayout(pcb, request), 'edge-clearance')[0].measured!.value, 1.8);
});

test('bounded findings preserve exact counts with honest truncation and bounded work fails without a partial result', () => {
  const pcb = board();
  pcb.tracks = Array.from({ length: 510 }, (_, index) => ({
    ...pcb.tracks[0],
    id: `track${index}`,
  }));
  const result = reviewEmcLayout(pcb, input({ nets: [{ netId: 'fast', role: 'fast' }] }));
  assert.equal(result.truncated, true);
  assert.equal(result.findings.length, EMC_REVIEW_LIMITS.findings);
  assert.equal(result.summary.warning, 511);
  assert.equal(result.summary.notVerified, 1);
  assert.equal(result.findings.filter((finding) => finding.severity === 'warning').length, 500);
  const overloaded = board();
  overloaded.tracks = [
    ...Array.from({ length: 1500 }, (_, index) => ({
      ...overloaded.tracks[0],
      id: `source${index}`,
    })),
    ...Array.from({ length: 1500 }, (_, index) => ({
      ...overloaded.tracks[1],
      id: `target${index}`,
    })),
  ];
  assert.throws(() => reviewEmcLayout(overloaded, input()), /bounded geometry work limit/);
});

test('review result validator rejects fabricated counters, stale check catalogs, unknown data and aliased containers', () => {
  const result = reviewEmcLayout(board(), input());
  const copy = validateEmcReviewResult(result);
  assert.notEqual(copy, result);
  assert.notEqual(copy.findings, result.findings);
  assert.throws(
    () => validateEmcReviewResult({ ...result, summary: { ...result.summary, warning: 0 } }),
    /summary/,
  );
  assert.throws(
    () => validateEmcReviewResult({ ...result, unexpected: true }),
    /Invalid EMC review result/,
  );
  const duplicate = structuredClone(result);
  duplicate.checks[1] = duplicate.checks[0];
  assert.throws(() => validateEmcReviewResult(duplicate), /catalog/);
  const finding = structuredClone(result);
  finding.findings[0].category = 'connectors';
  assert.throws(() => validateEmcReviewResult(finding), /category/);
  const status = structuredClone(result);
  status.checks.find((entry) => entry.id === 'edge-clearance')!.status = 'not-applicable';
  assert.throws(() => validateEmcReviewResult(status), /check status/);
  const intent = structuredClone(result);
  intent.input.nets = [];
  assert.throws(() => validateEmcReviewResult(intent), /Declare at least one/);
});
