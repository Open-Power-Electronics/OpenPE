import { uid, type Point } from './circuit';
import type { BoardLine, Footprint, Pad, PCB } from './pcb';
import { assertPCBLockedEdits } from './pcb-lock';
import { padCopperLayers } from './pcb-connectivity';
import { padApertureLayers, padHasElectricalPin } from './pcb-pad-role';
import {
  insidePolygon,
  pointSegmentDistance,
  segmentDistance,
  trackTouchesPolygon,
} from './pcb-collision';
import { padPolygon } from './pcb-polygons';
import { validateCustomPad } from './pcb-custom-pad';
import { runPCBDesignRules } from './pcb-drc';
import { padDrillLine } from './pcb-layout';

export type FootprintDrawing = {
  pads: (Omit<Pad, 'id' | 'netId' | 'locked' | 'unconnected' | 'heatsink'> & { id?: string })[];
  graphics: (Omit<BoardLine, 'id' | 'locked'> & { id?: string })[];
};

type Shape = { properties: Record<string, unknown>; required: string[] };

/** The generator remains the single owner of canonical PCB record shapes. */
export function footprintDrawingSchema(schemas: { pad: Shape; graphic: Shape }) {
  const editable = (schema: Shape, excluded: string[]) => ({
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties).filter(([key]) => !excluded.includes(key)),
    ),
    required: schema.required.filter((key) => key !== 'id' && !excluded.includes(key)),
  });
  return {
    type: 'object',
    properties: {
      pads: {
        type: 'array',
        maxItems: 2000,
        items: editable(schemas.pad, ['netId', 'locked', 'unconnected', 'heatsink']),
      },
      graphics: {
        type: 'array',
        maxItems: 10000,
        items: editable(schemas.graphic, ['locked']),
      },
    },
    required: ['pads', 'graphics'],
    additionalProperties: false,
  };
}

/** Return an independent local-coordinate drawing, without connectivity authority. */
export function readFootprintDrawing(footprint: Footprint): FootprintDrawing {
  return structuredClone({
    pads: footprint.pads.map(
      ({ netId: _net, locked: _lock, unconnected: _nc, heatsink: _heatsink, ...pad }) => pad,
    ),
    graphics: footprint.graphics.map(({ locked: _lock, ...graphic }) => graphic),
  });
}

export type FootprintDrawingInput = {
  footprintId?: string;
  partId?: string;
  /** Used for a newly created embedded package; existing library identity is retained. */
  name: string;
  position?: Point;
  reference?: string;
  value?: string;
  drawing: FootprintDrawing;
};

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const padCopperInput = (pad: Pad) => ({
  x: pad.x,
  y: pad.y,
  rotation: pad.rotation,
  size: pad.size,
  type: pad.type,
  shape: pad.shape,
  outline: pad.outline,
  drill: pad.drill,
  drillOffset: pad.drillOffset,
  drillSlot: pad.drillSlot,
  roundrectRatio: pad.roundrectRatio,
  chamferRatio: pad.chamferRatio,
  chamfer: pad.chamfer,
  layers: pad.layers,
});
function fail(message: string): never {
  throw new Error(`Footprint drawing: ${message}`);
}
const finiteCoordinate = (value: number) =>
  Number.isFinite(value) &&
  Math.abs(value) <= 100000 &&
  Math.abs(value * 1e6 - Math.round(value * 1e6)) < 0.0001;

function validatePad(pad: Pad) {
  if (![pad.x, pad.y, pad.rotation].every(finiteCoordinate))
    fail('Pad positions and rotation must be finite at 0.000001 precision.');
  const minimumSize = pad.customAnchor === 'circle' ? 0.000001 : 0.0001;
  if (![pad.size?.x, pad.size?.y].every((n) => Number.isFinite(n) && n >= minimumSize && n <= 1000))
    fail(`Pad sizes must be between ${minimumSize} and 1000 mm.`);
  if (!['smd', 'thru_hole', 'np_thru_hole'].includes(pad.type)) fail('Unsupported pad type.');
  if (!['rect', 'circle', 'oval', 'roundrect', 'custom'].includes(pad.shape))
    fail('Unsupported pad shape.');
  validateCustomPad(pad, fail);
  if (pad.shape === 'circle' && pad.size.x !== pad.size.y)
    fail('Circular pads require equal width and height.');
  if (
    pad.type === 'smd' &&
    (pad.drill !== undefined || pad.drillOffset !== undefined || pad.drillSlot !== undefined)
  )
    fail('SMD pads cannot have drills.');
  if (
    pad.type !== 'smd' &&
    (!Number.isFinite(pad.drill) || pad.drill! < 0.0001 || pad.drill! > 1000)
  )
    fail('Through-hole pads require a positive drill.');
  if (pad.type === 'thru_hole' && !pad.outline && pad.drill! >= Math.min(pad.size.x, pad.size.y))
    fail('A plated drill must be smaller than its pad.');
  if (
    pad.shape === 'roundrect' &&
    (pad.roundrectRatio === undefined || pad.roundrectRatio < 0 || pad.roundrectRatio > 0.5)
  )
    fail('Rounded pads require a corner ratio between 0 and 0.5.');
}

/** Guard fixed route contacts while editing a local package; copper is never moved. */
function hasRoutedContact(board: PCB, footprint: Footprint, pad: Pad, spend: () => void) {
  if (!pad.netId || pad.type === 'np_thru_hole') return false;
  const layers = padCopperLayers(board, footprint, pad);
  const polygon = padPolygon(footprint, pad);
  for (const track of board.tracks) {
    spend();
    if (
      track.netId === pad.netId &&
      layers.includes(track.layer) &&
      trackTouchesPolygon(track, polygon, spend)
    )
      return true;
  }
  for (const via of board.vias) {
    spend();
    if (via.netId !== pad.netId || !layers.length) continue;
    if (insidePolygon(via, polygon, spend)) return true;
    for (let i = 0; i < polygon.outer.length; i++) {
      spend();
      if (
        pointSegmentDistance(
          via,
          polygon.outer[i],
          polygon.outer[(i + 1) % polygon.outer.length],
        ) <=
        (via.diameter / 2) ** 2
      )
        return true;
    }
  }
  return false;
}

/** Prepare one complete package drawing. Core owns final project validation/fills/undo. */
export function prepareFootprintDrawing(
  board: PCB,
  input: FootprintDrawingInput,
): { board: PCB; footprintId: string } {
  const original = input.footprintId
    ? board.footprints.find((footprint) => footprint.id === input.footprintId)
    : undefined;
  if (input.footprintId && !original) fail('The package no longer exists.');
  if (!Array.isArray(input.drawing?.pads) || !Array.isArray(input.drawing.graphics))
    fail('Supply complete pads and graphics arrays.');
  if (input.drawing.pads.length > 2000 || input.drawing.graphics.length > 10000)
    fail('The package exceeds its geometry limit.');
  if (!original && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(input.name))
    fail('Use a package name of 1–80 letters, digits, dots, underscores or hyphens.');
  if (!original && input.partId && board.footprints.some((f) => f.symbolId === input.partId))
    fail('This component already has a package.');
  if (original && input.partId !== undefined && input.partId !== original.symbolId)
    fail('An existing package cannot be reassigned to another component.');
  const position = original ?? input.position ?? { x: 0, y: 0 };
  if (![position.x, position.y].every(finiteCoordinate)) fail('The package origin is invalid.');
  const used = new Set<string>();
  const preparedPads = input.drawing.pads.map((drawing): Pad => {
    if ('netId' in drawing || 'locked' in drawing || 'unconnected' in drawing)
      fail('Pad connectivity and locks are not drawing fields.');
    if ('heatsink' in drawing) fail('Pad fabrication properties are preserved from native data.');
    const byId = drawing.id ? original?.pads.find((pad) => pad.id === drawing.id) : undefined;
    if (drawing.id && !byId) fail('A pad ID is not part of this package; omit IDs for new pads.');
    const electrical = padHasElectricalPin(drawing);
    const apertureLayers = padApertureLayers(drawing);
    const sameNumber =
      original?.pads.filter(
        (pad) =>
          pad.number === drawing.number &&
          padHasElectricalPin(pad) === electrical &&
          padApertureLayers(pad)?.toSorted().join(',') === apertureLayers?.toSorted().join(','),
      ) ?? [];
    const matches = sameNumber.filter((pad) => !used.has(pad.id));
    if (!drawing.id && matches.length > 1)
      fail('Repeated pad numbers require their existing pad IDs.');
    const previous = byId || (matches.length === 1 ? matches[0] : undefined);
    if (previous && used.has(previous.id)) fail('A pad can appear only once in a drawing.');
    if (previous) used.add(previous.id);
    if (previous?.netId && drawing.number !== previous.number)
      fail('A connected pad number cannot change.');
    if (previous?.netId && drawing.type === 'np_thru_hole')
      fail('A connected pad cannot become a mechanical hole.');
    if (previous?.netId && apertureLayers)
      fail('A connected pad cannot become a mask or paste aperture.');
    const netId = previous?.netId ?? sameNumber[0]?.netId ?? null;
    const next: Pad = {
      ...previous,
      ...structuredClone(drawing),
      id: previous?.id ?? uid(),
      netId: electrical ? netId : null,
    };
    if (next.shape !== 'custom' && drawing.outline === undefined) delete next.outline;
    if (next.shape !== 'custom' && drawing.customAnchor === undefined) delete next.customAnchor;
    if (next.type === 'smd') {
      if (drawing.drill === undefined) delete next.drill;
      if (drawing.drillOffset === undefined) delete next.drillOffset;
      if (drawing.drillSlot === undefined) delete next.drillSlot;
    }
    if (next.shape !== 'roundrect') {
      if (
        [drawing.roundrectRatio, drawing.chamferRatio, drawing.chamfer].some(
          (value) => value !== undefined,
        )
      )
        fail('Corner overrides require a rounded rectangular pad.');
      delete next.roundrectRatio;
      delete next.chamferRatio;
      delete next.chamfer;
    }
    validatePad(next);
    return previous && equal(previous, next) ? previous : next;
  });
  const pads =
    original &&
    original.pads.length === preparedPads.length &&
    preparedPads.every((pad, index) => pad === original.pads[index])
      ? original.pads
      : preparedPads;
  const preparedGraphics = input.drawing.graphics.map((drawing): BoardLine => {
    if ('locked' in drawing) fail('Graphic locks are not drawing fields.');
    if ((drawing.kind === 'arc') !== (drawing.mid !== undefined))
      fail('Arcs require exactly one middle point.');
    if (drawing.points !== undefined && drawing.kind !== 'polygon')
      fail('Only polygon graphics accept intermediate points.');
    if (drawing.kind === 'polygon' && !drawing.points?.length)
      fail('Polygon graphics require at least three vertices.');
    if ((drawing.kind === 'text') !== (drawing.text !== undefined))
      fail('Text graphics require text properties.');
    if (drawing.fill !== undefined && drawing.kind !== 'circle' && drawing.kind !== 'polygon')
      fail('Only circles and polygons support fill.');
    const previous = drawing.id
      ? original?.graphics.find((graphic) => graphic.id === drawing.id)
      : undefined;
    if (drawing.id && !previous)
      fail('A graphic ID is not part of this package; omit IDs for new graphics.');
    const next = { ...previous, ...structuredClone(drawing), id: previous?.id ?? uid() };
    if (next.kind === 'dimension')
      fail('Footprint dimensions are unsupported; use board dimensions.');
    if (previous && previous.kind !== next.kind) {
      if (next.kind !== 'arc') delete next.mid;
      if (next.kind !== 'polygon') delete next.points;
      if (next.kind !== 'text') delete next.text;
      if (next.kind !== 'circle' && next.kind !== 'polygon') delete next.fill;
    }
    if (used.has(next.id)) fail('A graphic can appear only once in a drawing.');
    used.add(next.id);
    return previous && equal(previous, next) ? previous : next;
  });
  const graphics =
    original &&
    original.graphics.length === preparedGraphics.length &&
    preparedGraphics.every((graphic, index) => graphic === original.graphics[index])
      ? original.graphics
      : preparedGraphics;
  const reference =
    input.reference ??
    `FP${Array.from({ length: board.footprints.length + 1 }, (_, i) => i + 1).find((n) => !board.footprints.some((f) => f.reference === `FP${n}`))}`;
  const footprint: Footprint = original
    ? { ...original, pads, graphics }
    : {
        id: uid(),
        libraryId: `OpenPE:${input.name}`,
        symbolId: input.partId ?? null,
        x: position.x,
        y: position.y,
        rotation: 0,
        side: 'front',
        pads,
        graphics,
        ...(input.partId ? {} : { reference, value: input.value ?? input.name }),
      };
  if (original) {
    let work = 0;
    const spend = () => {
      if (++work > 2_000_000) fail('Route contact checks exceed the geometry limit.');
    };
    for (const pad of original.pads) {
      const next = pads.find((candidate) => candidate.id === pad.id);
      if (!next && pad.netId) fail('A connected pad cannot be removed from the package.');
      if (
        next &&
        !equal(padCopperInput(pad), padCopperInput(next)) &&
        hasRoutedContact(board, original, pad, spend)
      )
        fail('A routed pad cannot change its copper geometry in the package drawing.');
    }
  }
  if (original && equal(original, footprint)) return { board, footprintId: original.id };
  const next = {
    ...board,
    footprints: original
      ? board.footprints.map((candidate) => (candidate === original ? footprint : candidate))
      : [...board.footprints, footprint],
  };
  assertPCBLockedEdits(board, next);
  const changed = new Set([
    ...pads
      .filter((pad) => {
        const before = original?.pads.find((item) => item.id === pad.id);
        return !before || !equal(padCopperInput(before), padCopperInput(pad));
      })
      .map((pad) => pad.id),
    ...graphics
      .filter(
        (graphic) =>
          graphic.layer.endsWith('.Cu') &&
          !equal(
            original?.graphics.find((item) => item.id === graphic.id),
            graphic,
          ),
      )
      .map((graphic) => graphic.id),
  ]);
  if (changed.size) {
    // NPTH holes contain no copper, so they need the same explicit hole overlap
    // guard as via placement rather than relying on copper DRC bodies.
    const holes = [
      ...next.footprints.flatMap((owner) =>
        owner.pads.flatMap((pad) =>
          pad.drill ? [{ id: pad.id, line: padDrillLine(owner, pad), radius: pad.drill / 2 }] : [],
        ),
      ),
      ...next.vias.map((via) => ({ id: via.id, line: [via, via] as const, radius: via.drill / 2 })),
    ];
    let holeWork = 0;
    for (const hole of holes.filter((hole) => changed.has(hole.id)))
      for (const other of holes) {
        if (++holeWork > 2_000_000) fail('Drill collision checks exceed the geometry limit.');
        if (
          hole.id !== other.id &&
          segmentDistance(hole.line[0], hole.line[1], other.line[0], other.line[1]) <
            (hole.radius + other.radius - 0.000001) ** 2
        )
          fail('Drilled holes cannot overlap existing pad or via holes.');
      }
    const checked = runPCBDesignRules(next);
    if (checked.truncated || checked.issues.some((issue) => issue.ruleId === 'pcb.geometry-limit'))
      fail('Copper collision checks exceed the supported geometry limit.');
    const blocked = checked.issues.find(
      (issue) =>
        [
          'pcb.short',
          'pcb.clearance',
          'pcb.unassigned-copper',
          'pcb.copper-edge',
          'pcb.copper-hole',
          'pcb.keepout',
          'pcb.unsupported-copper',
        ].includes(issue.ruleId) && issue.objectIds.some((id) => changed.has(id)),
    );
    if (blocked) fail(`Copper is blocked: ${blocked.message}`);
  }
  return { board: next, footprintId: footprint.id };
}
