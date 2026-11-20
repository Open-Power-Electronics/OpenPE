import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCapabilitySchema } from '../api/capability-schema';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { BoardZone, PCB } from '../lib/pcb';
import {
  EMC_LAYOUT_INPUT_SCHEMA,
  EMC_LAYOUT_LIMITS,
  inspectEmcLayout,
  type EmcLayoutInput,
} from '../plugins/emc-analysis/domain/layout';

function board(): PCB {
  return {
    ...createEmptyPCB(),
    nets: [
      { id: 'clock', name: 'CLK' },
      { id: 'ground', name: 'GND' },
      { id: 'empty', name: 'Unrouted' },
    ],
    tracks: [
      {
        id: 'diagonal',
        netId: 'clock',
        start: { x: 10, y: 20 },
        end: { x: 13, y: 24 },
        width: 0.25,
        layer: 'F.Cu',
        locked: true,
      },
      {
        id: 'backside',
        netId: 'clock',
        start: { x: 13, y: 24 },
        end: { x: 13, y: 36 },
        width: 0.25,
        layer: 'B.Cu',
      },
      {
        id: 'other-net',
        netId: 'ground',
        start: { x: -100, y: 0 },
        end: { x: 100, y: 0 },
        width: 0.5,
        layer: 'F.Cu',
      },
    ],
    vias: [
      { id: 'clock-via', netId: 'clock', x: 13, y: 24, diameter: 0.6, drill: 0.3 },
      { id: 'ground-via', netId: 'ground', x: 0, y: 0, diameter: 0.6, drill: 0.3 },
    ],
    footprints: [
      {
        id: 'device',
        symbolId: null,
        libraryId: 'Test:Device',
        x: 100,
        y: -10,
        rotation: 90,
        side: 'back',
        graphics: [],
        pads: [
          {
            id: 'clock-pad',
            number: '1',
            x: 1,
            y: 2,
            rotation: 30,
            type: 'smd',
            shape: 'rect',
            size: { x: 1, y: 2 },
            netId: 'clock',
          },
          {
            id: 'unassigned-pad',
            number: '2',
            x: 2,
            y: 2,
            rotation: 0,
            type: 'smd',
            shape: 'rect',
            size: { x: 1, y: 2 },
            netId: null,
          },
        ],
      },
    ],
  };
}

function zone(id: string, netId = 'clock'): BoardZone {
  return {
    id,
    netId,
    layer: 'F.Cu',
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    clearance: 0.2,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  };
}

const input: EmcLayoutInput = { netIds: ['clock'], segmentBudgetMm: 5 };

test('EMC layout inspection measures native straight segments and counts selected-net records', () => {
  const result = inspectEmcLayout(board(), input);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.segmentBudgetMm, 5);
  assert.deepEqual(result.nets, [
    {
      netId: 'clock',
      netName: 'CLK',
      totalTrackLengthMm: 17,
      longestSegmentMm: 12,
      trackCount: 2,
      viaCount: 1,
      padCount: 1,
      enabledZoneCount: 0,
      filledZoneCount: 0,
      missingFillZoneCount: 0,
      missingFillZoneIds: [],
      missingFillZoneIdsTruncated: false,
      segmentsOverBudgetCount: 1,
      segmentsOverBudget: [
        {
          trackId: 'backside',
          layer: 'B.Cu',
          lengthMm: 12,
          start: { x: 13, y: 24 },
          end: { x: 13, y: 36 },
        },
      ],
      segmentsTruncated: false,
    },
  ]);
  assert.match(result.notVerified.join(' '), /Return-path continuity.*current-loop area/);
  assert.match(result.notVerified.join(' '), /field emissions, coupling and compliance/);
  assert.equal(Object.hasOwn(result, 'pass'), false);
  assert.equal(Object.hasOwn(result, 'score'), false);
});

test('EMC lengths include disconnected branches and stubs without implying route continuity', () => {
  const pcb = board();
  pcb.tracks.push({
    ...pcb.tracks[0],
    id: 'isolated-stub',
    start: { x: 100, y: 0 },
    end: { x: 108, y: 0 },
  });
  const result = inspectEmcLayout(pcb, input);
  assert.equal(result.nets[0].totalTrackLengthMm, 25);
  assert.equal(result.nets[0].trackCount, 3);
  assert.deepEqual(
    result.nets[0].segmentsOverBudget.map(({ trackId }) => trackId),
    ['backside', 'isolated-stub'],
  );
  assert.match(result.notVerified.join(' '), /not source-to-load path lengths/);
});

test('EMC reports follow explicit selected-net order and preserve zero-track evidence', () => {
  const result = inspectEmcLayout(board(), {
    netIds: ['empty', 'ground', 'clock'],
    segmentBudgetMm: 200,
  });
  assert.deepEqual(
    result.nets.map(({ netId }) => netId),
    ['empty', 'ground', 'clock'],
  );
  assert.equal(result.nets[0].totalTrackLengthMm, 0);
  assert.equal(result.nets[0].longestSegmentMm, 0);
  assert.equal(result.nets[1].totalTrackLengthMm, 200);
  assert.deepEqual(result.nets[1].segmentsOverBudget, []);
  assert.match(result.notVerified.join(' '), /Net empty has no routed track segments/);
});

test('EMC saved-fill evidence distinguishes missing, empty, disabled and keepout zones', () => {
  const pcb = board();
  pcb.zones = [
    zone('missing'),
    { ...zone('empty-fill'), filledPolygons: [] },
    { ...zone('copper-fill'), filledPolygons: [{ points: zone('shape').outline }] },
    { ...zone('disabled'), fillEnabled: false },
    {
      ...zone('keepout'),
      keepout: { tracks: true, vias: true, pads: true, copperpour: true, footprints: true },
    },
    { ...zone('drawing'), layer: 'Dwgs.User' },
    zone('other-net', 'ground'),
  ];
  pcb.footprints[0].zones = [zone('local-missing')];
  const result = inspectEmcLayout(pcb, input);
  assert.equal(result.nets[0].enabledZoneCount, 4);
  assert.equal(result.nets[0].filledZoneCount, 2);
  assert.equal(result.nets[0].missingFillZoneCount, 2);
  assert.deepEqual(result.nets[0].missingFillZoneIds, ['missing', 'local-missing']);
  assert.match(result.notVerified.join(' '), /2 enabled zone\(s\) without saved fills/);
  assert.match(
    result.notVerified.join(' '),
    /Saved fill counts do not establish a reference plane/,
  );
  assert.equal(pcb.zones[0].filledPolygons, undefined);
});

test('EMC inspection and returned positions never mutate or alias caller board data', () => {
  const pcb = board();
  const before = structuredClone(pcb);
  const result = inspectEmcLayout(pcb, input);
  assert.deepEqual(pcb, before);
  result.nets[0].segmentsOverBudget[0].start.x = -1000;
  result.nets[0].missingFillZoneIds.push('new');
  result.nets[0].netName = 'Changed';
  assert.deepEqual(pcb, before);
  assert.equal(inspectEmcLayout(pcb, input).nets[0].netName, 'CLK');
  const rotated = structuredClone(pcb);
  rotated.footprints[0].rotation = 270;
  rotated.footprints[0].side = 'front';
  assert.deepEqual(inspectEmcLayout(rotated, input), inspectEmcLayout(pcb, input));
});

test('EMC bounded detail lists retain exact counts and explicitly report truncation', () => {
  const pcb = board();
  const count = EMC_LAYOUT_LIMITS.detailRecords + 3;
  pcb.tracks = Array.from({ length: count }, (_, index) => ({
    ...pcb.tracks[1],
    id: `segment-${index}`,
  }));
  pcb.zones = Array.from({ length: count }, (_, index) => zone(`zone-${index}`));
  const net = inspectEmcLayout(pcb, input).nets[0];
  assert.equal(net.trackCount, count);
  assert.equal(net.totalTrackLengthMm, count * 12);
  assert.equal(net.segmentsOverBudgetCount, count);
  assert.equal(net.segmentsOverBudget.length, EMC_LAYOUT_LIMITS.detailRecords);
  assert.equal(net.segmentsTruncated, true);
  assert.equal(net.missingFillZoneCount, count);
  assert.equal(net.missingFillZoneIds.length, EMC_LAYOUT_LIMITS.detailRecords);
  assert.equal(net.missingFillZoneIdsTruncated, true);
  assert.equal(net.segmentsOverBudget[0].trackId, 'segment-0');
  assert.equal(
    net.segmentsOverBudget.at(-1)?.trackId,
    `segment-${EMC_LAYOUT_LIMITS.detailRecords - 1}`,
  );

  // Caps apply across all selected nets, rather than to each net separately.
  pcb.tracks.push({ ...pcb.tracks[0], id: 'ground-long', netId: 'ground' });
  pcb.zones.push(zone('ground-missing', 'ground'));
  const ground = inspectEmcLayout(pcb, { ...input, netIds: ['ground', 'clock'] }).nets[0];
  assert.equal(ground.segmentsOverBudgetCount, 1);
  assert.equal(ground.segmentsOverBudget.length, 0);
  assert.equal(ground.segmentsTruncated, true);
  assert.equal(ground.missingFillZoneCount, 1);
  assert.equal(ground.missingFillZoneIds.length, 0);
  assert.equal(ground.missingFillZoneIdsTruncated, true);
});

test('EMC segment budgets depend on native segmentation without altering total length', () => {
  const pcb = board();
  pcb.tracks = [{ ...pcb.tracks[1], start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }];
  assert.equal(inspectEmcLayout(pcb, input).nets[0].segmentsOverBudgetCount, 1);
  pcb.tracks = [
    { ...pcb.tracks[0], id: 'split-a', end: { x: 5, y: 0 } },
    { ...pcb.tracks[0], id: 'split-b', start: { x: 5, y: 0 } },
  ];
  const net = inspectEmcLayout(pcb, input).nets[0];
  assert.equal(net.segmentsOverBudgetCount, 0);
  assert.equal(net.totalTrackLengthMm, 10);
});

test('EMC schema and direct domain calls reject unsupported intent and nonfinite budgets', () => {
  const validate = compileCapabilitySchema(EMC_LAYOUT_INPUT_SCHEMA);
  for (const candidate of [
    {},
    { ...input, netIds: [] },
    { ...input, netIds: ['clock', 'clock'] },
    { ...input, netIds: new Array(33).fill('clock') },
    { ...input, netIds: [''] },
    { ...input, netIds: ['x'.repeat(201)] },
    { ...input, netIds: [1] },
    { ...input, segmentBudgetMm: 0 },
    { ...input, segmentBudgetMm: -1 },
    { ...input, segmentBudgetMm: Infinity },
    { ...input, segmentBudgetMm: NaN },
    { ...input, segmentBudgetMm: EMC_LAYOUT_LIMITS.segmentBudgetMm + 1 },
    { ...input, segmentBudgetMm: '5' },
    { ...input, autoDetectNets: true },
  ]) {
    assert.equal(validate(candidate).valid, false);
    assert.throws(() => inspectEmcLayout(board(), candidate as EmcLayoutInput), /EMC layout input/);
  }
  assert.equal(validate(input).valid, true);
  assert.equal(validate({ ...input, segmentBudgetMm: Number.MIN_VALUE }).valid, true);
  assert.throws(
    () => inspectEmcLayout(board(), { ...input, netIds: ['missing'] }),
    /current PCB net IDs/,
  );
  const duplicateNet = board();
  duplicateNet.nets.push({ id: 'clock', name: 'Different' });
  assert.throws(() => inspectEmcLayout(duplicateNet, input), /duplicate net IDs/);
});

test('EMC bounds work before reporting and rejects unusable track measurements', () => {
  const pcb = board();
  pcb.nets = Array.from({ length: EMC_LAYOUT_LIMITS.boardNets + 1 }, (_, index) => ({
    id: String(index),
    name: String(index),
  }));
  assert.throws(() => inspectEmcLayout(pcb, input), /inspection limit/);
  const manyTracks = board();
  manyTracks.tracks = new Array(EMC_LAYOUT_LIMITS.boardRecords).fill(manyTracks.tracks[0]);
  assert.throws(() => inspectEmcLayout(manyTracks, input), /inspection limit/);
  const manyPads = board();
  manyPads.footprints[0].pads = new Array(EMC_LAYOUT_LIMITS.boardRecords).fill(
    manyPads.footprints[0].pads[0],
  );
  assert.throws(() => inspectEmcLayout(manyPads, input), /inspection limit/);
  const invalidTrack = board();
  invalidTrack.tracks[0].end.x = NaN;
  assert.throws(() => inspectEmcLayout(invalidTrack, input), /invalid geometry/);
  invalidTrack.tracks[0].end.x = Number.MAX_VALUE;
  invalidTrack.tracks[0].start.x = -Number.MAX_VALUE;
  assert.throws(() => inspectEmcLayout(invalidTrack, input), /invalid geometry/);
});
