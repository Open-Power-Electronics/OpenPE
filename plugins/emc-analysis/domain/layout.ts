import { compileCapabilitySchema } from '../../../api/capability-schema';
import type { Point } from '../../../lib/circuit';
import {
  requireSupportedPCBCopper,
  type BoardZone,
  type CopperLayer,
  type PCB,
} from '../../../lib/pcb';

export const EMC_LAYOUT_LIMITS = {
  selectedNets: 32,
  boardNets: 10_000,
  boardRecords: 100_000,
  segmentBudgetMm: 100_000,
  detailRecords: 256,
} as const;

/** This is a user review budget, not an emissions limit or a standard's rule. */
export const EMC_LAYOUT_INPUT_SCHEMA = {
  type: 'object',
  required: ['netIds', 'segmentBudgetMm'],
  additionalProperties: false,
  properties: {
    netIds: {
      type: 'array',
      minItems: 1,
      maxItems: EMC_LAYOUT_LIMITS.selectedNets,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 200 },
    },
    segmentBudgetMm: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: EMC_LAYOUT_LIMITS.segmentBudgetMm,
    },
  },
};

export type EmcLayoutInput = { netIds: string[]; segmentBudgetMm: number };
export type EmcLayoutSegment = {
  trackId: string;
  layer: CopperLayer;
  lengthMm: number;
  start: Point;
  end: Point;
};
export type EmcLayoutNet = {
  netId: string;
  netName: string;
  /** Sum of straight track centreline lengths, including branches and stubs. */
  totalTrackLengthMm: number;
  longestSegmentMm: number;
  trackCount: number;
  viaCount: number;
  padCount: number;
  enabledZoneCount: number;
  /** Completed saved fills, including completed empty fills. */
  filledZoneCount: number;
  missingFillZoneCount: number;
  missingFillZoneIds: string[];
  missingFillZoneIdsTruncated: boolean;
  segmentsOverBudgetCount: number;
  segmentsOverBudget: EmcLayoutSegment[];
  segmentsTruncated: boolean;
};
export type EmcLayoutResult = {
  completeness: 'partial';
  segmentBudgetMm: number;
  nets: EmcLayoutNet[];
  notVerified: string[];
};

const validateInput = compileCapabilitySchema(EMC_LAYOUT_INPUT_SCHEMA);
const limitMessage = 'This PCB exceeds the EMC layout inspection limit.';

/**
 * Inspect the accepted native board without constructing connectivity or inferring
 * design intent. Segment budgets deliberately depend on native segmentation:
 * splitting a straight track changes the segment checks, not its total length.
 * Core owns full document validation; this helper bounds only its own work and
 * rejects invalid measurements rather than publishing nonfinite evidence.
 */
export function inspectEmcLayout(board: PCB, input: EmcLayoutInput): EmcLayoutResult {
  requireSupportedPCBCopper(board, 'PCB EMC inspection');
  const copperLayers = new Set<string>(board.layers);
  const check = validateInput(input);
  if (!check.valid) throw new Error(`EMC layout input: ${check.error}`);
  if (board.nets.length > EMC_LAYOUT_LIMITS.boardNets) throw new Error(limitMessage);
  let records =
    board.nets.length +
    board.tracks.length +
    board.vias.length +
    board.zones.length +
    board.footprints.length;
  const boundRecords = () => {
    if (records > EMC_LAYOUT_LIMITS.boardRecords) throw new Error(limitMessage);
  };
  boundRecords();
  for (const footprint of board.footprints) {
    records += footprint.pads.length + (footprint.zones?.length ?? 0);
    boundRecords();
  }
  const names = new Map<string, string>();
  for (const net of board.nets) {
    if (names.has(net.id)) throw new Error('The PCB contains duplicate net IDs.');
    names.set(net.id, net.name);
  }
  const nets = input.netIds.map((netId): EmcLayoutNet => {
    if (!names.has(netId)) throw new Error('Select current PCB net IDs for EMC inspection.');
    return {
      netId,
      netName: names.get(netId)!,
      totalTrackLengthMm: 0,
      longestSegmentMm: 0,
      trackCount: 0,
      viaCount: 0,
      padCount: 0,
      enabledZoneCount: 0,
      filledZoneCount: 0,
      missingFillZoneCount: 0,
      missingFillZoneIds: [],
      missingFillZoneIdsTruncated: false,
      segmentsOverBudgetCount: 0,
      segmentsOverBudget: [],
      segmentsTruncated: false,
    };
  });
  const selected = new Map(nets.map((net) => [net.netId, net]));
  let segmentDetails = 0;
  let missingFillDetails = 0;
  for (const track of board.tracks) {
    const net = selected.get(track.netId);
    if (!net) continue;
    const lengthMm = Math.hypot(track.end.x - track.start.x, track.end.y - track.start.y);
    if (![track.start.x, track.start.y, track.end.x, track.end.y, lengthMm].every(Number.isFinite))
      throw new Error('The selected PCB track has invalid geometry.');
    net.totalTrackLengthMm += lengthMm;
    if (!Number.isFinite(net.totalTrackLengthMm))
      throw new Error('The selected PCB track length cannot be measured.');
    net.longestSegmentMm = Math.max(net.longestSegmentMm, lengthMm);
    net.trackCount++;
    if (lengthMm > input.segmentBudgetMm) {
      net.segmentsOverBudgetCount++;
      if (segmentDetails < EMC_LAYOUT_LIMITS.detailRecords) {
        segmentDetails++;
        net.segmentsOverBudget.push({
          trackId: track.id,
          layer: track.layer,
          lengthMm,
          start: { x: track.start.x, y: track.start.y },
          end: { x: track.end.x, y: track.end.y },
        });
      } else net.segmentsTruncated = true;
    }
  }
  for (const via of board.vias) {
    const net = selected.get(via.netId);
    if (net) net.viaCount++;
  }
  const inspectZone = (zone: BoardZone) => {
    if (zone.keepout || zone.fillEnabled === false || !copperLayers.has(zone.layer)) return;
    const net = selected.get(zone.netId ?? '');
    if (!net) return;
    net.enabledZoneCount++;
    if (zone.filledPolygons === undefined) {
      net.missingFillZoneCount++;
      if (missingFillDetails < EMC_LAYOUT_LIMITS.detailRecords) {
        missingFillDetails++;
        net.missingFillZoneIds.push(zone.id);
      } else net.missingFillZoneIdsTruncated = true;
    } else net.filledZoneCount++;
  };
  for (const zone of board.zones) inspectZone(zone);
  for (const footprint of board.footprints) {
    for (const pad of footprint.pads) {
      const net = selected.get(pad.netId ?? '');
      if (net) net.padCount++;
    }
    for (const zone of footprint.zones ?? []) inspectZone(zone);
  }
  const notVerified = [
    'Return-path continuity, current-loop area, field emissions, coupling and compliance with EMC standards are not verified.',
    'Track totals include all selected-net branches and stubs; they are not source-to-load path lengths or electrical lengths.',
    'Via barrels, pads, pours and copper artwork are excluded from track lengths. Saved fill counts do not establish a reference plane or a current return path.',
    'The straight-segment budget is supplied by the user for engineering review; it is not an EMC pass/fail limit.',
  ];
  for (const net of nets) {
    if (!net.trackCount)
      notVerified.push(`Net ${net.netId} has no routed track segments; routing is not verified.`);
    if (net.missingFillZoneCount)
      notVerified.push(
        `Net ${net.netId} has ${net.missingFillZoneCount} enabled zone(s) without saved fills; their copper is not verified.`,
      );
  }
  return { completeness: 'partial', segmentBudgetMm: input.segmentBudgetMm, nets, notVerified };
}
