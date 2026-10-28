import { invalidatePCBFill, type Pad, type PCB } from './pcb';

export type PCBPadProperties = Partial<
  Omit<Pad, 'id' | 'number' | 'netId' | 'type' | 'layers' | 'unconnected'>
>;

const padPropertyKeys = new Set([
  'x',
  'y',
  'rotation',
  'size',
  'shape',
  'drill',
  'drillOffset',
  'roundrectRatio',
  'chamferRatio',
  'chamfer',
  'solderMaskMargin',
  'solderPasteMargin',
  'solderPasteMarginRatio',
  'thermalBridgeAngle',
  'zoneConnect',
  'removeUnusedLayers',
]);
const requiredPadKeys = new Set(['x', 'y', 'rotation', 'size', 'shape']);
function fail(message: string): never {
  throw new Error(`Layout: ${message}`);
}

/** Pad coordinates remain local to their existing footprint; nets and pin identity
 * continue to belong to the schematic. Complete validation remains in Core. */
export function setPCBPadProperties(board: PCB, padId: string, changes: PCBPadProperties): PCB {
  const footprint = board.footprints.find((item) => item.pads.some((pad) => pad.id === padId));
  const pad = footprint?.pads.find((item) => item.id === padId);
  if (!footprint || !pad) fail('The inspected pad is no longer on this board.');
  for (const key of Object.keys(changes)) {
    if (!padPropertyKeys.has(key))
      fail('Pad identity, connectivity, type and layers cannot be changed here.');
    if (requiredPadKeys.has(key) && changes[key as keyof PCBPadProperties] === undefined)
      fail('Pad geometry cannot be removed.');
  }
  const next = { ...pad, ...changes };
  for (const key of Object.keys(changes) as (keyof PCBPadProperties)[])
    if (changes[key] === undefined) delete next[key];
  if (changes.size) next.size = { ...changes.size };
  if (changes.drillOffset) next.drillOffset = { ...changes.drillOffset };
  if (changes.chamfer) next.chamfer = [...changes.chamfer];
  if (next.shape === 'circle') {
    // A single dimension field edits the circle diameter on either axis.
    const diameter =
      changes.size && changes.size.x === pad.size.x && changes.size.y !== pad.size.y
        ? changes.size.y
        : next.size.x;
    next.size = { x: diameter, y: diameter };
  }
  if (next.shape === 'roundrect') next.roundrectRatio ??= 0.25;
  else {
    delete next.roundrectRatio;
    delete next.chamferRatio;
    delete next.chamfer;
  }
  if (
    ![next.x, next.y, next.rotation, next.size.x, next.size.y].every(Number.isFinite) ||
    next.size.x <= 0 ||
    next.size.y <= 0
  )
    fail('Pad position, rotation and positive size must be finite.');
  if (next.type === 'smd' && (next.drill !== undefined || next.drillOffset !== undefined))
    fail('SMD pads cannot have a drill or drill offset.');
  if (next.type !== 'smd' && (!Number.isFinite(next.drill) || next.drill! <= 0))
    fail('Through-hole pads require a positive drill.');
  if (next.type === 'thru_hole' && next.drill! >= Math.min(next.size.x, next.size.y))
    fail('Through-hole drill must be smaller than its pad.');
  if (JSON.stringify(next) === JSON.stringify(pad)) return board;
  return invalidatePCBFill(board, {
    ...board,
    footprints: board.footprints.map((item) =>
      item === footprint
        ? { ...item, pads: item.pads.map((item) => (item.id === padId ? next : item)) }
        : item,
    ),
  });
}

/** Exact numeric endpoint edits are independent of connected drag gestures. */
export function setPCBTrackEndpoints(
  board: PCB,
  trackId: string,
  changes: Partial<Pick<PCB['tracks'][number], 'start' | 'end'>>,
): PCB {
  const track = board.tracks.find((item) => item.id === trackId);
  if (!track) fail('The selected track is no longer on this board.');
  const next = {
    ...track,
    ...(changes.start ? { start: { ...changes.start } } : {}),
    ...(changes.end ? { end: { ...changes.end } } : {}),
  };
  if (![next.start.x, next.start.y, next.end.x, next.end.y].every(Number.isFinite))
    fail('Track endpoints must be finite.');
  if (JSON.stringify(next) === JSON.stringify(track)) return board;
  if (track.locked) fail('Unlock the track before changing its endpoints.');
  return invalidatePCBFill(board, {
    ...board,
    tracks: board.tracks.map((item) => (item === track ? next : item)),
  });
}
