import { compileCapabilitySchema } from '../../../api/capability-schema';
import type { Point } from '../../../lib/circuit';
import type { BoardLine, CopperLayer, Footprint, Pad, PCB } from '../../../lib/pcb';
import { padPosition } from '../../../lib/pcb-layout';
import { segmentDistance } from '../../../lib/pcb-collision';
import {
  closedGraphicContours,
  filledCopperPolygons,
  prepareBoardOutline,
  worldZones,
  polygonResolution,
  type Polygon,
} from '../../../lib/pcb-polygons';
import { inspectEmcLayout } from './layout';
import {
  centerlineCoverage,
  edgesOf,
  epsilon,
  midpoint,
  nearestEdge,
  validPoint,
  withinPolygons,
  workBudget,
  type WorkBudget,
} from './review-geometry';

export type EmcNetRole = 'fast' | 'switching' | 'sensitive' | 'supply';
export type EmcReviewInput = {
  nets: {
    netId: string;
    role: EmcNetRole;
    referenceNetId?: string;
    referenceLayer?: CopperLayer;
  }[];
  limits: {
    maxTrackLengthMm: number;
    maxVias: number;
    minEdgeClearanceMm: number;
    minNetSeparationMm: number;
    maxReferenceViaDistanceMm: number;
    maxDecouplingDistanceMm: number;
    maxConnectorEdgeDistanceMm: number;
  };
  decoupling: { targetPadId: string; capacitorFootprintId: string; referenceNetId: string }[];
  edgeConnectorIds: string[];
};
export type EmcReviewCategory =
  'routing' | 'board-edge' | 'coupling' | 'reference' | 'decoupling' | 'connectors';
export type EmcFinding = {
  id: string;
  checkId: string;
  category: EmcReviewCategory;
  severity: 'warning' | 'info' | 'not-verified';
  confidence: 'geometric' | 'limited' | 'missing';
  title: string;
  message: string;
  recommendation: string;
  netIds: string[];
  objectIds: string[];
  location?: Point;
  measured?: { value: number; unit: 'mm' | 'count' | '%' };
  limit?: { value: number; unit: 'mm' | 'count' | '%' };
};
export type EmcReviewCheck = {
  id: string;
  title: string;
  category: EmcReviewCategory;
  status: 'checked' | 'not-verified' | 'not-applicable';
  notes: string[];
};
export type EmcReviewResult = {
  completeness: 'partial';
  input: EmcReviewInput;
  findings: EmcFinding[];
  checks: EmcReviewCheck[];
  summary: { warning: number; info: number; notVerified: number };
  truncated: boolean;
  notes: string[];
};

/** Editable starting budgets, authored for this tool; none are standards limits. */
export const EMC_REVIEW_DEFAULT_LIMITS: Readonly<EmcReviewInput['limits']> = Object.freeze({
  maxTrackLengthMm: 100,
  maxVias: 4,
  minEdgeClearanceMm: 3,
  minNetSeparationMm: 2,
  maxReferenceViaDistanceMm: 3,
  maxDecouplingDistanceMm: 5,
  maxConnectorEdgeDistanceMm: 10,
});
export const EMC_REVIEW_LIMITS = {
  intents: 32,
  findings: 500,
  boardRecords: 100_000,
  boardNets: 10_000,
  geometryVertices: 20_000,
  outlineGraphics: 500,
  operations: 2_000_000,
} as const;
export const EMC_REVIEW_CHECKS: readonly Pick<EmcReviewCheck, 'id' | 'title' | 'category'>[] = [
  { id: 'route-length', title: 'Routed length budget', category: 'routing' },
  { id: 'via-budget', title: 'Via count budget', category: 'routing' },
  { id: 'edge-clearance', title: 'Critical tracks near board edges', category: 'board-edge' },
  { id: 'net-separation', title: 'Critical and sensitive track separation', category: 'coupling' },
  {
    id: 'reference-fill',
    title: 'Reference copper below track centerlines',
    category: 'reference',
  },
  { id: 'reference-vias', title: 'Reference vias near signal vias', category: 'reference' },
  { id: 'decoupling-distance', title: 'Assigned decoupling placement', category: 'decoupling' },
  { id: 'connector-edge', title: 'Edge-intended connector placement', category: 'connectors' },
];
const identity = { type: 'string', minLength: 1, maxLength: 200 };
const distance = { type: 'number', exclusiveMinimum: 0, maximum: 100_000 };
export const EMC_REVIEW_INPUT_SCHEMA = {
  type: 'object',
  required: ['nets', 'limits', 'decoupling', 'edgeConnectorIds'],
  additionalProperties: false,
  properties: {
    nets: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        required: ['netId', 'role'],
        additionalProperties: false,
        properties: {
          netId: identity,
          role: { enum: ['fast', 'switching', 'sensitive', 'supply'] },
          referenceNetId: identity,
          referenceLayer: { enum: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] },
        },
      },
    },
    limits: {
      type: 'object',
      required: Object.keys(EMC_REVIEW_DEFAULT_LIMITS),
      additionalProperties: false,
      properties: {
        maxTrackLengthMm: distance,
        maxVias: { type: 'integer', minimum: 0, maximum: 100_000 },
        minEdgeClearanceMm: distance,
        minNetSeparationMm: distance,
        maxReferenceViaDistanceMm: distance,
        maxDecouplingDistanceMm: distance,
        maxConnectorEdgeDistanceMm: distance,
      },
    },
    decoupling: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: {
        type: 'object',
        required: ['targetPadId', 'capacitorFootprintId', 'referenceNetId'],
        additionalProperties: false,
        properties: {
          targetPadId: identity,
          capacitorFootprintId: identity,
          referenceNetId: identity,
        },
      },
    },
    edgeConnectorIds: { type: 'array', maxItems: 32, uniqueItems: true, items: identity },
  },
};
const validateInput = compileCapabilitySchema(EMC_REVIEW_INPUT_SCHEMA);
const text = { type: 'string', maxLength: 2000 };
const ids = { type: 'array', maxItems: 8, uniqueItems: true, items: identity };
const category = {
  enum: ['routing', 'board-edge', 'coupling', 'reference', 'decoupling', 'connectors'],
};
const quantity = {
  type: 'object',
  required: ['value', 'unit'],
  additionalProperties: false,
  properties: { value: { type: 'number' }, unit: { enum: ['mm', 'count', '%'] } },
};
const pointSchema = {
  type: 'object',
  required: ['x', 'y'],
  additionalProperties: false,
  properties: { x: { type: 'number' }, y: { type: 'number' } },
};
export const EMC_REVIEW_RESULT_SCHEMA = {
  type: 'object',
  required: ['completeness', 'input', 'findings', 'checks', 'summary', 'truncated', 'notes'],
  additionalProperties: false,
  properties: {
    completeness: { const: 'partial' },
    input: EMC_REVIEW_INPUT_SCHEMA,
    findings: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: [
          'id',
          'checkId',
          'category',
          'severity',
          'confidence',
          'title',
          'message',
          'recommendation',
          'netIds',
          'objectIds',
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 1800 },
          checkId: identity,
          category,
          severity: { enum: ['warning', 'info', 'not-verified'] },
          confidence: { enum: ['geometric', 'limited', 'missing'] },
          title: text,
          message: text,
          recommendation: text,
          netIds: ids,
          objectIds: ids,
          location: pointSchema,
          measured: quantity,
          limit: quantity,
        },
      },
    },
    checks: {
      type: 'array',
      minItems: 8,
      maxItems: 8,
      items: {
        type: 'object',
        required: ['id', 'title', 'category', 'status', 'notes'],
        additionalProperties: false,
        properties: {
          id: identity,
          title: text,
          category,
          status: { enum: ['checked', 'not-verified', 'not-applicable'] },
          notes: { type: 'array', maxItems: 32, items: text },
        },
      },
    },
    summary: {
      type: 'object',
      required: ['warning', 'info', 'notVerified'],
      additionalProperties: false,
      properties: {
        warning: { type: 'integer', minimum: 0, maximum: 2_000_000 },
        info: { type: 'integer', minimum: 0, maximum: 2_000_000 },
        notVerified: { type: 'integer', minimum: 0, maximum: 2_000_000 },
      },
    },
    truncated: { type: 'boolean' },
    notes: { type: 'array', maxItems: 32, items: text },
  },
};
const validateResult = compileCapabilitySchema(EMC_REVIEW_RESULT_SCHEMA);
function validateIntentShape(input: EmcReviewInput) {
  if (!input.nets.length && !input.decoupling.length && !input.edgeConnectorIds.length)
    throw new Error('Declare at least one net, decoupling assignment or edge-intended connector.');
  if (new Set(input.nets.map((net) => net.netId)).size !== input.nets.length)
    throw new Error('Declare each current PCB net once.');
  if (input.nets.some((net) => net.netId === net.referenceNetId))
    throw new Error('Select a distinct current reference net.');
}
/** Validate/detach the pure report contract; host identity/revision belongs outside it. */
export function validateEmcReviewResult(input: unknown): EmcReviewResult {
  const validation = validateResult(input);
  if (!validation.valid) throw new Error(`Invalid EMC review result: ${validation.error}`);
  const result = input as EmcReviewResult;
  validateIntentShape(result.input);
  const checks = new Map(EMC_REVIEW_CHECKS.map((check) => [check.id, check]));
  const seenChecks = new Set<string>();
  for (const check of result.checks) {
    const source = checks.get(check.id);
    if (
      !source ||
      seenChecks.has(check.id) ||
      source.category !== check.category ||
      source.title !== check.title
    )
      throw new Error('Invalid EMC review check catalog.');
    seenChecks.add(check.id);
  }
  const seen = new Set<string>();
  const counts = { warning: 0, info: 0, notVerified: 0 };
  for (const finding of result.findings) {
    if (seen.has(finding.id) || checks.get(finding.checkId)?.category !== finding.category)
      throw new Error('Invalid EMC review finding identity or category.');
    seen.add(finding.id);
    counts[finding.severity === 'not-verified' ? 'notVerified' : finding.severity]++;
  }
  for (const check of result.checks) {
    const entries = result.findings.filter((finding) => finding.checkId === check.id);
    if (
      (check.status === 'not-applicable' && entries.length > 0) ||
      (check.status !== 'not-verified' &&
        entries.some((finding) => finding.severity === 'not-verified')) ||
      (!result.truncated &&
        check.status === 'not-verified' &&
        !entries.some((finding) => finding.severity === 'not-verified'))
    )
      throw new Error('Invalid EMC review check status.');
  }
  for (const key of ['warning', 'info', 'notVerified'] as const) {
    if (result.truncated ? result.summary[key] < counts[key] : result.summary[key] !== counts[key])
      throw new Error('Invalid EMC review summary counts.');
  }
  if (
    result.truncated &&
    (result.findings.length !== EMC_REVIEW_LIMITS.findings ||
      result.summary.warning + result.summary.info + result.summary.notVerified <=
        result.findings.length)
  )
    throw new Error('Invalid EMC review truncation.');
  return JSON.parse(JSON.stringify(result)) as EmcReviewResult;
}

type Track = PCB['tracks'][number];
type PadEntry = { footprint: Footprint; pad: Pad; at: Point };
function currentInput(board: PCB, raw: unknown): EmcReviewInput {
  const validation = validateInput(raw);
  if (!validation.valid) throw new Error(`Invalid EMC review input: ${validation.error}`);
  const input = raw as EmcReviewInput;
  validateIntentShape(input);
  const netIds = new Set(board.nets.map((net) => net.id));
  const seen = new Set<string>();
  for (const intent of input.nets) {
    if (!netIds.has(intent.netId) || seen.has(intent.netId))
      throw new Error('Declare each current PCB net once.');
    seen.add(intent.netId);
    if (
      intent.referenceNetId !== undefined &&
      (!netIds.has(intent.referenceNetId) || intent.referenceNetId === intent.netId)
    )
      throw new Error('Select a distinct current reference net.');
    if (
      intent.referenceLayer !== undefined &&
      !board.layers.includes(intent.referenceLayer as never)
    )
      throw new Error('Select a copper layer present in this PCB stack.');
  }
  const footprints = new Set(board.footprints.map((footprint) => footprint.id));
  const pads = new Map(
    board.footprints.flatMap((footprint) =>
      footprint.pads.map((pad) => [pad.id, { footprint, pad }] as const),
    ),
  );
  for (const assignment of input.decoupling) {
    const target = pads.get(assignment.targetPadId);
    if (
      !target ||
      !target.pad.netId ||
      target.pad.type === 'np_thru_hole' ||
      !footprints.has(assignment.capacitorFootprintId) ||
      !netIds.has(assignment.referenceNetId)
    )
      throw new Error(
        'Decoupling assignments require current assigned pads, footprints and reference nets.',
      );
    if (
      target.footprint.id === assignment.capacitorFootprintId ||
      target.pad.netId === assignment.referenceNetId
    )
      throw new Error(
        'Assign a separate capacitor and a distinct reference net to the target supply pad.',
      );
  }
  if (input.edgeConnectorIds.some((id) => !footprints.has(id)))
    throw new Error('Select current edge-intended connector footprint IDs.');
  return JSON.parse(JSON.stringify(input)) as EmcReviewInput;
}

/** Bounds this review, rather than replacing Core's canonical PCB validator. */
function boundBoard(board: PCB) {
  let records =
    board.nets.length +
    board.tracks.length +
    board.vias.length +
    board.graphics.length +
    board.zones.length +
    board.footprints.length;
  let vertices = 0,
    outlineGraphics = 0;
  const limit = () => {
    if (
      records > EMC_REVIEW_LIMITS.boardRecords ||
      vertices > EMC_REVIEW_LIMITS.geometryVertices ||
      outlineGraphics > EMC_REVIEW_LIMITS.outlineGraphics ||
      board.nets.length > EMC_REVIEW_LIMITS.boardNets
    )
      throw new Error('This PCB exceeds the bounded EMC review record or geometry limit.');
  };
  limit();
  const graphics = (items: readonly BoardLine[]) => {
    for (const item of items) {
      if (item.layer !== 'Edge.Cuts') continue;
      outlineGraphics++;
      vertices += 2 + (item.points?.length ?? 0) + (item.mid ? 1 : 0);
      validPoint(item.start);
      validPoint(item.end);
      if (item.mid) validPoint(item.mid);
      item.points?.forEach(validPoint);
      limit();
    }
  };
  graphics(board.graphics);
  for (const footprint of board.footprints) {
    records += footprint.pads.length + footprint.graphics.length + (footprint.zones?.length ?? 0);
    validPoint(footprint);
    if (!Number.isFinite(footprint.rotation))
      throw new Error('EMC review contains an invalid footprint rotation.');
    footprint.pads.forEach((pad) => validPoint(padPosition(footprint, pad)));
    graphics(footprint.graphics);
    limit();
  }
  for (const zone of [
    ...board.zones,
    ...board.footprints.flatMap((footprint) => footprint.zones ?? []),
  ]) {
    const rings = [
      zone.outline,
      ...(zone.holes ?? []),
      ...(zone.filledPolygons?.map((polygon) => polygon.points) ?? []),
    ];
    for (const ring of rings) {
      vertices += ring.length;
      limit();
      ring.forEach(validPoint);
    }
  }
  for (const track of board.tracks) {
    validPoint(track.start);
    validPoint(track.end);
    if (!Number.isFinite(track.width) || track.width <= 0)
      throw new Error('EMC review contains an invalid track width.');
  }
  board.vias.forEach(validPoint);
  limit();
}

function resolvedOutline(board: PCB, spend: WorkBudget): Polygon[] {
  const prepared = prepareBoardOutline(board);
  const loops = closedGraphicContours([...prepared.edges] as BoardLine[], 'EMC board outline');
  const edges = loops.flatMap((loop, ring) =>
    loop.map((a, index) => ({
      a,
      b: loop[(index + 1) % loop.length],
      ring,
      index,
      size: loop.length,
    })),
  );
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (
        a.ring === b.ring &&
        (Math.abs(a.index - b.index) === 1 || Math.abs(a.index - b.index) === a.size - 1)
      )
        continue;
      spend();
      if (segmentDistance(a.a, a.b, b.a, b.b) <= epsilon ** 2)
        throw new Error('The EMC board outline intersects or touches itself.');
    }
  }
  return prepared.polygons;
}

/** Original, bounded geometric evidence against explicit user design intent.
 * Measurements describe geometry only; they never qualify emissions or a return path. */
export function reviewEmcLayout(board: PCB, raw: unknown): EmcReviewResult {
  boundBoard(board);
  const input = currentInput(board, raw);
  const spend = workBudget(EMC_REVIEW_LIMITS.operations);
  const checks = EMC_REVIEW_CHECKS.map((check): EmcReviewCheck => ({
    ...check,
    status: 'not-applicable',
    notes: [],
  }));
  const byCheck = new Map(checks.map((check) => [check.id, check]));
  const findings: EmcFinding[] = [];
  const summary = { warning: 0, info: 0, notVerified: 0 };
  let total = 0;
  function apply(id: string) {
    const check = byCheck.get(id)!;
    if (check.status !== 'not-verified') check.status = 'checked';
    return check;
  }
  function add(
    checkId: string,
    finding: Omit<EmcFinding, 'id' | 'checkId' | 'category'>,
    suffix = '',
  ) {
    const check = byCheck.get(checkId)!;
    if (finding.severity === 'not-verified') check.status = 'not-verified';
    else apply(checkId);
    summary[finding.severity === 'not-verified' ? 'notVerified' : finding.severity]++;
    total++;
    if (findings.length < EMC_REVIEW_LIMITS.findings)
      findings.push({
        id: [checkId, ...finding.netIds, ...finding.objectIds, suffix].join(':'),
        checkId,
        category: check.category,
        ...finding,
        netIds: [...finding.netIds],
        objectIds: [...finding.objectIds],
        ...(finding.location ? { location: { ...finding.location } } : {}),
      });
  }
  function missing(
    checkId: string,
    title: string,
    message: string,
    netIds: string[],
    objectIds: string[],
    suffix = '',
  ) {
    add(
      checkId,
      {
        severity: 'not-verified',
        confidence: 'missing',
        title,
        message,
        recommendation:
          'Supply the missing design intent or current native geometry, then repeat the review.',
        netIds,
        objectIds,
      },
      suffix,
    );
  }
  const trackGroups = new Map<string, Track[]>();
  const viaGroups = new Map<string, PCB['vias']>();
  for (const track of board.tracks) {
    const group = trackGroups.get(track.netId) ?? [];
    group.push(track);
    trackGroups.set(track.netId, group);
  }
  for (const via of board.vias) {
    const group = viaGroups.get(via.netId) ?? [];
    group.push(via);
    viaGroups.set(via.netId, group);
  }
  const names = new Map(board.nets.map((net) => [net.id, net.name || net.id]));
  const measures = input.nets.length
    ? inspectEmcLayout(board, {
        netIds: input.nets.map((intent) => intent.netId),
        segmentBudgetMm: input.limits.maxTrackLengthMm,
      }).nets
    : [];
  for (const measured of measures) {
    const label = names.get(measured.netId)!;
    const tracks = trackGroups.get(measured.netId) ?? [];
    apply('via-budget');
    if (measured.totalTrackLengthMm === 0)
      missing(
        'route-length',
        'No routed track length',
        `${label} has no positive-length routed tracks. Routing coverage is not established.`,
        [measured.netId],
        [],
      );
    else {
      apply('route-length');
      if (measured.totalTrackLengthMm > input.limits.maxTrackLengthMm)
        add('route-length', {
          severity: 'warning',
          confidence: 'geometric',
          title: 'Routed length exceeds the user budget',
          message: `${label} includes ${measured.trackCount} track segments, including branches and stubs. This sum is not a source-to-load path.`,
          recommendation:
            'Review the selected net topology and shorten unnecessary branches against the intended operating conditions.',
          netIds: [measured.netId],
          objectIds: tracks.slice(0, 1).map((track) => track.id),
          ...(tracks[0] ? { location: midpoint(tracks[0].start, tracks[0].end) } : {}),
          measured: { value: measured.totalTrackLengthMm, unit: 'mm' },
          limit: { value: input.limits.maxTrackLengthMm, unit: 'mm' },
        });
    }
    if (measured.viaCount > input.limits.maxVias) {
      const first = viaGroups.get(measured.netId)![0];
      add('via-budget', {
        severity: 'warning',
        confidence: 'limited',
        title: 'Via count exceeds the user budget',
        message: `${label} has ${measured.viaCount} through vias; their count does not measure electrical discontinuity.`,
        recommendation:
          'Review whether each layer transition is necessary and verify its reference-current arrangement.',
        netIds: [measured.netId],
        objectIds: [first.id],
        location: { x: first.x, y: first.y },
        measured: { value: measured.viaCount, unit: 'count' },
        limit: { value: input.limits.maxVias, unit: 'count' },
      });
    }
  }
  const critical = input.nets.filter((net) => net.role === 'fast' || net.role === 'switching');
  const criticalTracks = critical.flatMap((net) => trackGroups.get(net.netId) ?? []);
  let outline: Polygon[] | null = null;
  if (criticalTracks.length || input.edgeConnectorIds.length) {
    try {
      outline = resolvedOutline(board, spend);
    } catch (error) {
      if (error instanceof Error && /exceed|bounded/i.test(error.message)) throw error;
    }
  }
  const outlineEdges = outline ? edgesOf(outline) : [];
  if (critical.length) {
    if (!criticalTracks.length)
      missing(
        'edge-clearance',
        'Critical routing is not available',
        'No tracks exist for the declared fast or switching nets.',
        critical.map((net) => net.netId).slice(0, 8),
        [],
      );
    else if (!outline)
      missing(
        'edge-clearance',
        'Board edge geometry is not verified',
        'A valid closed, nonintersecting Edge.Cuts outline is needed for edge and cutout measurements.',
        [],
        [board.id],
      );
    else {
      apply('edge-clearance');
      for (const track of criticalTracks) {
        const coverage = centerlineCoverage(track.start, track.end, outline, outlineEdges, spend);
        const distanceMm = nearestEdge(track.start, track.end, outlineEdges, spend);
        const clearance = (coverage.uncovered ? -distanceMm : distanceMm) - track.width / 2;
        if (clearance < input.limits.minEdgeClearanceMm)
          add('edge-clearance', {
            severity: 'warning',
            confidence: 'geometric',
            title: coverage.uncovered
              ? 'Critical track crosses outside the board surface'
              : 'Critical track is near an edge or cutout',
            message:
              'The distance uses the track copper radius and the canonical polygon approximation of all board edges and cutouts.',
            recommendation:
              'Review critical-track placement relative to the board edge and the intended return structure.',
            netIds: [track.netId],
            objectIds: [track.id],
            location: coverage.location,
            measured: { value: clearance, unit: 'mm' },
            limit: { value: input.limits.minEdgeClearanceMm, unit: 'mm' },
          });
      }
    }
  }
  const sensitive = input.nets.filter((net) => net.role === 'sensitive');
  if (critical.length && sensitive.length) {
    const sensitiveTracks = sensitive.flatMap((net) => trackGroups.get(net.netId) ?? []);
    if (!criticalTracks.length || !sensitiveTracks.length)
      missing(
        'net-separation',
        'Track separation is not verified',
        'Both declared critical and sensitive nets need routed tracks for this track-only check.',
        [],
        [],
      );
    else {
      apply('net-separation');
      for (const source of criticalTracks)
        for (const target of sensitiveTracks) {
          spend();
          if (source.layer !== target.layer) continue;
          const clearance =
            Math.sqrt(segmentDistance(source.start, source.end, target.start, target.end)) -
            (source.width + target.width) / 2;
          if (clearance < input.limits.minNetSeparationMm)
            add('net-separation', {
              severity: 'warning',
              confidence: 'limited',
              title: 'Critical and sensitive tracks are close',
              message: `The two selected nets share ${source.layer}; this copper-edge distance does not predict coupled voltage or field strength.`,
              recommendation:
                'Review parallel exposure, reference conductors and component placement; compare separation with the intended noise sensitivity.',
              netIds: [source.netId, target.netId],
              objectIds: [source.id, target.id],
              location: midpoint(source.start, source.end),
              measured: { value: clearance, unit: 'mm' },
              limit: { value: input.limits.minNetSeparationMm, unit: 'mm' },
            });
        }
    }
  }
  const zones = worldZones(board).filter(
    (zone) => !zone.keepout && zone.fillEnabled !== false && zone.layer.endsWith('.Cu'),
  );
  let saved: Map<string, Polygon[]> | null = null;
  for (const intent of critical) {
    const tracks = trackGroups.get(intent.netId) ?? [];
    const vias = viaGroups.get(intent.netId) ?? [];
    if (tracks.length) {
      if (!intent.referenceNetId || !intent.referenceLayer)
        missing(
          'reference-fill',
          'Reference intent is incomplete',
          `${names.get(intent.netId)} needs an explicit distinct reference net and copper layer.`,
          [intent.netId],
          [],
        );
      else {
        const applicable = zones.filter(
          (zone) => zone.netId === intent.referenceNetId && zone.layer === intent.referenceLayer,
        );
        if (!applicable.length || applicable.some((zone) => zone.filledPolygons === undefined))
          missing(
            'reference-fill',
            'Saved reference copper is not verified',
            'The selected reference net/layer has no enabled zones or has zones without saved fills. Zone outlines are not substituted for copper.',
            [intent.netId, intent.referenceNetId],
            applicable.slice(0, 8).map((zone) => zone.id),
          );
        else {
          saved ??= filledCopperPolygons(board);
          const polygons = applicable.flatMap((zone) => saved!.get(zone.id) ?? []);
          const edges = edgesOf(polygons);
          for (const track of tracks) {
            if (track.layer === intent.referenceLayer) {
              missing(
                'reference-fill',
                'Reference layer matches the signal layer',
                'A same-layer fill projection cannot establish an underlying reference plane.',
                [intent.netId, intent.referenceNetId],
                [track.id],
              );
              continue;
            }
            apply('reference-fill');
            const coverage = centerlineCoverage(track.start, track.end, polygons, edges, spend);
            if (coverage.uncovered)
              add('reference-fill', {
                severity: 'warning',
                confidence: 'limited',
                title: 'Track centerline projects across a reference-copper gap',
                message: `Stored ${intent.referenceLayer} copper leaves part of this track centerline uncovered; trace width, plane continuity and return-current connectivity are not established.`,
                recommendation:
                  'Inspect the saved plane gap and verify an appropriate continuous return structure for the actual signal and stackup.',
                netIds: [intent.netId, intent.referenceNetId],
                objectIds: [track.id],
                location: coverage.location,
                measured: { value: coverage.uncoveredMm, unit: 'mm' },
                limit: { value: 0, unit: 'mm' },
              });
          }
        }
      }
    }
    if (vias.length) {
      if (!intent.referenceNetId)
        missing(
          'reference-vias',
          'Via reference intent is incomplete',
          'Assign the intended reference net before checking nearby reference vias.',
          [intent.netId],
          vias.slice(0, 8).map((via) => via.id),
        );
      else {
        apply('reference-vias');
        const referenceVias = viaGroups.get(intent.referenceNetId) ?? [];
        for (const via of vias) {
          let distanceMm = Infinity;
          for (const reference of referenceVias) {
            spend();
            distanceMm = Math.min(distanceMm, Math.hypot(via.x - reference.x, via.y - reference.y));
          }
          if (distanceMm > input.limits.maxReferenceViaDistanceMm)
            add('reference-vias', {
              severity: 'warning',
              confidence: 'limited',
              title: 'No reference via is within the user distance budget',
              message:
                'Only through-via center spacing on the explicitly selected reference net is inspected; nearby copper does not prove a return connection.',
              recommendation:
                'Inspect the layer transition and provide an appropriate nearby reference transition when the actual stackup requires one.',
              netIds: [intent.netId, intent.referenceNetId],
              objectIds: [via.id],
              location: { x: via.x, y: via.y },
              ...(Number.isFinite(distanceMm)
                ? { measured: { value: distanceMm, unit: 'mm' as const } }
                : {}),
              limit: { value: input.limits.maxReferenceViaDistanceMm, unit: 'mm' },
            });
        }
      }
    }
  }
  const padMap = new Map<string, PadEntry>();
  for (const footprint of board.footprints)
    for (const pad of footprint.pads)
      padMap.set(pad.id, { footprint, pad, at: padPosition(footprint, pad) });
  for (const assignment of input.decoupling) {
    const target = padMap.get(assignment.targetPadId)!;
    const capacitor = board.footprints.find(
      (footprint) => footprint.id === assignment.capacitorFootprintId,
    )!;
    const supplyPads = capacitor.pads.filter(
      (pad) => pad.netId === target.pad.netId && pad.type !== 'np_thru_hole',
    );
    const referencePads = capacitor.pads.filter(
      (pad) => pad.netId === assignment.referenceNetId && pad.type !== 'np_thru_hole',
    );
    if (!supplyPads.length || !referencePads.length) {
      missing(
        'decoupling-distance',
        'Assigned decoupling connectivity is not verified',
        'The explicitly assigned capacitor does not expose both the target supply net and the selected reference net on copper pads.',
        [target.pad.netId!, assignment.referenceNetId],
        [target.pad.id, capacitor.id],
      );
      continue;
    }
    apply('decoupling-distance');
    let distanceMm = Infinity;
    for (const pad of supplyPads) {
      spend();
      const at = padPosition(capacitor, pad);
      distanceMm = Math.min(distanceMm, Math.hypot(target.at.x - at.x, target.at.y - at.y));
    }
    if (distanceMm > input.limits.maxDecouplingDistanceMm)
      add('decoupling-distance', {
        severity: 'warning',
        confidence: 'limited',
        title: 'Assigned decoupling capacitor is beyond the placement budget',
        message:
          'The distance is between the target supply-pad center and the nearest assigned capacitor supply-pad center, using native footprint rotation.',
        recommendation:
          'Review supply/return loop geometry and move the assigned capacitor when appropriate; pad-center distance does not measure routed loop inductance.',
        netIds: [target.pad.netId!, assignment.referenceNetId],
        objectIds: [target.pad.id, capacitor.id],
        location: target.at,
        measured: { value: distanceMm, unit: 'mm' },
        limit: { value: input.limits.maxDecouplingDistanceMm, unit: 'mm' },
      });
  }
  for (const id of input.edgeConnectorIds) {
    const footprint = board.footprints.find((item) => item.id === id)!;
    const pads = footprint.pads.filter((pad) => pad.type !== 'np_thru_hole');
    if (!outline || !pads.length) {
      missing(
        'connector-edge',
        'Connector edge placement is not verified',
        'This explicit edge-intended connector needs copper pads and a valid closed board outline.',
        [],
        [id],
      );
      continue;
    }
    apply('connector-edge');
    let distanceMm = Infinity,
      location = { x: footprint.x, y: footprint.y };
    let outsideDistance = Infinity;
    let outsideLocation: Point | undefined;
    for (const pad of pads) {
      const at = padPosition(footprint, pad);
      const distance = nearestEdge(at, at, outlineEdges, spend);
      if (distance < distanceMm) {
        distanceMm = distance;
        location = at;
      }
      if (!withinPolygons(at, outline, outlineEdges, spend) && distance < outsideDistance) {
        outsideDistance = distance;
        outsideLocation = at;
      }
    }
    const outside = outsideLocation !== undefined;
    if (outside || distanceMm > input.limits.maxConnectorEdgeDistanceMm)
      add('connector-edge', {
        severity: 'warning',
        confidence: 'limited',
        title: outside
          ? 'Edge-intended connector has a pad outside the board surface'
          : 'Edge-intended connector is far from the board edge',
        message:
          'Only a user-designated edge connector is checked. The measurement uses the nearest copper-pad center, or an outside pad for outside-board findings, and all board edges/cutouts; it does not use a mechanical mating envelope.',
        recommendation:
          'Review the intended external mating edge, cable entry, chassis bonding and mechanical clearance for this connector.',
        netIds: [],
        objectIds: [id],
        location: outsideLocation ?? location,
        measured: { value: outside ? -outsideDistance : distanceMm, unit: 'mm' },
        limit: { value: input.limits.maxConnectorEdgeDistanceMm, unit: 'mm' },
      });
  }
  byCheck.get('route-length')!.notes = [
    'Track-length sums include branches and stubs, not source-to-load paths or propagation delay.',
  ];
  byCheck.get('via-budget')!.notes = [
    'Via count is topology evidence, not a measured impedance or EMC limit.',
  ];
  byCheck.get('edge-clearance')!.notes = [
    'Uses track copper radius and canonical polygon approximations of closed edges, including cutouts.',
  ];
  byCheck.get('net-separation')!.notes = [
    'Same-layer tracks only; pads, zones, broadside coupling, parallel-run exposure and coupled voltage are not evaluated.',
  ];
  byCheck.get('reference-fill')!.notes = [
    'Centerline projection on explicitly selected saved reference-layer copper only; does not prove a continuous or electrically connected return path.',
    `Canonical saved-fill polygons use a ${polygonResolution} mm normalization grid. Smaller native gaps are not resolved; arc-shaped board edges use the canonical polygon approximation.`,
  ];
  byCheck.get('reference-vias')!.notes = [
    'Reference-net through-via center distance only; the requirement and electrical connection need stackup evidence.',
  ];
  byCheck.get('decoupling-distance')!.notes = [
    'Explicit capacitor assignments only; no component classification or nominal-value inference. Pad-center distance is not loop length.',
  ];
  byCheck.get('connector-edge')!.notes = [
    'Explicit edge-intended connectors only. Distance to any board edge or cutout is geometric context, not a universal placement rule.',
  ];
  const result: EmcReviewResult = {
    completeness: 'partial',
    input,
    findings,
    checks,
    summary,
    truncated: total > findings.length,
    notes: [
      'All distances and counts are user-selected engineering budgets, not regulatory limits. No EMC pass, score or certification is produced.',
      'Net roles, reference nets/layers, decoupling assignments and edge connector intent are explicit user inputs; names and library IDs are not classified automatically.',
      'Current accepted native geometry and saved fills are read without refilling, solving, editing, saving or creating undo history.',
      'Return-current continuity, actual loop inductance, dielectric/stackup impedance, differential balance, shielding, cables, filtering, emission magnitude and hardware behavior require separate evidence.',
    ],
  };
  return validateEmcReviewResult(result);
}
