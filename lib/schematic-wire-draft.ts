import type { Point } from './circuit';
import { wireRoute } from './wiring';

// Each committed segment contributes two anchors to document grouping.
export const schematicWireDraftPointLimit = 15_001;
type WireDraftCheckpoint = { readonly pointCount: number; readonly vertical: boolean };
export type SchematicWireDraft = {
  readonly points: readonly Point[];
  readonly vertical: boolean;
  readonly checkpoints: readonly WireDraftCheckpoint[];
};

function checkedPoint(point: Point): Point {
  if (
    ![point.x, point.y].every(
      (coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 100_000,
    )
  )
    throw new Error('Wire coordinates must be finite and within 100,000 mm of the origin.');
  return { x: point.x, y: point.y };
}

function liveLeg(draft: SchematicWireDraft, target: Point): Point[] {
  const last = draft.points.at(-1);
  if (!last) throw new Error('The wire draft has no starting point.');
  const leg = wireRoute(last, checkedPoint(target), draft.vertical).slice(1);
  if (draft.points.length + leg.length > schematicWireDraftPointLimit)
    throw new Error(
      'The wire draft exceeds 30,000 anchors. Remove a waypoint or finish at the last waypoint.',
    );
  return leg;
}

export function createSchematicWireDraft(start: Point, vertical = false): SchematicWireDraft {
  return { points: [checkedPoint(start)], vertical, checkpoints: [] };
}

/** Lock one click, including its generated elbow, without editing the document. */
export function extendSchematicWireDraft(
  draft: SchematicWireDraft,
  target: Point,
): SchematicWireDraft {
  const leg = liveLeg(draft, target);
  if (!leg.length) return draft;
  return {
    points: [...draft.points, ...leg],
    vertical: draft.vertical,
    checkpoints: [
      ...draft.checkpoints,
      { pointCount: draft.points.length, vertical: draft.vertical },
    ],
  };
}

export function toggleSchematicWirePosture(draft: SchematicWireDraft): SchematicWireDraft {
  return { ...draft, vertical: !draft.vertical };
}

/** Undo one click rather than one elbow. Backtracking the initial point cancels. */
export function backtrackSchematicWireDraft(draft: SchematicWireDraft): SchematicWireDraft | null {
  const checkpoint = draft.checkpoints.at(-1);
  if (!checkpoint) return null;
  if (
    !Number.isInteger(checkpoint.pointCount) ||
    checkpoint.pointCount < 1 ||
    checkpoint.pointCount >= draft.points.length
  )
    throw new Error('The wire draft checkpoint is invalid. Cancel this wire and start again.');
  return {
    points: draft.points.slice(0, checkpoint.pointCount),
    vertical: checkpoint.vertical,
    checkpoints: draft.checkpoints.slice(0, -1),
  };
}

/** The visible path is also the complete Enter/double-click commit payload. */
export function previewSchematicWireDraft(draft: SchematicWireDraft, head: Point | null): Point[] {
  const leg = head ? liveLeg(draft, head) : [];
  if (draft.points.length > schematicWireDraftPointLimit)
    throw new Error(
      'The wire draft exceeds 30,000 anchors. Remove a waypoint or finish at the last waypoint.',
    );
  return [...draft.points, ...leg].map((point) => ({ x: point.x, y: point.y }));
}
