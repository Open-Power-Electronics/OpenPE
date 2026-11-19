import { type Circuit, type Point } from './circuit';
import { parseOwnedSExpr, parseSExpr, quote as q, type SExpr } from './sexpr';
import { KICAD_PCB_VERSION } from './kicad-version';
import { isOwnedPCB, isOwnedProjectNode, ownProjectData } from './immutable-project';
import { padDrillSize } from './pcb-drill';
import { footprintPoint } from './pcb-layout';

const fmt = (n: number) => String(Number(n.toFixed(12)));
export type CopperLayer = 'F.Cu' | 'In1.Cu' | 'In2.Cu' | 'B.Cu';
export type BoardLayer =
  | CopperLayer
  | 'F.SilkS'
  | 'B.SilkS'
  | 'F.Fab'
  | 'B.Fab'
  | 'F.CrtYd'
  | 'B.CrtYd'
  | 'Edge.Cuts'
  | 'F.Mask'
  | 'B.Mask'
  | 'F.Paste'
  | 'B.Paste'
  | 'F.Adhes'
  | 'B.Adhes'
  | 'Dwgs.User'
  | 'Cmts.User'
  | 'Eco1.User'
  | 'Eco2.User'
  | 'Margin'
  | 'User.1'
  | 'User.2'
  | 'User.3'
  | 'User.4';
export type BoardText = {
  value: string;
  rotation: number;
  size: Point;
  thickness: number;
  justify?: ('left' | 'right' | 'top' | 'bottom' | 'mirror')[];
  hidden?: boolean;
  italic?: boolean;
  bold?: boolean;
  property?: string;
};
export type BoardLine = {
  locked?: true;
  id: string;
  start: Point;
  end: Point;
  width: number;
  layer: BoardLayer;
  kind?: 'arc' | 'circle' | 'polygon' | 'text' | 'dimension';
  mid?: Point;
  /** Polygon intermediate vertices; start/end retain the first/last vertex. */
  points?: Point[];
  fill?: boolean;
  stroke?: 'default' | 'solid' | 'dash' | 'dot' | 'dash_dot' | 'dash_dot_dot';
  text?: BoardText;
  /** Footprint text with native free rotation. Omitted for upright text. */
  keepUpright?: false;
  dimension?: {
    type: 'aligned' | 'radial' | 'leader';
    height?: number;
    leaderLength?: number;
    format: {
      prefix: string;
      suffix: string;
      units: number;
      unitsFormat: number;
      precision: number;
      overrideValue?: string;
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
    caption: Point & BoardText;
  };
};
export type Pad = Point & {
  locked?: true;
  id: string;
  number: string;
  rotation: number;
  type: 'smd' | 'thru_hole' | 'np_thru_hole';
  shape: 'rect' | 'circle' | 'oval' | 'roundrect' | 'custom';
  /** Size of the native anchor for a custom pad. */
  size: Point;
  /** Native custom pad anchor shape. Omitted for the rectangular anchor. */
  customAnchor?: 'circle';
  /** Filled polygon in the pad-local frame, including its anchor. */
  outline?: Point[];
  drill?: number;
  netId: string | null;
  layers?: (BoardLayer | '*.Cu' | 'F&B.Cu' | '*.Mask')[];
  drillOffset?: Point;
  /** Overall slot length and long axis in pad-local coordinates. Drill is the tool diameter. */
  drillSlot?: { length: number; axis: 'x' | 'y' };
  roundrectRatio?: number;
  chamferRatio?: number;
  chamfer?: ('top_left' | 'top_right' | 'bottom_left' | 'bottom_right')[];
  solderMaskMargin?: number;
  solderPasteMargin?: number;
  solderPasteMarginRatio?: number;
  thermalBridgeAngle?: number;
  zoneConnect?: number;
  removeUnusedLayers?: boolean;
  /** KiCad's native pad fabrication property. */
  heatsink?: true;
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
export type Footprint = Point & {
  id: string;
  symbolId: string | null;
  libraryId: string;
  rotation: number;
  side: 'front' | 'back';
  pads: Pad[];
  graphics: BoardLine[];
  referencePoints?: (Point & { id: string; size: number; layer: 'F.Fab' | 'B.Fab' })[];
  reference?: string;
  value?: string;
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
  holes?: Point[][];
  /** Saved native-style contours; doubled bridges represent holes without filling them.
   * Missing means unfilled; an empty array is a completed fill with no copper. */
  filledPolygons?: { points: Point[]; island?: true }[];
  clearance: number;
  minThickness: number;
  thermalGap: number;
  thermalBridge: number;
  priority?: number;
  padConnection?: 'yes' | 'no' | 'thru_hole_only';
  islandRemovalMode?: number;
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
  const zoneInput = ({ filledPolygons: _filled, ...zone }: BoardZone) => zone;
  // Disabled zones are only editable outlines: adding, assigning or reshaping
  // one cannot change existing copper. Rule areas remain obstacles regardless
  // of their fill flag; enabling a zone brings it back into this comparison.
  const zoneInputs = (zones: BoardZone[]) =>
    zones.filter((zone) => zone.keepout || zone.fillEnabled !== false).map(zoneInput);
  const copperGraphics = (graphics: BoardLine[]) =>
    graphics.filter((g) => g.layer === 'Edge.Cuts' || g.layer.endsWith('.Cu'));
  const inputs = (board: PCB) =>
    JSON.stringify(
      [
        board.layers,
        board.vias,
        copperGraphics(board.graphics),
        zoneInputs(board.zones),
        board.footprints.map((f) => [
          f.x,
          f.y,
          f.rotation,
          f.side,
          f.pads,
          copperGraphics(f.graphics),
          zoneInputs(f.zones ?? []),
        ]),
      ],
      (key, value) => (key === 'locked' ? undefined : value),
    );
  return inputs(previous) !== inputs(next);
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
    if (z.filledPolygons === undefined) return z;
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
  layers: ['F.Cu', 'B.Cu'] | ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  nets: { id: string; name: string }[];
  footprints: Footprint[];
  tracks: {
    id: string;
    start: Point;
    end: Point;
    width: number;
    layer: CopperLayer;
    netId: string;
    /** Native editing lock; omitted for unlocked segments. */
    locked?: true;
  }[];
  vias: (Point & { id: string; diameter: number; drill: number; netId: string; locked?: true })[];
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
      node = owned ? parseOwnedSExpr(source) : parseSExpr(source);
      if (owned) chunk.tree = node;
    }
    if (index) tree.push(node);
    else tree.push(...node);
  }
  if (owned) snapshot.tree = ownProjectData(tree);
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
  const netName = new Map(board.nets.map((n) => [n.id, n.name]));
  const effects = (t: BoardText) =>
    `(effects (font (size ${xy(t.size)}) (thickness ${fmt(t.thickness)})${t.italic ? ' (italic yes)' : ''}${t.bold ? ' (bold yes)' : ''})${t.justify?.length ? ` (justify ${t.justify.join(' ')})` : ''})`;
  const graphic = (g: BoardLine, prefix: 'fp' | 'gr', footprintRotation = 0): string => {
    const tail = `(layer ${q(g.layer)}) (uuid ${q(g.id)})${g.locked ? ' (locked yes)' : ''})`;
    const stroke = `(stroke (width ${fmt(g.width)}) (type ${g.stroke ?? 'default'}))`;
    if (g.kind === 'text') {
      const t = g.text!;
      const unlocked = prefix === 'fp' && g.keepUpright === false ? '(unlocked yes) ' : '';
      return `(${prefix === 'fp' && t.property ? `property ${q(t.property)}` : `${prefix}_text${prefix === 'fp' ? ' user' : ''}`} ${q(t.value)} (at ${xy(g.start)} ${fmt(t.rotation + footprintRotation)}) ${unlocked}${t.hidden ? '(hide yes) ' : ''}${effects(t)} ${tail}`;
    }
    if (g.kind === 'dimension') {
      const d = g.dimension!,
        f = d.format,
        s = d.style;
      return `(dimension (type ${d.type}) (layer ${q(g.layer)}) (uuid ${q(g.id)})${g.locked ? ' (locked yes)' : ''} (pts (xy ${xy(g.start)}) (xy ${xy(g.end)}))${d.height === undefined ? '' : ` (height ${fmt(d.height)})`}${d.leaderLength === undefined ? '' : ` (leader_length ${fmt(d.leaderLength)})`} (format (prefix ${q(f.prefix)}) (suffix ${q(f.suffix)}) (units ${f.units}) (units_format ${f.unitsFormat}) (precision ${f.precision})${f.overrideValue === undefined ? '' : ` (override_value ${q(f.overrideValue)})`}) (style (thickness ${fmt(g.width)}) (arrow_length ${fmt(s.arrowLength)}) (text_position_mode ${s.textPositionMode})${s.arrowDirection ? ` (arrow_direction ${s.arrowDirection})` : ''}${s.extensionHeight === undefined ? '' : ` (extension_height ${fmt(s.extensionHeight)})`} (extension_offset ${fmt(s.extensionOffset)})${s.keepTextAligned === undefined ? '' : ` (keep_text_aligned ${s.keepTextAligned ? 'yes' : 'no'})`}${s.textFrame === undefined ? '' : ` (text_frame ${s.textFrame})`}) (gr_text ${q(d.caption.value)} (at ${xy(d.caption)} ${fmt(d.caption.rotation)}) (layer ${q(g.layer)}) ${effects(d.caption)}))`;
    }
    if (g.kind === 'arc')
      return `(${prefix}_arc (start ${xy(g.start)}) (mid ${xy(g.mid!)}) (end ${xy(g.end)}) ${stroke} ${tail}`;
    if (g.kind === 'circle')
      return `(${prefix}_circle (center ${xy(g.start)}) (end ${xy(g.end)}) ${stroke} (fill ${g.fill ? 'yes' : 'no'}) ${tail}`;
    if (g.kind === 'polygon')
      return `(${prefix}_poly (pts ${[g.start, ...(g.points ?? []), g.end].map((p) => `(xy ${xy(p)})`).join(' ')}) ${stroke} (fill ${g.fill ? 'yes' : 'no'}) ${tail}`;
    return `(${prefix}_line (start ${xy(g.start)}) (end ${xy(g.end)}) ${stroke} ${tail}`;
  };
  const zone = (z: BoardZone, transform = (p: Point) => p) =>
    `(zone ${z.netId ? `(net ${q(netName.get(z.netId)!)}) ` : ''}(layer ${q(z.layer)}) (uuid ${q(z.id)})${z.locked ? ' (locked yes)' : ''} (hatch edge 0.5)${z.priority === undefined ? '' : ` (priority ${z.priority})`} (connect_pads${z.padConnection ? ` ${z.padConnection}` : ''} (clearance ${fmt(z.clearance)})) (min_thickness ${fmt(z.minThickness)})${
      z.keepout
        ? ` (keepout ${Object.entries(z.keepout)
            .map(([key, disabled]) => `(${key} ${disabled ? 'not_allowed' : 'allowed'})`)
            .join(' ')}) (placement (enabled no) (sheetname ""))`
        : ''
    } (fill${z.fillEnabled === false ? '' : ' yes'} (thermal_gap ${fmt(z.thermalGap)}) (thermal_bridge_width ${fmt(z.thermalBridge)})${z.islandRemovalMode === undefined ? '' : ` (island_removal_mode ${z.islandRemovalMode})`}) ${[z.outline, ...(z.holes ?? [])].map((outline) => `(polygon (pts ${outline.map((p) => `(xy ${xy(transform(p))})`).join(' ')}))`).join(' ')}${(z.filledPolygons ?? []).map((polygon) => ` (filled_polygon (layer ${q(z.layer)})${polygon.island ? ' (island)' : ''} (pts ${polygon.points.map((p) => `(xy ${xy(transform(p))})`).join(' ')}))`).join('')})`;
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
    [39, 'User.1'],
    [41, 'User.2'],
    [43, 'User.3'],
    [45, 'User.4'],
  ];
  const lines = [
    `(kicad_pcb (version ${KICAD_PCB_VERSION}) (generator "openpe") (generator_version "0.1")`,
    `  (general (thickness ${fmt(board.thickness)})) (paper "A4")`,
    `  (title_block (title ${q(schematic.title)}))`,
    `  (layers (0 "F.Cu" signal)${board.layers.length === 4 ? ' (4 "In1.Cu" signal) (6 "In2.Cu" signal)' : ''} (2 "B.Cu" signal) ${technicalLayers.map(([id, name]) => `(${id} ${q(name)} user)`).join(' ')})`,
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
            ] as const
          ).flatMap(([key, native]) =>
            f[key] === undefined ? [] : [`    (${native} ${fmt(f[key]!)})`],
          ),
          ...(p ? [`    (path ${q('/' + schematic.id + '/' + p.id)})`] : []),
          `    (attr ${f.pads.some((pad) => pad.type === 'thru_hole') ? 'through_hole' : 'smd'})`,
          ...(!f.graphics.some((g) => g.text?.property === 'Reference')
            ? [
                `    (property "Reference" ${q(p?.ref ?? f.reference ?? '')} (at 0 -3 ${fmt(f.rotation)}) (layer "${side}.SilkS") ${effects})`,
                `    (property "Value" ${q(p?.value ?? f.value ?? '')} (at 0 3 ${fmt(f.rotation)}) (layer "${side}.Fab") ${effects})`,
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
            const xyz = (v: Point & { z: number }) => `${xy(v)} ${fmt(v.z)}`;
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
          if (pad.roundrectRatio !== undefined)
            extras.push(`(roundrect_rratio ${pad.roundrectRatio})`);
          if (pad.chamferRatio !== undefined) extras.push(`(chamfer_ratio ${pad.chamferRatio})`);
          if (pad.solderPasteMarginRatio !== undefined)
            extras.push(`(solder_paste_margin_ratio ${pad.solderPasteMarginRatio})`);
          for (const [key, native] of [
            ['solderMaskMargin', 'solder_mask_margin'],
            ['solderPasteMargin', 'solder_paste_margin'],
            ['thermalBridgeAngle', 'thermal_bridge_angle'],
            ['zoneConnect', 'zone_connect'],
          ] as const)
            if (pad[key] !== undefined) extras.push(`(${native} ${fmt(pad[key]!)})`);
          if (pad.chamfer) extras.push(`(chamfer ${pad.chamfer.join(' ')})`);
          if (pad.outline)
            extras.push(
              `(options (clearance outline) (anchor ${pad.customAnchor ?? 'rect'}))`,
              `(primitives (gr_poly (pts ${pad.outline.map((p) => `(xy ${fmt(p.x)} ${fmt(p.y)})`).join(' ')}) (width 0) (fill yes)))`,
            );
          if (pad.removeUnusedLayers !== undefined)
            extras.push(`(remove_unused_layers ${pad.removeUnusedLayers ? 'yes' : 'no'})`);
          const offset = pad.drillOffset;
          const anchor = offset ? footprintPoint(pad, offset) : pad;
          const drill =
            pad.drill === undefined
              ? ''
              : ` (drill ${pad.drillSlot ? `oval ${xy(padDrillSize(pad))}` : fmt(pad.drill)}${offset ? ` (offset ${fmt(-offset.x)} ${fmt(-offset.y)})` : ''})`;
          lines.push(
            `    (pad ${q(pad.number)} ${pad.type} ${pad.shape} (at ${xy(anchor)} ${fmt(pad.rotation + f.rotation)}) (size ${xy(pad.size)})${drill} (layers ${layers})${pad.netId ? ` (net ${q(netName.get(pad.netId)!)})` : ''} ${extras.join(' ')} (uuid ${q(pad.id)}))`,
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
  chunks.push(...board.graphics.map((g) => retain(g, '', () => '  ' + graphic(g, 'gr'))));
  for (const t of board.tracks)
    chunks.push(
      retain(
        t,
        netName.get(t.netId)!,
        () =>
          `  (segment (start ${xy(t.start)}) (end ${xy(t.end)}) (width ${fmt(t.width)}) (layer ${q(t.layer)}) (net ${q(netName.get(t.netId)!)}) (uuid ${q(t.id)})${t.locked ? ' (locked yes)' : ''})`,
      ),
    );
  for (const v of board.vias)
    chunks.push(
      retain(
        v,
        netName.get(v.netId)!,
        () =>
          `  (via (at ${xy(v)}) (size ${fmt(v.diameter)}) (drill ${fmt(v.drill)}) (layers "F.Cu" "B.Cu") (net ${q(netName.get(v.netId)!)}) (uuid ${q(v.id)})${v.locked ? ' (locked yes)' : ''})`,
      ),
    );
  chunks.push(
    ...board.zones.map((z) => retain(z, netName.get(z.netId ?? '') ?? '', () => '  ' + zone(z))),
  );
  return chunks;
}
