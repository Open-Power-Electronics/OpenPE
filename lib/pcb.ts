import { type Circuit, type Point } from './circuit';
import {
  child,
  parseOwnedSExpr,
  parseSExpr,
  quote as q,
  val,
  writeSExpr,
  type SExpr,
} from './sexpr';
import { KICAD_PCB_VERSION } from './kicad-version';
import { MAX_NATIVE_PCB_BYTES, MAX_NATIVE_PCB_NODES } from './project-size-limits';
import {
  pcbNativeCopperLayerId,
  pcbUserLayers,
  type BoardLayer,
  type CopperLayer,
} from './pcb-layer-stack';
import { isOwnedPCB, isOwnedProjectNode, ownProjectData } from './immutable-project';
import { padDrillSize, writePCBPadPostMachining, type PCBPadPostMachining } from './pcb-drill';
import { footprintPoint } from './pcb-layout';
import type { NativeCustomPad } from './pcb-native-custom-pad';
import { writePCBTextRenderCache, type PCBTextRenderCache } from './pcb-text';
import {
  pcbFootprintZoneOverrideFields,
  pcbPadZoneOverrideFields,
  pcbZoneHatchNumericFields,
  type PCBPlacementArea,
  type PCBZoneHatchFill,
  type PCBZoneOverrides,
} from './pcb-zone-settings';
import {
  writePCBTeardropSettings,
  type PCBTeardropKind,
  type PCBTeardropSettings,
} from './pcb-teardrops';
import { defaultPCBTeardropThermal } from './pcb-teardrop-settings';
import { writePCBViaTenting } from './pcb-via-tenting';
import { hasPCBPhysicalBarcode } from './pcb-barcode';
import {
  pcbViaHasTreatment,
  writePCBViaBackdrills,
  writePCBViaPruning,
  writePCBViaTreatment,
  type PCBViaBackdrills,
  type PCBViaPruning,
  type PCBViaSpan,
  type PCBViaTreatment,
} from './pcb-native-via';
import {
  writePCBPadstack,
  writePCBViaPadstack,
  type PCBPadstack,
  type PCBViaPadstack,
} from './pcb-padstack';

const fmt = (n: number) => String(Number(n.toFixed(12)));
export type { BoardLayer, CopperLayer } from './pcb-layer-stack';
export type BoardText = {
  value: string;
  nativeExpansion?: { source: string; value: string };
  rotation: number;
  size: Point;
  thickness: number;
  lineSpacing?: number;
  justify?: ('left' | 'right' | 'top' | 'bottom' | 'mirror')[];
  hidden?: boolean;
  italic?: boolean;
  bold?: boolean;
  property?: string;
  fontFace?: string;
  renderCache?: PCBTextRenderCache;
  knockout?: true;
};
export type BoardLine = {
  locked?: true;
  id: string;
  start: Point;
  end: Point;
  width: number;
  layer: BoardLayer;
  netId?: string;
  maskLayer?: 'F.Mask' | 'B.Mask';
  solderMaskMargin?: number;
  kind?: 'arc' | 'circle' | 'curve' | 'polygon' | 'text' | 'dimension' | 'point';
  mid?: Point;
  /** Polygon intermediate vertices or the two cubic Bézier control points. */
  points?: Point[];
  roundedRectRadius?: number;
  polygonArcs?: { vertex: number; mid: Point }[];
  nativeNoStroke?: true;
  fill?: boolean;
  stroke?: 'default' | 'solid' | 'dash' | 'dot' | 'dash_dot' | 'dash_dot_dot';
  text?: BoardText;
  /** A native text box has an independent border and optional polygon shape. */
  textBox?: {
    outline?: Point[];
    margins: [number, number, number, number];
    border: boolean;
    strokeWidth: number;
  };
  /** Footprint text with native free rotation. Omitted for upright text. */
  keepUpright?: false;
  dimension?: {
    type: 'aligned' | 'orthogonal' | 'radial' | 'leader' | 'center';
    height?: number;
    orientation?: 0 | 1;
    leaderLength?: number;
    format?: {
      prefix: string;
      suffix: string;
      units: number;
      unitsFormat: number;
      precision: number;
      overrideValue?: string;
      suppressZeroes?: boolean;
    };
    style: {
      arrowLength: number;
      textPositionMode: number;
      arrowDirection?: 'inward' | 'outward';
      extensionHeight?: number;
      extensionOffset: number;
      keepTextAligned?: boolean;
      textFrame?: number;
    };
    caption?: Point & BoardText;
  };
};
export type Pad = Point &
  PCBZoneOverrides & {
    locked?: true;
    id: string;
    number: string;
    rotation: number;
    type: 'smd' | 'thru_hole' | 'np_thru_hole';
    shape: 'rect' | 'circle' | 'oval' | 'roundrect' | 'trapezoid' | 'custom';
    /** Size of the native anchor for a custom pad. */
    size: Point;
    trapezoidDelta?: Point;
    padstack?: PCBPadstack;
    /** Native custom pad anchor shape. Omitted for the rectangular anchor. */
    customAnchor?: 'circle';
    nativeCustomPad?: NativeCustomPad;
    /** KiCad edge-connector attribute. Its copper stays in the surface-mount geometry path. */
    nativeConnect?: true;
    /** Filled polygon in the pad-local frame, including its anchor. */
    outline?: Point[];
    drill?: number;
    netId: string | null;
    layers?: (BoardLayer | '*.Cu' | 'F&B.Cu' | '*.Mask' | '*.SilkS')[];
    drillOffset?: Point;
    /** Overall slot length and long axis in pad-local coordinates. Drill is the tool diameter. */
    drillSlot?: { length: number; axis: 'x' | 'y' };
    /** KiCad retains the optional Y value of a round drill, whose diameter comes from X. */
    nativeRoundDrillY?: number;
    roundrectRatio?: number;
    chamferRatio?: number;
    chamfer?: ('top_left' | 'top_right' | 'bottom_left' | 'bottom_right')[];
    solderMaskMargin?: number;
    solderPasteMargin?: number;
    solderPasteMarginRatio?: number;
    thermalBridgeAngle?: number;
    teardrops?: PCBTeardropSettings;
    removeUnusedLayers?: boolean;
    keepEndLayers?: boolean;
    zoneLayerConnections?: CopperLayer[];
    postMachining?: PCBPadPostMachining;
    dieLength?: number;
    dieDelay?: number;
    /** KiCad's native pad fabrication property. */
    heatsink?: true;
    fabricationProperty?:
      | 'pad_prop_bga'
      | 'pad_prop_mechanical'
      | 'pad_prop_pressfit'
      | 'pad_prop_fiducial_glob'
      | 'pad_prop_fiducial_loc'
      | 'pad_prop_castellated'
      | 'pad_prop_testpoint';
    /** Unassigned package pad absent from the source device's pin map. */
    unconnected?: true;
  };
export type FootprintModel = {
  path: string;
  offset: Point & { z: number };
  scale: Point & { z: number };
  rotation: Point & { z: number };
  hidden?: boolean;
  /** Native instance opacity, from transparent (0) to opaque (1). */
  opacity?: number;
};
export type Footprint = Point &
  Pick<PCBZoneOverrides, 'copperClearance' | 'zoneConnect'> & {
    id: string;
    symbolId: string | null;
    libraryId: string;
    rotation: number;
    side: 'front' | 'back';
    pads: Pad[];
    graphics: BoardLine[];
    referencePoints?: (Point & { id: string; size: number; layer: BoardLayer })[];
    reference?: string;
    value?: string;
    nativeMissingReference?: true;
    nativeMissingValue?: true;
    /** Exact KiCad group text, containing comma-separated electrical pad numbers. */
    netTiePadGroups?: string[];
    jumperPadGroups?: string[][];
    zones?: BoardZone[];
    models?: FootprintModel[];
    /** Native footprint editing lock. */
    locked?: true;
    solderMaskMargin?: number;
    solderPasteMargin?: number;
    solderPasteMarginRatio?: number;
  };
export type BoardZone = {
  locked?: true;
  id: string;
  netId: string | null;
  layer: BoardLayer;
  outline: Point[];
  /** Native full-circle rule area: the outline contains exactly two diametric points. */
  nativeCircularOutline?: true;
  /** Native arc edges in a single rule-area contour. */
  nativeOutlineArcs?: NonNullable<BoardLine['polygonArcs']>;
  holes?: Point[][];
  /** Saved native-style contours; doubled bridges represent holes without filling them.
   * Missing means unfilled; an empty array is a completed fill with no copper. */
  filledPolygons?: { points: Point[]; island?: true }[];
  /** An unassigned copper fill accepted from native saved contours. */
  nativeUnassignedFill?: true;
  clearance: number;
  minThickness: number;
  thermalGap: number;
  thermalBridge: number;
  priority?: number;
  teardrop?: PCBTeardropKind;
  padConnection?: 'yes' | 'no' | 'thru_hole_only';
  islandRemovalMode?: number;
  islandAreaMin?: number;
  cornerSmoothing?: { style: 'chamfer' | 'fillet'; radius?: number };
  /** Native per-layer hatch origin in the board file coordinate frame. */
  hatchPosition?: Point;
  hatchFill?: PCBZoneHatchFill;
  nativePlacement?: PCBPlacementArea;
  fillEnabled?: boolean;
  keepout?: {
    tracks: boolean;
    vias: boolean;
    pads: boolean;
    copperpour: boolean;
    footprints: boolean;
  };
};

/** Compare native track fields that affect copper, ignoring the editing lock. */
export function samePCBTrackCopper(a: PCB['tracks'][number], b: PCB['tracks'][number]): boolean {
  return (
    a.id === b.id &&
    a.netId === b.netId &&
    a.layer === b.layer &&
    a.maskLayer === b.maskLayer &&
    a.solderMaskMargin === b.solderMaskMargin &&
    a.width === b.width &&
    a.start.x === b.start.x &&
    a.start.y === b.start.y &&
    a.end.x === b.end.x &&
    a.end.y === b.end.y
  );
}

/** Compare electrical pour inputs independently of their saved contours.
 * Captions, models, locks and mere viewing never change these inputs. */
export function pcbFillInputsChanged(previous: PCB, next: PCB): boolean {
  if (previous === next) return false;
  // A changed copper span already proves that saved fills are stale. Avoid
  // serializing unrelated pads/artwork for every interactive track pose.
  // Lock-only and other presentation edits still use the complete comparison.
  if (
    previous.tracks !== next.tracks &&
    (previous.tracks.length !== next.tracks.length ||
      previous.tracks.some((track, index) => !samePCBTrackCopper(track, next.tracks[index])))
  )
    return true;
  if (previous.arcTracks !== next.arcTracks) {
    const before = previous.arcTracks ?? [];
    const after = next.arcTracks ?? [];
    if (
      before.length !== after.length ||
      before.some(
        (arc, index) =>
          !samePCBTrackCopper(arc, after[index]) ||
          arc.mid.x !== after[index].mid.x ||
          arc.mid.y !== after[index].mid.y,
      )
    )
      return true;
  }
  const zoneInput = ({ filledPolygons: _filled, ...zone }: BoardZone) => zone;
  // Disabled zones are only editable outlines: adding, assigning or reshaping
  // one cannot change existing copper. Rule areas remain obstacles regardless
  // of their fill flag; enabling a zone brings it back into this comparison.
  const zoneInputs = (zones: BoardZone[]) =>
    zones
      .filter((zone) => zone.outline.length && (zone.keepout || zone.fillEnabled !== false))
      .map(zoneInput);
  const copperGraphics = (graphics: BoardLine[]) =>
    graphics.filter((g) => g.layer === 'Edge.Cuts' || g.layer.endsWith('.Cu'));
  const inputs = (board: PCB) =>
    JSON.stringify(
      [
        board.layers,
        board.tuningPatterns,
        board.vias,
        copperGraphics(board.graphics),
        zoneInputs(board.zones),
        board.footprints.map((f) => [
          f.x,
          f.y,
          f.rotation,
          f.side,
          f.copperClearance,
          f.zoneConnect,
          f.netTiePadGroups,
          f.jumperPadGroups,
          f.pads,
          copperGraphics(f.graphics),
          zoneInputs(f.zones ?? []),
        ]),
      ],
      (key, value) => (key === 'locked' ? undefined : value),
    );
  return inputs(previous) !== inputs(next);
}

export function requireSupportedPCBCopper(
  board: PCB,
  operation: string,
  mode?: 'inspection',
): void {
  const inspection = mode === 'inspection';
  if (!inspection && hasUnassignedSavedCopperZones(board))
    throw new Error(`${operation} is unavailable on boards with unassigned native copper fills.`);
  if (!inspection && hasPCBTrackMask(board))
    throw new Error(
      `${operation} is unavailable on boards with native solder-mask track openings.`,
    );
  if (!inspection && board.arcTracks?.length)
    throw new Error(`${operation} is unavailable on boards with imported arc tracks.`);
  if (!inspection && board.tracks.some((track) => !track.netId))
    throw new Error(`${operation} is unavailable on boards with unassigned native tracks.`);
  if (!inspection && hasNativeCustomPads(board))
    throw new Error(
      `${operation} is unavailable on boards with imported native custom pad primitives.`,
    );
  if (!inspection && hasNativePCBPadPruning(board))
    throw new Error(
      `${operation} is unavailable on boards with connection-dependent pad copper layers.`,
    );
  if (hasNativePCBPadMachining(board))
    throw new Error(
      `${operation} is unavailable on boards with native pad machining or press-fit settings.`,
    );
  if (!inspection && hasNativePCBPadstacks(board))
    throw new Error(`${operation} is unavailable on boards with native layer-specific padstacks.`);
  if (!inspection && hasNativeCopperText(board))
    throw new Error(
      `${operation} is unavailable on boards with native copper text boxes, named fonts, or knockout text.`,
    );
  const footprintConnections = inspection
    ? board.footprints.some((footprint) => footprint.jumperPadGroups?.length) && 'jumper groups'
    : nativePCBFootprintConnections(board);
  if (footprintConnections)
    throw new Error(
      `${operation} is unavailable on boards with native footprint ${footprintConnections}.`,
    );
  if (!inspection && hasNativePCBGraphicCopper(board))
    throw new Error(
      `${operation} is unavailable on boards with native net or mask copper graphics.`,
    );
  if (!inspection && hasNativePCBCurvedCopper(board))
    throw new Error(
      `${operation} is unavailable with native curved polygons or Bézier graphics on copper or Edge.Cuts.`,
    );
  if (!inspection && hasNativePCBCurvedRuleAreas(board))
    throw new Error(`${operation} is unavailable with native curved rule areas.`);
  if (hasNativePCBTableOutput(board))
    throw new Error(`${operation} is unavailable with native tables on a fabrication layer.`);
  if (hasPCBPhysicalBarcode(board.barcodes))
    throw new Error(`${operation} is unavailable with native barcodes on copper or Edge.Cuts.`);
  if (!inspection && board.vias.some((via) => via.removeUnusedLayers))
    throw new Error(
      `${operation} is unavailable on boards with connection-dependent via copper layers.`,
    );
  if (
    inspection
      ? board.vias.some((via) => via.span?.kind === 'micro' || pcbViaHasTreatment(via.treatment))
      : hasNativePCBViaAuthority(board)
  )
    throw new Error(
      `${operation} is unavailable on boards with native non-through, treated, or unassigned vias.`,
    );
  if (
    !inspection &&
    (board.zones.some(
      (zone) => zone.fillEnabled !== false && (zone.cornerSmoothing?.radius ?? 0) > 0,
    ) ||
      board.footprints.some((footprint) =>
        footprint.zones?.some(
          (zone) => zone.fillEnabled !== false && (zone.cornerSmoothing?.radius ?? 0) > 0,
        ),
      ))
  )
    throw new Error(
      `${operation} is unavailable on boards with enabled native zone corner smoothing.`,
    );
}

export function hasNativePCBTableOutput(board: PCB): boolean {
  return (board.nativeTables ?? []).some((table) => {
    const layer = val(child(table, 'layer'));
    return layer === 'Edge.Cuts' || /\.(?:Cu|SilkS|Mask|Paste)$/.test(layer);
  });
}

function hasNativePCBGraphicCopper(board: PCB): boolean {
  return board.graphics.some((graphic) => graphic.netId !== undefined) || hasPCBGraphicMask(board);
}

export function hasPCBTrackMask(board: PCB): boolean {
  return (
    board.tracks.some((track) => track.maskLayer) ||
    Boolean(board.arcTracks?.some((track) => track.maskLayer))
  );
}

export function isUnassignedSavedCopperZone(zone: BoardZone): boolean {
  return zone.nativeUnassignedFill === true;
}

export function isNativePCBEdgeCutFill(zone: BoardZone): boolean {
  return zone.layer === 'Edge.Cuts' && Boolean(zone.filledPolygons?.length);
}

function hasUnassignedSavedCopperZones(board: PCB): boolean {
  return (
    board.zones.some(isUnassignedSavedCopperZone) ||
    board.footprints.some((footprint) => footprint.zones?.some(isUnassignedSavedCopperZone))
  );
}

/** Nominal aperture from the explicit native margin; KiCad rules may override it. */
export function pcbTrackMaskOpeningWidth(track: PCB['tracks'][number]): number {
  return track.maskLayer && track.solderMaskMargin !== undefined
    ? Math.max(0, track.width + 2 * track.solderMaskMargin)
    : 0;
}

function hasNativePCBCurvedCopper(board: PCB): boolean {
  const affectsCopper = (graphic: BoardLine) =>
    (graphic.polygonArcs || graphic.kind === 'curve') &&
    (graphic.layer === 'Edge.Cuts' || graphic.layer.endsWith('.Cu'));
  return (
    board.graphics.some(affectsCopper) ||
    board.footprints.some((footprint) => footprint.graphics.some(affectsCopper))
  );
}

function hasNativePCBCurvedRuleAreas(board: PCB): boolean {
  const curved = (zone: BoardZone) => zone.nativeCircularOutline || zone.nativeOutlineArcs;
  return (
    board.zones.some(curved) || board.footprints.some((footprint) => footprint.zones?.some(curved))
  );
}

export function hasNativePCBViaGeometry(board: PCB): boolean {
  return board.vias.some(
    (via) =>
      via.span !== undefined ||
      via.backdrills ||
      via.startEndOnly ||
      pcbViaHasTreatment(via.treatment),
  );
}

function hasNativePCBViaAuthority(board: PCB): boolean {
  return (
    hasNativePCBViaGeometry(board) || board.vias.some((via) => !via.netId || via.removeUnusedLayers)
  );
}

export function hasNativePCBPadstacks(board: PCB): boolean {
  return (
    board.vias.some((via) => via.padstack) ||
    board.footprints.some((footprint) => footprint.pads.some((pad) => pad.padstack))
  );
}

export function hasNativePCBPadMachining(board: PCB): boolean {
  return board.footprints.some((footprint) =>
    footprint.pads.some(
      (pad) => pad.postMachining || pad.fabricationProperty === 'pad_prop_pressfit',
    ),
  );
}

export function hasPCBGraphicMask(board: PCB): boolean {
  return (
    board.graphics.some((graphic) => graphic.maskLayer) ||
    board.footprints.some((footprint) => footprint.graphics.some((graphic) => graphic.maskLayer))
  );
}

const ownedNativeConnectionBoards = new WeakMap<
  PCB['footprints'],
  'net ties' | 'jumper groups' | null
>();
function nativePCBFootprintConnections(board: PCB) {
  const owned = isOwnedProjectNode(board.footprints);
  const cached = owned ? ownedNativeConnectionBoards.get(board.footprints) : undefined;
  if (cached !== undefined) return cached;
  const present = board.footprints.some((footprint) => footprint.netTiePadGroups?.length)
    ? 'net ties'
    : board.footprints.some((footprint) => footprint.jumperPadGroups?.length)
      ? 'jumper groups'
      : null;
  if (owned) ownedNativeConnectionBoards.set(board.footprints, present);
  return present;
}

const ownedNativeCustomPadBoards = new WeakMap<PCB['footprints'], boolean>();
export function hasNativeCustomPads(board: PCB): boolean {
  const owned = isOwnedProjectNode(board.footprints);
  const cached = owned ? ownedNativeCustomPadBoards.get(board.footprints) : undefined;
  if (cached !== undefined) return cached;
  const hasNative = board.footprints.some((footprint) =>
    footprint.pads.some((pad) => pad.nativeCustomPad),
  );
  if (owned) ownedNativeCustomPadBoards.set(board.footprints, hasNative);
  return hasNative;
}

const ownedNativePadPruningBoards = new WeakMap<PCB['footprints'], boolean>();
export function hasNativePCBPadPruning(board: PCB): boolean {
  const owned = isOwnedProjectNode(board.footprints);
  const cached = owned ? ownedNativePadPruningBoards.get(board.footprints) : undefined;
  if (cached !== undefined) return cached;
  const present = board.footprints.some((footprint) =>
    footprint.pads.some((pad) => pad.removeUnusedLayers),
  );
  if (owned) ownedNativePadPruningBoards.set(board.footprints, present);
  return present;
}

function hasNativeCopperText(board: PCB): boolean {
  const matches = (graphic: BoardLine) => {
    const text = graphic.text ?? graphic.dimension?.caption;
    return (
      graphic.layer.endsWith('.Cu') &&
      !text?.hidden &&
      Boolean(graphic.textBox || text?.fontFace || text?.knockout)
    );
  };
  return (
    board.graphics.some(matches) ||
    board.footprints.some((footprint) => footprint.graphics.some(matches))
  );
}

export function hasNativePCBTeardrops(board: PCB): boolean {
  return (
    board.zones.some((zone) => zone.teardrop !== undefined) ||
    board.vias.some((via) => via.teardrops?.enabled === true) ||
    board.footprints.some((footprint) =>
      footprint.pads.some((pad) => pad.teardrops?.enabled === true),
    )
  );
}

/** Native Source owns copper edits that the bounded editor cannot model. */
export function assertImportedPCBCopperUnchanged(previous?: PCB | null, next?: PCB | null): void {
  if (previous === next) return;
  if (previous?.zones !== next?.zones || previous?.footprints !== next?.footprints) {
    const edgeFills = (board?: PCB | null) =>
      (board?.zones ?? [])
        .concat(board?.footprints.flatMap((footprint) => footprint.zones ?? []) ?? [])
        .filter(isNativePCBEdgeCutFill)
        .map(({ locked: _locked, ...zone }) => zone);
    if (JSON.stringify(edgeFills(previous)) !== JSON.stringify(edgeFills(next)))
      throw new Error('Editing native filled Edge.Cuts zones requires Source.');
  }
  const arcs = previous?.arcTracks?.length || next?.arcTracks?.length;
  const unassignedTracks =
    previous?.tracks.some((track) => !track.netId) || next?.tracks.some((track) => !track.netId);
  const tuning = previous?.tuningPatterns?.length || next?.tuningPatterns?.length;
  const teardrops =
    (previous && hasNativePCBTeardrops(previous)) || (next && hasNativePCBTeardrops(next));
  const nativePads =
    (previous && hasNativeCustomPads(previous)) || (next && hasNativeCustomPads(next));
  const prunedPads =
    (previous && hasNativePCBPadPruning(previous)) || (next && hasNativePCBPadPruning(next));
  const machinedPads =
    (previous && hasNativePCBPadMachining(previous)) || (next && hasNativePCBPadMachining(next));
  const padstacks =
    (previous && hasNativePCBPadstacks(previous)) || (next && hasNativePCBPadstacks(next));
  const nativeCopperText =
    (previous && hasNativeCopperText(previous)) || (next && hasNativeCopperText(next));
  const footprintConnections =
    (previous && nativePCBFootprintConnections(previous)) ||
    (next && nativePCBFootprintConnections(next));
  const copperGraphics =
    (previous && hasNativePCBGraphicCopper(previous)) || (next && hasNativePCBGraphicCopper(next));
  const trackMasks = (previous && hasPCBTrackMask(previous)) || (next && hasPCBTrackMask(next));
  const unassignedZones =
    (previous && hasUnassignedSavedCopperZones(previous)) ||
    (next && hasUnassignedSavedCopperZones(next));
  const curvedCopper =
    (previous && hasNativePCBCurvedCopper(previous)) || (next && hasNativePCBCurvedCopper(next));
  const curvedRuleAreas =
    (previous && hasNativePCBCurvedRuleAreas(previous)) ||
    (next && hasNativePCBCurvedRuleAreas(next));
  const nativeTables =
    (previous && hasNativePCBTableOutput(previous)) || (next && hasNativePCBTableOutput(next));
  const physicalBarcodes =
    hasPCBPhysicalBarcode(previous?.barcodes) || hasPCBPhysicalBarcode(next?.barcodes);
  const nativeVias =
    (previous && hasNativePCBViaAuthority(previous)) || (next && hasNativePCBViaAuthority(next));
  if (
    !arcs &&
    !unassignedTracks &&
    !teardrops &&
    !tuning &&
    !nativePads &&
    !prunedPads &&
    !machinedPads &&
    !padstacks &&
    !nativeCopperText &&
    !footprintConnections &&
    !copperGraphics &&
    !trackMasks &&
    !unassignedZones &&
    !curvedCopper &&
    !curvedRuleAreas &&
    !nativeVias &&
    !nativeTables &&
    !physicalBarcodes
  )
    return;
  const fills = (board: PCB) =>
    JSON.stringify(
      board.zones
        .concat(board.footprints.flatMap((footprint) => footprint.zones ?? []))
        .filter((zone) => zone.filledPolygons !== undefined)
        .map((zone) => [zone.id, zone.filledPolygons]),
    );
  if (
    !previous ||
    !next ||
    pcbFillInputsChanged(previous, next) ||
    ((teardrops ||
      tuning ||
      footprintConnections ||
      copperGraphics ||
      trackMasks ||
      unassignedZones ||
      nativeVias ||
      prunedPads ||
      padstacks) &&
      previous.nets !== next.nets &&
      JSON.stringify(previous.nets) !== JSON.stringify(next.nets)) ||
    ((previous.zones !== next.zones || previous.footprints !== next.footprints) &&
      fills(previous) !== fills(next))
  ) {
    if (unassignedZones)
      throw new Error(
        'Copper edits on boards with unassigned native copper fills require native Source.',
      );
    if (nativeTables)
      throw new Error(
        'Copper edits on boards with native tables on fabrication layers require native Source.',
      );
    if (physicalBarcodes)
      throw new Error(
        'Copper edits on boards with native barcodes on copper or Edge.Cuts require native Source.',
      );
    if (trackMasks)
      throw new Error(
        'Copper edits on boards with native solder-mask track openings require native Source.',
      );
    if (arcs)
      throw new Error('Copper edits on boards with imported arc tracks require native Source.');
    if (unassignedTracks)
      throw new Error(
        'Copper edits on boards with unassigned native tracks require native Source.',
      );
    if (tuning)
      throw new Error('Copper edits on boards with native tuning patterns require native Source.');
    if (nativePads)
      throw new Error(
        'Copper edits on boards with native custom pad primitives require native Source.',
      );
    if (padstacks)
      throw new Error(
        'Copper edits on boards with native layer-specific padstacks require native Source.',
      );
    if (prunedPads)
      throw new Error(
        'Copper edits on boards with connection-dependent pad copper layers require native Source.',
      );
    if (machinedPads)
      throw new Error(
        'Copper edits on boards with native pad machining or press-fit settings require native Source.',
      );
    if (nativeCopperText)
      throw new Error(
        'Copper edits on boards with native copper text boxes, named fonts, or knockout text require native Source.',
      );
    if (footprintConnections)
      throw new Error(
        `Copper edits on boards with native footprint ${footprintConnections} require native Source.`,
      );
    if (copperGraphics)
      throw new Error(
        'Copper edits on boards with native net or mask copper graphics require native Source.',
      );
    if (curvedCopper)
      throw new Error(
        'Copper edits on boards with native curved polygons or Bézier graphics on copper or Edge.Cuts require native Source.',
      );
    if (curvedRuleAreas)
      throw new Error(
        'Copper edits on boards with native curved rule areas require native Source.',
      );
    if (
      previous?.vias.some((via) => via.removeUnusedLayers) ||
      next?.vias.some((via) => via.removeUnusedLayers)
    )
      throw new Error(
        'Copper edits on boards with connection-dependent via copper layers require native Source.',
      );
    if (nativeVias)
      throw new Error(
        'Copper edits on boards with native non-through, treated, or unassigned vias require native Source.',
      );
    throw new Error('Copper edits on boards with native teardrops require native Source.');
  }
}

/** Remove stale saved contours from an uncommitted geometry candidate.
 * Accepted edits refresh active saved pours in the same project transaction. */
export function invalidatePCBFill(previous: PCB, next: PCB): PCB {
  // Nothing can be cleared when the candidate already contains no saved fills.
  // Retain its exact identity, including owned renderer proposals/Core adoption.
  if (
    previous === next ||
    (!next.zones.some((zone) => zone.filledPolygons !== undefined) &&
      !next.footprints.some((footprint) =>
        footprint.zones?.some((zone) => zone.filledPolygons !== undefined),
      )) ||
    !pcbFillInputsChanged(previous, next)
  )
    return next;
  const clear = (z: BoardZone): BoardZone => {
    if (
      z.teardrop ||
      z.filledPolygons === undefined ||
      isUnassignedSavedCopperZone(z) ||
      isNativePCBEdgeCutFill(z)
    )
      return z;
    const { filledPolygons: _filled, ...rest } = z;
    return rest;
  };
  return {
    ...next,
    zones: next.zones.map(clear),
    footprints: next.footprints.map((f) =>
      f.zones?.some((z) => z.filledPolygons !== undefined)
        ? { ...f, zones: f.zones.map(clear) }
        : f,
    ),
  };
}
export type PCB = {
  id: string;
  thickness: number;
  layers: CopperLayer[];
  nets: { id: string; name: string }[];
  footprints: Footprint[];
  tracks: {
    id: string;
    start: Point;
    end: Point;
    width: number;
    layer: CopperLayer;
    netId: string;
    maskLayer?: 'F.Mask' | 'B.Mask';
    solderMaskMargin?: number;
    /** Native editing lock; omitted for unlocked segments. */
    locked?: true;
  }[];
  /** Exact imported copper arcs. The canvas retains these records as fixed copper. */
  arcTracks?: (PCB['tracks'][number] & { mid: Point })[];
  /** Validated KiCad route-generator records with their original member UUIDs. */
  tuningPatterns?: SExpr[];
  /** Imported board-level PNG references retain their native records. */
  referenceImages?: SExpr[];
  /** Native silkscreen QR code records. */
  barcodes?: SExpr[];
  /** Validated board-level native tables displayed as read-only artwork. */
  nativeTables?: SExpr[];
  /** Effective locks inherited from native PCB or footprint groups. */
  groupLocks?: string[];
  vias: (Point &
    PCBViaPruning & {
      id: string;
      diameter: number;
      drill: number;
      /** Empty for native vias with no electrical net assignment. */
      netId: string;
      locked?: true;
      teardrops?: PCBTeardropSettings;
      tenting?: { front?: boolean; back?: boolean };
      span?: PCBViaSpan;
      backdrills?: PCBViaBackdrills;
      treatment?: PCBViaTreatment;
      padstack?: PCBViaPadstack;
      free?: boolean;
    })[];
  graphics: BoardLine[];
  zones: BoardZone[];
};

/** Reference/value captions retain geometry while their content follows the device. */
export function resolvePCBGraphic(g: BoardLine, reference: string, value: string): BoardLine {
  if (!g.text) return g;
  const text =
    g.text.property === 'Reference'
      ? reference
      : g.text.property === 'Value'
        ? value
        : g.text.value.replaceAll('${REFERENCE}', reference).replaceAll('${VALUE}', value);
  return text === g.text.value ? g : { ...g, text: { ...g.text, value: text } };
}

// Call through exportKiCad in project.ts, which validates all identifiers and links first.
type PCBSourceChunk = { source: string; tree?: SExpr };
type PCBSource = { symbols: string; source: string; chunks: PCBSourceChunk[]; tree?: SExpr };
const ownedBoardSources = new WeakMap<PCB, PCBSource>();
const ownedBoardChunks = new WeakMap<object, { context: string; chunk: PCBSourceChunk }>();
function boardSource(board: PCB, schematic: Circuit): PCBSource {
  // PCB export observes only these schematic fields. A schematic pose or wire
  // edit keeps the owned board and its complete native copper bytes reusable.
  const owned = isOwnedPCB(board);
  const parts = new Map(schematic.parts.map((part) => [part.id, part]));
  const symbols = owned
    ? JSON.stringify([
        schematic.id,
        schematic.title,
        board.footprints.map((footprint) => {
          const part = footprint.symbolId ? parts.get(footprint.symbolId) : undefined;
          return part ? [part.id, part.ref, part.value] : null;
        }),
      ])
    : '';
  const cached = owned ? ownedBoardSources.get(board) : undefined;
  if (cached?.symbols === symbols) return cached;
  const chunks = serializePCBContent(board, schematic, parts);
  const result = {
    symbols,
    source: chunks.map((chunk) => chunk.source).join('\n') + '\n)\n',
    chunks,
  };
  if (owned) ownedBoardSources.set(board, result);
  return result;
}

export function serializePCB(board: PCB, schematic: Circuit): string {
  return boardSource(board, schematic).source;
}

/** Private native assembly shares exact immutable record trees. Mutable callers
 * receive a fresh tree; public export continues to return the same text bytes. */
export function materializedPCBTree(board: PCB, schematic: Circuit): SExpr {
  const snapshot = boardSource(board, schematic);
  if (snapshot.tree) return snapshot.tree;
  const owned = isOwnedPCB(board);
  const tree: SExpr = [];
  for (const [index, chunk] of snapshot.chunks.entries()) {
    let node = chunk.tree;
    if (!node) {
      const source = chunk.source + (index ? '' : ')');
      const parse = owned ? parseOwnedSExpr : parseSExpr;
      node = parse(source, MAX_NATIVE_PCB_BYTES, MAX_NATIVE_PCB_NODES);
      if (owned) chunk.tree = node;
    }
    if (index) tree.push(node);
    else tree.push(...node);
  }
  if (owned) snapshot.tree = ownProjectData(tree, undefined, MAX_NATIVE_PCB_NODES);
  return snapshot.tree ?? tree;
}

function serializePCBContent(
  board: PCB,
  schematic: Circuit,
  parts: Map<string, Circuit['parts'][number]>,
): PCBSourceChunk[] {
  const reusable = isOwnedPCB(board);
  const retain = (record: object, context: string, create: () => string): PCBSourceChunk => {
    const owned = reusable && isOwnedProjectNode(record);
    const cached = owned ? ownedBoardChunks.get(record) : undefined;
    if (cached?.context === context) return cached.chunk;
    const chunk = { source: create() };
    if (owned) ownedBoardChunks.set(record, { context, chunk });
    return chunk;
  };
  const xy = (p: Point) => `${fmt(p.x)} ${fmt(p.y)}`;
  const nativePolygonPoints = (
    vertices: Point[],
    arcEdges?: BoardLine['polygonArcs'],
    transform = (p: Point) => p,
  ) => {
    const arcs = new Map(arcEdges?.map(({ vertex, mid }) => [vertex, mid]));
    const points: string[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const mid = arcs.get(i);
      const start = xy(transform(vertices[i]));
      points.push(
        mid
          ? `(arc (start ${start}) (mid ${xy(transform(mid))}) (end ${xy(transform(vertices[++i]))}))`
          : `(xy ${start})`,
      );
    }
    return points.join(' ');
  };
  const trackLayers = (track: PCB['tracks'][number]) =>
    track.maskLayer
      ? `(layers ${q(track.layer)} ${q(track.maskLayer)})${track.solderMaskMargin === undefined ? '' : ` (solder_mask_margin ${fmt(track.solderMaskMargin)})`}`
      : `(layer ${q(track.layer)})`;
  const netName = new Map(board.nets.map((n) => [n.id, n.name]));
  const effects = (t: BoardText) =>
    `(effects (font${t.fontFace ? ` (face ${q(t.fontFace)})` : ''} (size ${xy(t.size)}) (thickness ${fmt(t.thickness)})${t.lineSpacing === undefined ? '' : ` (line_spacing ${t.lineSpacing})`}${t.italic ? ' (italic yes)' : ''}${t.bold ? ' (bold yes)' : ''})${t.justify?.length ? ` (justify ${t.justify.join(' ')})` : ''})`;
  const graphic = (g: BoardLine, prefix: 'fp' | 'gr', footprintRotation = 0): string => {
    const nativeLayers = g.maskLayer
      ? `(layers ${q(g.layer)} ${q(g.maskLayer)})`
      : `(layer ${q(g.layer)}${g.text?.knockout ? ' knockout' : ''})`;
    const tail = `${nativeLayers}${g.netId ? ` (net ${q(netName.get(g.netId)!)})` : ''}${g.solderMaskMargin === undefined ? '' : ` (solder_mask_margin ${fmt(g.solderMaskMargin)})`} (uuid ${q(g.id)})${g.locked ? ' (locked yes)' : ''})`;
    if (g.kind === 'point') return `(point (at ${xy(g.start)}) (size ${fmt(g.width)}) ${tail}`;
    const stroke = `(stroke (width ${g.nativeNoStroke ? '-0.000001' : fmt(g.width)}) (type ${g.stroke ?? 'default'}))`;
    if (g.textBox) {
      const box = g.textBox;
      const t = g.text!;
      const boundary = box.outline
        ? `(pts ${box.outline.map((point) => `(xy ${xy(point)})`).join(' ')})`
        : `(start ${xy(g.start)}) (end ${xy(g.end)})`;
      const angle = t.rotation ? ` (angle ${fmt(t.rotation)})` : '';
      return `(${prefix}_text_box ${q(t.value)}${g.locked ? ' (locked yes)' : ''} ${boundary} (margins ${box.margins.map(fmt).join(' ')})${angle} (layer ${q(g.layer)}) (uuid ${q(g.id)}) ${effects(t)} (border ${box.border ? 'yes' : 'no'}) (stroke (width ${fmt(box.strokeWidth)}) (type ${g.stroke ?? 'default'})) (knockout ${t.knockout ? 'yes' : 'no'})${writePCBTextRenderCache(t.renderCache)})`;
    }
    if (g.kind === 'text') {
      const t = g.text!;
      const unlocked = prefix === 'fp' && g.keepUpright === false ? '(unlocked yes) ' : '';
      return `(${prefix === 'fp' && t.property ? `property ${q(t.property)}` : `${prefix}_text${prefix === 'fp' ? ' user' : ''}`} ${q(t.value)} (at ${xy(g.start)} ${fmt(t.rotation + footprintRotation)}) ${unlocked}${t.hidden ? '(hide yes) ' : ''}${effects(t)}${writePCBTextRenderCache(t.renderCache)} ${tail}`;
    }
    if (g.kind === 'dimension') {
      const d = g.dimension!,
        f = d.format,
        s = d.style,
        t = d.caption;
      const orientation = d.orientation === undefined ? '' : ` (orientation ${d.orientation})`;
      const suppressZeroes =
        f?.suppressZeroes === undefined
          ? ''
          : ` (suppress_zeroes ${f.suppressZeroes ? 'yes' : 'no'})`;
      const format = f
        ? ` (format (prefix ${q(f.prefix)}) (suffix ${q(f.suffix)}) (units ${f.units}) (units_format ${f.unitsFormat}) (precision ${f.precision})${suppressZeroes}${f.overrideValue === undefined ? '' : ` (override_value ${q(f.overrideValue)})`})`
        : '';
      const caption = t
        ? ` (gr_text ${q(t.value)} (at ${xy(t)} ${fmt(t.rotation)}) (layer ${q(g.layer)}${t.knockout ? ' knockout' : ''}) ${effects(t)}${writePCBTextRenderCache(t.renderCache)})`
        : '';
      return `(dimension (type ${d.type}) (layer ${q(g.layer)}) (uuid ${q(g.id)})${g.locked ? ' (locked yes)' : ''} (pts (xy ${xy(g.start)}) (xy ${xy(g.end)}))${d.height === undefined ? '' : ` (height ${fmt(d.height)})`}${d.leaderLength === undefined ? '' : ` (leader_length ${fmt(d.leaderLength)})`}${orientation}${format} (style (thickness ${fmt(g.width)}) (arrow_length ${fmt(s.arrowLength)}) (text_position_mode ${s.textPositionMode})${s.arrowDirection ? ` (arrow_direction ${s.arrowDirection})` : ''}${s.extensionHeight === undefined ? '' : ` (extension_height ${fmt(s.extensionHeight)})`} (extension_offset ${fmt(s.extensionOffset)})${s.keepTextAligned === undefined ? '' : ` (keep_text_aligned ${s.keepTextAligned ? 'yes' : 'no'})`}${s.textFrame === undefined ? '' : ` (text_frame ${s.textFrame})`})${caption})`;
    }
    if (g.kind === 'arc')
      return `(${prefix}_arc (start ${xy(g.start)}) (mid ${xy(g.mid!)}) (end ${xy(g.end)}) ${stroke} ${tail}`;
    if (g.kind === 'curve')
      return `(${prefix}_curve (pts ${[g.start, ...g.points!, g.end].map((p) => `(xy ${xy(p)})`).join(' ')}) ${stroke} ${tail}`;
    if (g.kind === 'circle')
      return `(${prefix}_circle (center ${xy(g.start)}) (end ${xy(g.end)}) ${stroke} (fill ${g.fill ? 'yes' : 'no'}) ${tail}`;
    if (g.roundedRectRadius !== undefined)
      return `(${prefix}_rect (start ${xy(g.start)}) (end ${xy(g.points![1])}) (radius ${fmt(g.roundedRectRadius)}) ${stroke} (fill ${g.fill ? 'yes' : 'no'}) ${tail}`;
    if (g.kind === 'polygon') {
      const vertices = [g.start, ...(g.points ?? []), g.end];
      return `(${prefix}_poly (pts ${nativePolygonPoints(vertices, g.polygonArcs)}) ${stroke} (fill ${g.fill ? 'yes' : 'no'}) ${tail}`;
    }
    return `(${prefix}_line (start ${xy(g.start)}) (end ${xy(g.end)}) ${stroke} ${tail}`;
  };
  const zone = (z: BoardZone, transform = (p: Point) => p) => {
    const attribute = z.teardrop
      ? ` (attr (teardrop (type ${z.teardrop})))`
      : z.keepout
        ? ` (keepout ${Object.entries(z.keepout)
            .map(([key, disabled]) => `(${key} ${disabled ? 'not_allowed' : 'allowed'})`)
            .join(' ')})${
            z.nativePlacement
              ? ` (placement (enabled yes) (${z.nativePlacement.sourceKind} ${q(z.nativePlacement.sourceName)}))`
              : ' (placement (enabled no) (sheetname ""))'
          }`
        : '';
    const thermalGap =
      !z.teardrop || z.thermalGap !== defaultPCBTeardropThermal
        ? ` (thermal_gap ${fmt(z.thermalGap)})`
        : '';
    const thermalBridge =
      !z.teardrop || z.thermalBridge !== defaultPCBTeardropThermal
        ? ` (thermal_bridge_width ${fmt(z.thermalBridge)})`
        : '';
    const smoothing = z.cornerSmoothing
      ? ` (smoothing ${z.cornerSmoothing.style})${z.cornerSmoothing.radius === undefined ? '' : ` (radius ${fmt(z.cornerSmoothing.radius)})`}`
      : '';
    const hatch =
      z.hatchFill &&
      ` (mode hatch) (hatch_border_algorithm ${z.hatchFill.borderAlgorithm})${pcbZoneHatchNumericFields.flatMap(([field, key]) => (z.hatchFill?.[key] === undefined ? [] : [` (${field} ${fmt(z.hatchFill[key])})`])).join('')}`;
    const fill = `(fill${z.fillEnabled === false ? '' : ' yes'}${thermalGap}${thermalBridge}${smoothing}${hatch ?? ''}${z.islandRemovalMode === undefined ? '' : ` (island_removal_mode ${z.islandRemovalMode})`}${z.islandAreaMin === undefined ? '' : ` (island_area_min ${fmt(z.islandAreaMin)})`})`;
    const points = (list: Point[]) => list.map((p) => `(xy ${xy(transform(p))})`).join(' ');
    const outlines = z.nativeCircularOutline
      ? `(polygon (pts (arc (start ${xy(transform(z.outline[0]))}) (mid ${xy(transform(z.outline[1]))}) (end ${xy(transform(z.outline[0]))}))))`
      : z.outline.length
        ? [z.outline, ...(z.holes ?? [])]
            .map(
              (outline, index) =>
                `(polygon (pts ${nativePolygonPoints(outline, index === 0 ? z.nativeOutlineArcs : undefined, transform)}))`,
            )
            .join(' ')
        : '';
    const contours = (z.filledPolygons ?? [])
      .map(
        (polygon) =>
          ` (filled_polygon (layer ${q(z.layer)})${polygon.island ? ' (island yes)' : ''} (pts ${points(polygon.points)}))`,
      )
      .join('');
    const property = z.hatchPosition
      ? ` (property (layer ${q(z.layer)}) (hatch_position (xy ${xy(z.hatchPosition)})))`
      : '';
    return `(zone ${z.netId ? `(net ${q(netName.get(z.netId)!)}) ` : ''}(layer ${q(z.layer)}) (uuid ${q(z.id)})${z.locked ? ' (locked yes)' : ''} (hatch edge 0.5)${z.priority === undefined ? '' : ` (priority ${z.priority})`} (connect_pads${z.padConnection ? ` ${z.padConnection}` : ''} (clearance ${fmt(z.clearance)})) (min_thickness ${fmt(z.minThickness)})${attribute} ${fill}${property} ${outlines}${contours})`;
  };
  const usedUserLayers = new Set<string>([
    ...pcbUserLayers.slice(0, 4),
    ...board.graphics.map(({ layer }) => layer),
    ...board.zones.map(({ layer }) => layer),
    ...board.footprints.flatMap((footprint) => [
      ...footprint.graphics.map(({ layer }) => layer),
      ...(footprint.zones ?? []).map(({ layer }) => layer),
    ]),
  ]);
  const technicalLayers: [number, string][] = [
    [1, 'F.Mask'],
    [3, 'B.Mask'],
    [5, 'F.SilkS'],
    [7, 'B.SilkS'],
    [9, 'F.Adhes'],
    [11, 'B.Adhes'],
    [13, 'F.Paste'],
    [15, 'B.Paste'],
    [17, 'Dwgs.User'],
    [19, 'Cmts.User'],
    [21, 'Eco1.User'],
    [23, 'Eco2.User'],
    [25, 'Edge.Cuts'],
    [27, 'Margin'],
    [29, 'B.CrtYd'],
    [31, 'F.CrtYd'],
    [33, 'B.Fab'],
    [35, 'F.Fab'],
    ...pcbUserLayers.flatMap((layer, index): [number, string][] =>
      usedUserLayers.has(layer) ? [[39 + 2 * index, layer]] : [],
    ),
  ];
  const lines = [
    `(kicad_pcb (version ${KICAD_PCB_VERSION}) (generator "openpe") (generator_version "0.1")`,
    `  (general (thickness ${fmt(board.thickness)})) (paper "A4")`,
    `  (title_block (title ${q(schematic.title)}))`,
    `  (layers ${board.layers.map((layer) => `(${pcbNativeCopperLayerId(layer)} ${q(layer)} signal)`).join(' ')} ${technicalLayers.map(([id, name]) => `(${id} ${q(name)} user)`).join(' ')})`,
    '  (setup (pad_to_mask_clearance 0))',
    // The 10.0 reader still accepts declarations; retain unused named nets as well.
    ...board.nets.map((n, i) => `  (net ${i + 1} ${q(n.name)})`),
  ];
  const chunks: PCBSourceChunk[] = [{ source: lines.join('\n') }];
  const netContext = JSON.stringify(board.nets);
  for (const f of board.footprints) {
    const p = f.symbolId ? parts.get(f.symbolId) : undefined;
    const context = JSON.stringify([schematic.id, p?.id, p?.ref, p?.value, netContext]);
    chunks.push(
      retain(f, context, () => {
        const lines: string[] = [];
        const side = f.side === 'front' ? 'F' : 'B';
        const effects = `(effects (font (size 1 1) (thickness 0.15))${f.side === 'back' ? ' (justify mirror)' : ''})`;
        lines.push(
          `  (footprint ${q(f.libraryId)} (layer "${side}.Cu") (uuid ${q(f.id)}) (at ${xy(f)} ${fmt(f.rotation)})${f.locked ? ' (locked yes)' : ''}`,
          ...(
            [
              ['solderMaskMargin', 'solder_mask_margin'],
              ['solderPasteMargin', 'solder_paste_margin'],
              ['solderPasteMarginRatio', 'solder_paste_margin_ratio'],
              ...pcbFootprintZoneOverrideFields.map(([native, key]) => [key, native] as const),
            ] as const
          ).flatMap(([key, native]) =>
            f[key] === undefined ? [] : [`    (${native} ${fmt(f[key]!)})`],
          ),
          ...(p ? [`    (path ${q('/' + schematic.id + '/' + p.id)})`] : []),
          `    (attr ${f.pads.some((pad) => pad.type === 'thru_hole') ? 'through_hole' : 'smd'})`,
          ...(f.netTiePadGroups
            ? [`    (net_tie_pad_groups ${f.netTiePadGroups.map(q).join(' ')})`]
            : []),
          ...(f.jumperPadGroups
            ? [
                `    (jumper_pad_groups ${f.jumperPadGroups.map((group) => `(${group.map(q).join(' ')})`).join(' ')})`,
              ]
            : []),
          ...(!f.graphics.some((g) => g.text?.property === 'Reference')
            ? [
                ...(f.nativeMissingReference
                  ? []
                  : [
                      `    (property "Reference" ${q(p?.ref ?? f.reference ?? '')} (at 0 -3 ${fmt(f.rotation)}) (layer "${side}.SilkS") ${effects})`,
                    ]),
                ...(f.nativeMissingValue
                  ? []
                  : [
                      `    (property "Value" ${q(p?.value ?? f.value ?? '')} (at 0 3 ${fmt(f.rotation)}) (layer "${side}.Fab") ${effects})`,
                    ]),
              ]
            : []),
          ...f.graphics.map(
            (g) =>
              '    ' +
              graphic(
                g.text?.property === 'Reference' || g.text?.property === 'Value'
                  ? resolvePCBGraphic(g, p?.ref ?? f.reference ?? '', p?.value ?? f.value ?? '')
                  : g,
                'fp',
                f.rotation,
              ),
          ),
          ...(f.models ?? []).map((m) => {
            const xyz = (v: Point & { z: number }) => `${v.x} ${v.y} ${v.z}`;
            return `    (model ${q(m.path)}${m.hidden ? ' (hide yes)' : ''}${m.opacity !== undefined ? ` (opacity ${fmt(m.opacity)})` : ''} (offset (xyz ${xyz(m.offset)})) (scale (xyz ${xyz(m.scale)})) (rotate (xyz ${xyz(m.rotation)})))`;
          }),
        );
        for (const pad of f.pads) {
          const layers = pad.layers
            ? pad.layers.map(q).join(' ')
            : pad.type !== 'smd'
              ? '"*.Cu" "*.Mask"'
              : `"${side}.Cu" "${side}.Paste" "${side}.Mask"`;
          const extras: string[] = pad.locked ? ['(locked yes)'] : [];
          if (pad.heatsink) extras.push('(property pad_prop_heatsink)');
          if (pad.fabricationProperty) extras.push(`(property ${pad.fabricationProperty})`);
          if (pad.postMachining) extras.push(...writePCBPadPostMachining(pad.postMachining));
          if (pad.dieLength !== undefined) extras.push(`(die_length ${fmt(pad.dieLength)})`);
          if (pad.dieDelay !== undefined) extras.push(`(die_delay ${fmt(pad.dieDelay)})`);
          if (pad.roundrectRatio !== undefined)
            extras.push(`(roundrect_rratio ${pad.roundrectRatio})`);
          if (pad.trapezoidDelta)
            extras.push(`(rect_delta ${fmt(pad.trapezoidDelta.x)} ${fmt(pad.trapezoidDelta.y)})`);
          if (pad.chamferRatio !== undefined) extras.push(`(chamfer_ratio ${pad.chamferRatio})`);
          if (pad.solderPasteMarginRatio !== undefined)
            extras.push(`(solder_paste_margin_ratio ${pad.solderPasteMarginRatio})`);
          for (const [key, native] of [
            ['solderMaskMargin', 'solder_mask_margin'],
            ['solderPasteMargin', 'solder_paste_margin'],
            ['thermalBridgeAngle', 'thermal_bridge_angle'],
            ...pcbPadZoneOverrideFields.map(([native, key]) => [key, native] as const),
          ] as const)
            if (pad[key] !== undefined) extras.push(`(${native} ${fmt(pad[key]!)})`);
          if (pad.chamfer) extras.push(`(chamfer ${pad.chamfer.join(' ')})`);
          if (pad.nativeCustomPad)
            extras.push(
              `(options (clearance ${pad.nativeCustomPad.clearance}) (anchor ${pad.customAnchor ?? 'rect'}))`,
              writeSExpr(['primitives', ...pad.nativeCustomPad.primitives]),
            );
          else if (pad.outline)
            extras.push(
              `(options (clearance outline) (anchor ${pad.customAnchor ?? 'rect'}))`,
              `(primitives (gr_poly (pts ${pad.outline.map((p) => `(xy ${fmt(p.x)} ${fmt(p.y)})`).join(' ')}) (width 0) (fill yes)))`,
            );
          if (pad.removeUnusedLayers !== undefined)
            extras.push(`(remove_unused_layers ${pad.removeUnusedLayers ? 'yes' : 'no'})`);
          if (pad.keepEndLayers !== undefined)
            extras.push(`(keep_end_layers ${pad.keepEndLayers ? 'yes' : 'no'})`);
          if (pad.zoneLayerConnections)
            extras.push(
              `(zone_layer_connections${pad.zoneLayerConnections.map((layer) => ` ${q(layer)}`).join('')})`,
            );
          if (pad.teardrops) extras.push(writePCBTeardropSettings(pad.teardrops));
          if (pad.padstack) extras.push(writePCBPadstack(pad.padstack));
          const offset = pad.drillOffset;
          const anchor = offset ? footprintPoint(pad, offset) : pad;
          const dimensions =
            pad.drill === undefined
              ? []
              : pad.drillSlot
                ? [`oval ${xy(padDrillSize(pad))}`]
                : [
                    fmt(pad.drill),
                    ...(pad.nativeRoundDrillY === undefined ? [] : [fmt(pad.nativeRoundDrillY)]),
                  ];
          const drillFields = offset
            ? [...dimensions, `(offset ${fmt(-offset.x)} ${fmt(-offset.y)})`]
            : dimensions;
          const drill = drillFields.length ? ` (drill ${drillFields.join(' ')})` : '';
          lines.push(
            `    (pad ${q(pad.number)} ${pad.nativeConnect ? 'connect' : pad.type} ${pad.shape} (at ${xy(anchor)} ${fmt(pad.rotation + f.rotation)}) (size ${xy(pad.size)})${drill} (layers ${layers})${pad.netId ? ` (net ${q(netName.get(pad.netId)!)})` : ''} ${extras.join(' ')} (uuid ${q(pad.id)}))`,
          );
        }
        const radians = (-f.rotation * Math.PI) / 180;
        const absolute = (p: Point) => ({
          x: f.x + p.x * Math.cos(radians) - p.y * Math.sin(radians),
          y: f.y + p.x * Math.sin(radians) + p.y * Math.cos(radians),
        });
        lines.push(
          ...(f.referencePoints ?? []).map(
            (p) =>
              `    (point (at ${xy(footprintPoint(f, p))}) (size ${fmt(p.size)}) (layer ${q(p.layer)}) (uuid ${q(p.id)}))`,
          ),
          ...(f.zones ?? []).map((z) => '    ' + zone(z, absolute)),
          '  )',
        );
        return lines.join('\n');
      }),
    );
  }
  chunks.push(
    ...board.graphics.map((g) =>
      retain(g, netName.get(g.netId ?? '') ?? '', () => '  ' + graphic(g, 'gr')),
    ),
  );
  for (const t of board.tracks)
    chunks.push(
      retain(
        t,
        netName.get(t.netId) ?? '',
        () =>
          `  (segment (start ${xy(t.start)}) (end ${xy(t.end)}) (width ${fmt(t.width)}) ${trackLayers(t)} (net ${t.netId ? q(netName.get(t.netId)!) : '0'}) (uuid ${q(t.id)})${t.locked ? ' (locked yes)' : ''})`,
      ),
    );
  for (const t of board.arcTracks ?? [])
    chunks.push(
      retain(
        t,
        netName.get(t.netId) ?? '',
        () =>
          `  (arc (start ${xy(t.start)}) (mid ${xy(t.mid)}) (end ${xy(t.end)}) (width ${fmt(t.width)}) ${trackLayers(t)} (net ${t.netId ? q(netName.get(t.netId)!) : '0'}) (uuid ${q(t.id)})${t.locked ? ' (locked yes)' : ''})`,
      ),
    );
  for (const pattern of board.tuningPatterns ?? [])
    chunks.push(retain(pattern, '', () => '  ' + writeSExpr(pattern, 1)));
  for (const image of board.referenceImages ?? [])
    chunks.push(retain(image, '', () => '  ' + writeSExpr(image, 1)));
  for (const barcode of board.barcodes ?? [])
    chunks.push(retain(barcode, '', () => '  ' + writeSExpr(barcode, 1)));
  for (const table of board.nativeTables ?? [])
    chunks.push(retain(table, '', () => '  ' + writeSExpr(table, 1)));
  for (const v of board.vias) {
    const netKey = netName.get(v.netId);
    chunks.push(
      retain(
        v,
        netKey ?? '',
        () =>
          `  (via${v.span ? ` ${v.span.kind}` : ''} (at ${xy(v)}) (size ${fmt(v.diameter)}) (drill ${fmt(v.drill)})${writePCBViaBackdrills(v.backdrills)} (layers ${q(v.span?.start ?? 'F.Cu')} ${q(v.span?.end ?? 'B.Cu')}) (net ${netKey === undefined ? '0' : q(netKey)}) (uuid ${q(v.id)})${v.locked ? ' (locked yes)' : ''}${v.free === undefined ? '' : ` (free ${v.free ? 'yes' : 'no'})`}${writePCBViaPruning(v)}${v.teardrops ? ` ${writePCBTeardropSettings(v.teardrops)}` : ''}${v.tenting ? ` ${writePCBViaTenting(v.tenting)}` : ''}${v.treatment ? ` ${writePCBViaTreatment(v.treatment)}` : ''}${v.padstack ? ` ${writePCBViaPadstack(v.padstack)}` : ''})`,
      ),
    );
  }
  chunks.push(
    ...board.zones.map((z) => retain(z, netName.get(z.netId ?? '') ?? '', () => '  ' + zone(z))),
  );
  return chunks;
}
