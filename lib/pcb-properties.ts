import { invalidatePCBFill, type Pad, type PCB, type Footprint, type BoardZone } from './pcb';
import { flipPCBFootprint } from './pcb-layout';

type PCBZoneProperties = Partial<Omit<BoardZone, 'id' | 'locked' | 'filledPolygons'>>;

/** Undefined clears an optional override; omitted fields and native identity survive. */
export function preparePCBZoneProperties(zone: BoardZone, changes: PCBZoneProperties): BoardZone {
  if (
    zone.locked &&
    Object.entries(changes).some(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(zone[key as keyof BoardZone]),
    )
  )
    fail('Unlock the zone before editing.');
  const next = { ...zone, ...changes };
  for (const key of Object.keys(next) as (keyof BoardZone)[])
    if (next[key] === undefined) delete next[key];
  return next;
}

export type PCBFootprintProperties = Partial<
  Pick<
    Footprint,
    | 'x'
    | 'y'
    | 'rotation'
    | 'side'
    | 'reference'
    | 'value'
    | 'models'
    | 'solderMaskMargin'
    | 'solderPasteMargin'
    | 'solderPasteMarginRatio'
  >
>;

/** Side changes transform local pads, artwork and models together. */
export function preparePCBFootprintProperties(
  footprint: Footprint,
  changes: PCBFootprintProperties,
): Footprint {
  if (
    footprint.locked &&
    Object.entries(changes).some(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(footprint[key as keyof Footprint]),
    )
  )
    fail('Unlock the footprint before editing.');
  const retainedPaths = new Set(footprint.models?.map((model) => model.path));
  for (const model of changes.models ?? [])
    if (!retainedPaths.has(model.path)) validateFootprintModelPath(model.path);
  const basis =
    changes.side && changes.side !== footprint.side ? flipPCBFootprint(footprint) : footprint;
  const next = { ...basis, ...changes };
  for (const key of Object.keys(next) as (keyof Footprint)[])
    if (next[key] === undefined) delete next[key];
  return next;
}

export function validateFootprintModelPath(path: string): void {
  if (
    path.length > 4096 ||
    !/^\$\{(?:KIPRJMOD|KICAD\d+_3DMODEL_DIR)\}\/[^\0\r\n]+\.(?:step|stp|wrl)$/i.test(path) ||
    path.split(/[\\/]/).some((part) => part === '..')
  )
    throw new Error('Use a project-relative STEP file or a library model.');
}

export function setPCBViaProperties(
  board: PCB,
  viaId: string,
  changes: Partial<Omit<PCB['vias'][number], 'id'>>,
): PCB {
  if (!board.vias.some((via) => via.id === viaId)) fail('This via no longer exists.');
  const via = board.vias.find((via) => via.id === viaId)!;
  if (
    via.locked &&
    Object.entries(changes).some(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(via[key as keyof typeof via]),
    )
  )
    fail('Unlock the via before editing.');
  return {
    ...board,
    vias: board.vias.map((via) => (via.id === viaId ? { ...via, ...changes } : via)),
  };
}

export type PCBPadProperties = Partial<
  Omit<
    Pad,
    'id' | 'number' | 'netId' | 'type' | 'layers' | 'unconnected' | 'outline' | 'customAnchor'
  >
>;

const padPropertyKeys = new Set([
  'x',
  'y',
  'rotation',
  'size',
  'shape',
  'drill',
  'drillOffset',
  'drillSlot',
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
  if (pad.locked || footprint.locked) fail('Unlock the pad and its footprint before editing.');
  for (const key of Object.keys(changes)) {
    if (!padPropertyKeys.has(key))
      fail('Pad identity, connectivity, type and layers cannot be changed here.');
    if (requiredPadKeys.has(key) && changes[key as keyof PCBPadProperties] === undefined)
      fail('Pad geometry cannot be removed.');
  }
  const next = { ...pad, ...changes };
  if (next.shape !== pad.shape && (next.shape === 'custom' || pad.shape === 'custom'))
    fail('Edit the custom pad outline in the footprint drawing or native Source.');
  for (const key of Object.keys(changes) as (keyof PCBPadProperties)[])
    if (changes[key] === undefined) delete next[key];
  if (changes.size) next.size = { ...changes.size };
  if (changes.drillOffset) next.drillOffset = { ...changes.drillOffset };
  if (changes.drillSlot) next.drillSlot = { ...changes.drillSlot };
  if (changes.chamfer) next.chamfer = [...changes.chamfer];
  if (next.shape === 'circle' || next.customAnchor === 'circle') {
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
  if (
    next.type === 'smd' &&
    (next.drill !== undefined || next.drillOffset !== undefined || next.drillSlot)
  )
    fail('SMD pads cannot have a drill or drill offset.');
  if (next.type !== 'smd' && (!Number.isFinite(next.drill) || next.drill! <= 0))
    fail('Through-hole pads require a positive drill.');
  if (
    next.type === 'thru_hole' &&
    !next.outline &&
    next.drill! >= Math.min(next.size.x, next.size.y)
  )
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
