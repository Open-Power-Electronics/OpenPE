/** Bounded, browser-safe KiCad 10 PCB reader for native project files. */
import { nativeIdentity } from './kicad-project-identity';
import type { Circuit, Point } from './circuit';
import type { PCB, BoardLine, BoardText, BoardZone, Footprint, Pad, BoardLayer } from './pcb';
import { parseSExpr, child, children, val, quote, type SExpr } from './sexpr';
import { footprintModels } from './pcb-models';

const round = (n: number) => Number(n.toFixed(6));
const angle = (n: number) => round(((n % 360) + 360) % 360);
const fail = (message: string): never => {
  throw new Error(`KiCad PCB: ${message}`);
};
function allow(node: SExpr, names: string[], context: string) {
  for (const n of node.filter(Array.isArray))
    if (!names.includes(String(n[0]))) fail(`${context} contains unsupported ${n[0]}.`);
}
function number(n: SExpr | undefined, index = 1, fallback?: number): number {
  if (!n || !val(n, index)) {
    if (fallback !== undefined) return fallback;
    return fail('Missing numeric field.');
  }
  const v = Number(val(n, index));
  if (!Number.isFinite(v) || Math.abs(v) > 100000)
    fail(`Invalid precision or number ${val(n, index)}.`);
  return v;
}
const point = (n: SExpr | undefined): Point => ({ x: number(n), y: number(n, 2) });
const points = (n: SExpr | undefined): Point[] =>
  n ? children(n, 'xy').map(point) : fail('Missing polygon points.');
function nativeLocked(n: SExpr): boolean {
  const flags = children(n, 'locked');
  if (
    flags.length > 1 ||
    flags.some((flag) => flag.length !== 2 || !['yes', 'no'].includes(val(flag))) ||
    (flags.length && n.includes('locked')) ||
    n.filter((item) => item === 'locked').length > 1
  )
    fail('Invalid native editing lock.');
  return n.includes('locked') || val(flags[0]) === 'yes';
}

/** Keep the original zone UUID on its first layer; other layer instances have
 * deterministic identities. Clean native files retain their original bytes. */
export function expandNativeBoardZones(root: SExpr): SExpr {
  const copper = (child(root, 'layers') ?? [])
    .filter(Array.isArray)
    .map((layer) => val(layer))
    .filter((layer) => layer.endsWith('.Cu'));
  const expand = (container: SExpr): SExpr =>
    container.flatMap((node): SExpr => {
      if (!Array.isArray(node)) return [node];
      if (node[0] === 'footprint') return [expand(node)];
      const layers = node[0] === 'zone' ? child(node, 'layers') : undefined;
      if (!layers) return [node];
      if (child(node, 'layer')) fail('Zone cannot specify both layer and layers.');
      const names = layers.slice(1).flatMap((_, index) => {
        const name = val(layers, index + 1);
        return name === '*.Cu' ? copper : [name];
      });
      const uuid = val(child(node, 'uuid'));
      if (!uuid || !names.length || names.length > 4 || new Set(names).size !== names.length)
        fail('Invalid multi-layer zone identity or layers.');
      if (
        children(node, 'filled_polygon').some((fill) => !names.includes(val(child(fill, 'layer'))))
      )
        fail('Filled polygon layer disagrees with its multi-layer zone.');
      return names.map((name, index) =>
        node.flatMap((item): SExpr => {
          if (!Array.isArray(item)) return [item];
          if (item[0] === 'layers') return [['layer', quote(name)]];
          if (item[0] === 'uuid' && index)
            return [['uuid', quote(nativeIdentity(`${uuid}:layer:${name}`))]];
          if (item[0] === 'filled_polygon' && val(child(item, 'layer')) !== name) return [];
          return [item];
        }),
      );
    });
  return expand(root);
}
function textData(n: SExpr, value: string): BoardText {
  const e = child(n, 'effects'),
    f = e && child(e, 'font');
  if (!f) fail('Text has no font geometry.');
  allow(e!, ['font', 'justify', 'hide'], 'text effects');
  allow(f!, ['size', 'thickness', 'bold', 'italic'], 'font');
  return {
    value,
    rotation: number(child(n, 'at'), 3, 0),
    size: point(child(f!, 'size')),
    thickness: number(child(f!, 'thickness'), 1, 0),
    ...(child(e!, 'justify')
      ? {
          justify: child(e!, 'justify')!
            .slice(1)
            .map((_, i) => val(child(e!, 'justify'), i + 1)) as BoardText['justify'],
        }
      : {}),
    ...(val(child(n, 'hide')) === 'yes' || n.includes('hide') ? { hidden: true } : {}),
    ...(val(child(f!, 'bold')) === 'yes' ? { bold: true } : {}),
    ...(val(child(f!, 'italic')) === 'yes' ? { italic: true } : {}),
  };
}

export function parseKiCadPCB(
  source: string,
  schematic: Circuit,
  stableIdSeed: string,
  referenceMapping?: Record<string, string>,
) {
  return parseKiCadPCBTree(parseSExpr(source), schematic, stableIdSeed, referenceMapping);
}

/** Project a parsed board without changing its native records. */
export function parseKiCadPCBTree(
  tree: SExpr,
  schematic: Circuit,
  stableIdSeed: string,
  referenceMapping: Record<string, string> = {},
): {
  board: PCB;
  audit: {
    footprints: number;
    pads: number;
    tracks: number;
    vias: number;
    zones: number;
    graphics: number;
    unlinkedReferences: string[];
  };
} {
  const root = expandNativeBoardZones(tree);
  if (root[0] !== 'kicad_pcb' || val(child(root, 'version')) !== '20260206')
    fail('Expected the pinned KiCad 10 board format.');
  allow(
    root,
    [
      'version',
      'generator',
      'generator_version',
      'general',
      'paper',
      'layers',
      'setup',
      'title_block',
      'net',
      'footprint',
      'gr_line',
      'gr_rect',
      'gr_arc',
      'gr_circle',
      'gr_poly',
      'gr_text',
      'dimension',
      'segment',
      'via',
      'zone',
      'embedded_fonts',
    ],
    'board',
  );
  const stable = (key: string) => nativeIdentity(stableIdSeed + ': ' + key);
  const id = (n: SExpr, key: string) => val(child(n, 'uuid')) || stable(key);
  const nets = new Map<string, string>();
  const nativeNets = new Map<string, string>();
  for (const declaration of children(root, 'net')) {
    const name = val(declaration, 2);
    if (!name) continue;
    nativeNets.set(val(declaration), name);
    if (!nets.has(name)) nets.set(name, stable('net:' + name));
  }
  const net = (n: SExpr): string | null => {
    const node = child(n, 'net');
    if (!node) return null;
    const name = node.length > 2 ? val(node, 2) : (nativeNets.get(val(node)) ?? val(node));
    if (!name || name === '0') return null;
    if (!nets.has(name)) nets.set(name, stable('net:' + name));
    return nets.get(name)!;
  };
  const graph = (n: SExpr, key: string, footprintRotation = 0): BoardLine => {
    const kind = String(n[0]).replace(/^(fp|gr)_/, '');
    const layer = val(child(n, 'layer')) as BoardLayer;
    const common = {
      id: id(n, key),
      layer,
      width: number(child(child(n, 'stroke') ?? [], 'width'), 1, 0),
      ...(nativeLocked(n) ? { locked: true as const } : {}),
    };
    if (kind === 'text' || kind === 'property') {
      allow(n, ['at', 'layer', 'uuid', 'effects', 'hide', 'unlocked', 'locked'], 'text');
      const at = point(child(n, 'at'));
      const t = textData(n, val(n, kind === 'property' || n[0] === 'fp_text' ? 2 : 1));
      t.rotation = angle(t.rotation - footprintRotation);
      if (kind === 'property') t.property = val(n);
      return { ...common, kind: 'text', start: at, end: { ...at }, text: t };
    }
    if (kind === 'dimension') {
      allow(
        n,
        [
          'type',
          'layer',
          'uuid',
          'pts',
          'height',
          'leader_length',
          'format',
          'style',
          'gr_text',
          'locked',
        ],
        'dimension',
      );
      const pts = points(child(n, 'pts'));
      if (pts.length !== 2) fail('Only two-anchor dimensions are supported.');
      const f = child(n, 'format')!,
        s = child(n, 'style')!,
        t = child(n, 'gr_text')!;
      allow(
        f,
        ['prefix', 'suffix', 'units', 'units_format', 'precision', 'override_value'],
        'dimension format',
      );
      allow(
        s,
        [
          'thickness',
          'arrow_length',
          'text_position_mode',
          'arrow_direction',
          'extension_height',
          'extension_offset',
          'keep_text_aligned',
          'text_frame',
        ],
        'dimension style',
      );
      return {
        ...common,
        width: number(child(s, 'thickness')),
        kind: 'dimension',
        start: pts[0],
        end: pts[1],
        dimension: {
          type: val(child(n, 'type')) as 'aligned' | 'radial' | 'leader',
          ...(child(n, 'height') ? { height: number(child(n, 'height')) } : {}),
          ...(child(n, 'leader_length') ? { leaderLength: number(child(n, 'leader_length')) } : {}),
          format: {
            prefix: val(child(f, 'prefix')),
            suffix: val(child(f, 'suffix')),
            units: number(child(f, 'units')),
            unitsFormat: number(child(f, 'units_format')),
            precision: number(child(f, 'precision')),
            ...(child(f, 'override_value')
              ? { overrideValue: val(child(f, 'override_value')) }
              : {}),
          },
          style: {
            arrowLength: number(child(s, 'arrow_length')),
            textPositionMode: number(child(s, 'text_position_mode')),
            extensionOffset: number(child(s, 'extension_offset')),
            ...(child(s, 'arrow_direction')
              ? { arrowDirection: val(child(s, 'arrow_direction')) as 'outward' | 'inward' }
              : {}),
            ...(child(s, 'extension_height')
              ? { extensionHeight: number(child(s, 'extension_height')) }
              : {}),
            ...(child(s, 'keep_text_aligned')
              ? { keepTextAligned: val(child(s, 'keep_text_aligned')) === 'yes' }
              : {}),
            ...(child(s, 'text_frame') ? { textFrame: number(child(s, 'text_frame')) } : {}),
          },
          caption: { ...point(child(t, 'at')), ...textData(t, val(t)) },
        },
      };
    }
    allow(
      n,
      ['start', 'mid', 'end', 'center', 'pts', 'stroke', 'fill', 'layer', 'uuid', 'locked'],
      'graphic',
    );
    const stroke = val(child(child(n, 'stroke') ?? [], 'type')) as BoardLine['stroke'];
    const extra = {
      ...(stroke ? { stroke } : {}),
      ...(child(n, 'fill') ? { fill: ['yes', 'solid'].includes(val(child(n, 'fill'))) } : {}),
    };
    if (kind === 'rect') {
      const a = point(child(n, 'start')),
        b = point(child(n, 'end'));
      return {
        ...common,
        ...extra,
        kind: 'polygon',
        start: a,
        end: { x: a.x, y: b.y },
        points: [{ x: b.x, y: a.y }, b],
      };
    }
    if (kind === 'poly') {
      const p = points(child(n, 'pts'));
      if (p.length < 3) fail('Degenerate polygon.');
      return {
        ...common,
        ...extra,
        kind: 'polygon',
        start: p[0],
        end: p[p.length - 1],
        points: p.slice(1, -1),
      };
    }
    if (kind === 'circle')
      return {
        ...common,
        ...extra,
        kind: 'circle',
        start: point(child(n, 'center')),
        end: point(child(n, 'end')),
      };
    if (kind === 'arc')
      return {
        ...common,
        ...extra,
        kind: 'arc',
        start: point(child(n, 'start')),
        mid: point(child(n, 'mid')),
        end: point(child(n, 'end')),
      };
    if (kind !== 'line') fail(`Unsupported graphic ${kind}.`);
    return { ...common, ...extra, start: point(child(n, 'start')), end: point(child(n, 'end')) };
  };
  const zone = (n: SExpr, key: string, local = (p: Point) => p): BoardZone => {
    allow(
      n,
      [
        'net',
        'layer',
        'uuid',
        'name',
        'hatch',
        'priority',
        'connect_pads',
        'min_thickness',
        'fill',
        'polygon',
        'filled_polygon',
        'keepout',
        'placement',
        'locked',
      ],
      'zone',
    );
    const fill = child(n, 'fill')!,
      connection = child(n, 'connect_pads')!,
      keep = child(n, 'keepout');
    allow(fill, ['thermal_gap', 'thermal_bridge_width', 'island_removal_mode'], 'zone fill');
    const polygons = children(n, 'polygon').map((p) => points(child(p, 'pts')).map(local));
    const filled = children(n, 'filled_polygon').map((p) => {
      allow(p, ['layer', 'island', 'pts'], 'filled polygon');
      if (val(child(p, 'layer')) !== val(child(n, 'layer')))
        fail('Filled polygon layer disagrees with its zone.');
      const pts = child(p, 'pts');
      if (pts) allow(pts, ['xy'], 'filled polygon points');
      return {
        points: points(pts).map(local),
        ...(child(p, 'island') ? { island: true as const } : {}),
      };
    });
    if (!polygons.length) fail('Zone without outline.');
    const placement = child(n, 'placement');
    if (placement && val(child(placement, 'enabled')) !== 'no')
      fail('Enabled placement rule is unsupported.');
    return {
      id: id(n, key),
      ...(nativeLocked(n) ? { locked: true as const } : {}),
      netId: net(n),
      layer: val(child(n, 'layer')) as BoardLayer,
      outline: polygons[0],
      ...(polygons.length > 1 ? { holes: polygons.slice(1) } : {}),
      ...(filled.length ? { filledPolygons: filled } : {}),
      clearance: number(child(connection, 'clearance')),
      minThickness: number(child(n, 'min_thickness')),
      thermalGap: number(child(fill, 'thermal_gap')),
      thermalBridge: number(child(fill, 'thermal_bridge_width')),
      fillEnabled: fill.includes('yes'),
      ...(child(n, 'priority') ? { priority: number(child(n, 'priority')) } : {}),
      ...(typeof connection[1] === 'string'
        ? { padConnection: val(connection) as BoardZone['padConnection'] }
        : {}),
      ...(child(fill, 'island_removal_mode')
        ? { islandRemovalMode: number(child(fill, 'island_removal_mode')) }
        : {}),
      ...(keep
        ? {
            keepout: Object.fromEntries(
              ['tracks', 'vias', 'pads', 'copperpour', 'footprints'].map((k) => [
                k,
                val(child(keep, k)) === 'not_allowed',
              ]),
            ) as NonNullable<BoardZone['keepout']>,
          }
        : {}),
    };
  };
  const reverseReferences = new Map(
    Object.entries(referenceMapping).map(([original, converted]) => [converted, original]),
  );
  const footprints = children(root, 'footprint').map((n, fi): Footprint => {
    allow(
      n,
      [
        'layer',
        'uuid',
        'at',
        'locked',
        'units',
        'solder_mask_margin',
        'solder_paste_margin',
        'solder_paste_margin_ratio',
        'path',
        'attr',
        'sheetname',
        'sheetfile',
        'tags',
        'property',
        'duplicate_pad_numbers_are_jumpers',
        'descr',
        'fp_line',
        'fp_rect',
        'fp_arc',
        'fp_circle',
        'fp_poly',
        'fp_text',
        'pad',
        'zone',
        'embedded_fonts',
        'model',
      ],
      'footprint',
    );
    const locked = nativeLocked(n);
    const units = child(n, 'units');
    if (units) {
      allow(units, ['unit'], 'footprint units');
      for (const unit of children(units, 'unit')) {
        allow(unit, ['name', 'pins'], 'footprint unit');
        if (!child(unit, 'name') || !child(unit, 'pins'))
          fail('Incomplete footprint unit metadata.');
      }
    }
    const reference = val(
        children(n, 'property').find((p) => val(p) === 'Reference'),
        2,
      ),
      value = val(
        children(n, 'property').find((p) => val(p) === 'Value'),
        2,
      );
    const originalReference = reverseReferences.get(reference) ?? reference;
    const nativeSymbol = val(child(n, 'path')).split('/').filter(Boolean).at(-1);
    const part =
      schematic.parts.find((p) => p.id === nativeSymbol) ??
      schematic.parts.find((p) => p.ref === originalReference);
    const symbolPins = new Set(
      part
        ? children(schematic.libraries[part.libId], 'symbol')
            .flatMap((s) => children(s, 'pin'))
            .map((p) => val(child(p, 'number')))
        : [],
    );
    const at = point(child(n, 'at')),
      rotation = number(child(n, 'at'), 3, 0);
    const local = (p: Point): Point => {
      const r = (rotation * Math.PI) / 180,
        x = p.x - at.x,
        y = p.y - at.y;
      return {
        x: round(x * Math.cos(r) - y * Math.sin(r)),
        y: round(x * Math.sin(r) + y * Math.cos(r)),
      };
    };
    const pads = children(n, 'pad').map((p, pi): Pad => {
      allow(
        p,
        [
          'at',
          'size',
          'drill',
          'layers',
          'net',
          'uuid',
          'remove_unused_layers',
          'solder_mask_margin',
          'solder_paste_margin',
          'solder_paste_margin_ratio',
          'thermal_bridge_angle',
          'roundrect_rratio',
          'chamfer_ratio',
          'chamfer',
          'zone_connect',
          'pinfunction',
          'pintype',
          'locked',
        ],
        'pad',
      );
      for (const key of ['pinfunction', 'pintype']) {
        const fields = children(p, key);
        if (
          fields.length > 1 ||
          fields.some((field) => field.length !== 2 || typeof field[1] !== 'string')
        )
          fail(`Pad has invalid ${key} metadata.`);
      }
      const drill = child(p, 'drill');
      if (drill) allow(drill, ['offset'], 'drill');
      if (drill && val(drill) === 'oval')
        fail('Slotted drills are not supported by the editor. The original file was not modified.');
      const result: Pad = {
        id: id(p, `fp:${fi}:pad:${pi}`),
        ...(nativeLocked(p) ? { locked: true as const } : {}),
        number: val(p),
        type: val(p, 2) as Pad['type'],
        shape: val(p, 3) as Pad['shape'],
        ...point(child(p, 'at')),
        rotation: angle(number(child(p, 'at'), 3, 0) - rotation),
        size: point(child(p, 'size')),
        netId: net(p),
        layers: child(p, 'layers')!
          .slice(1)
          .map((_, i) => val(child(p, 'layers'), i + 1)) as Pad['layers'],
      };
      if (drill) {
        result.drill = number(drill);
        if (child(drill, 'offset')) result.drillOffset = point(child(drill, 'offset'));
      }
      for (const [key, native] of [
        ['roundrectRatio', 'roundrect_rratio'],
        ['chamferRatio', 'chamfer_ratio'],
        ['solderMaskMargin', 'solder_mask_margin'],
        ['solderPasteMargin', 'solder_paste_margin'],
        ['solderPasteMarginRatio', 'solder_paste_margin_ratio'],
        ['thermalBridgeAngle', 'thermal_bridge_angle'],
        ['zoneConnect', 'zone_connect'],
      ] as const)
        if (child(p, native)) result[key] = number(child(p, native));
      if (child(p, 'chamfer'))
        result.chamfer = child(p, 'chamfer')!
          .slice(1)
          .map((_, i) => val(child(p, 'chamfer'), i + 1)) as Pad['chamfer'];
      if (child(p, 'remove_unused_layers'))
        result.removeUnusedLayers = val(child(p, 'remove_unused_layers')) === 'yes';
      if (
        part &&
        symbolPins.size &&
        !symbolPins.has(result.number) &&
        result.type !== 'np_thru_hole'
      ) {
        if (result.netId)
          fail(`${originalReference} package pad ${result.number} has a net but no source pin.`);
        result.unconnected = true;
      }
      return result;
    });
    const graphics = n
      .filter(
        (c): c is SExpr =>
          Array.isArray(c) &&
          !(c[0] === 'property' && !child(c, 'at') && !child(c, 'effects')) &&
          ['fp_line', 'fp_rect', 'fp_arc', 'fp_circle', 'fp_poly', 'fp_text', 'property'].includes(
            String(c[0]),
          ),
      )
      .map((g, gi) => graph(g, `fp:${fi}:graphic:${gi}`, rotation));
    for (const g of graphics) {
      if (g.text?.property === 'Reference') g.text.value = '${REFERENCE}';
      if (g.text?.property === 'Value') g.text.value = '${VALUE}';
    }
    const hasPins =
      part &&
      children(schematic.libraries[part.libId], 'symbol').some((s) => children(s, 'pin').length);
    return {
      id: id(n, `footprint:${fi}`),
      symbolId: hasPins ? part!.id : null,
      libraryId: val(n),
      ...at,
      rotation,
      ...(locked ? { locked: true as const } : {}),
      ...(child(n, 'solder_mask_margin')
        ? { solderMaskMargin: number(child(n, 'solder_mask_margin')) }
        : {}),
      ...(child(n, 'solder_paste_margin')
        ? { solderPasteMargin: number(child(n, 'solder_paste_margin')) }
        : {}),
      ...(child(n, 'solder_paste_margin_ratio')
        ? { solderPasteMarginRatio: number(child(n, 'solder_paste_margin_ratio')) }
        : {}),
      side: val(child(n, 'layer')) === 'B.Cu' ? 'back' : 'front',
      ...(!hasPins ? { reference: originalReference, value } : {}),
      pads,
      graphics,
      ...(children(n, 'model').length ? { models: footprintModels(n) } : {}),
      ...(child(n, 'zone')
        ? { zones: children(n, 'zone').map((z, i) => zone(z, `fp:${fi}:zone:${i}`, local)) }
        : {}),
    };
  });
  const tracks = children(root, 'segment').map((n, i) => {
    allow(n, ['start', 'end', 'width', 'layer', 'net', 'uuid', 'locked'], 'track');
    const lock = children(n, 'locked');
    if (
      n.filter((entry) => entry === 'locked').length > 1 ||
      lock.length > 1 ||
      (lock.length && n.includes('locked')) ||
      (lock.length && (lock[0].length !== 2 || !['yes', 'no'].includes(val(lock[0]))))
    )
      fail('Track has an invalid locked setting.');
    const netId = net(n);
    if (!netId) fail('Track lacks a net.');
    return {
      id: id(n, `track:${i}`),
      start: point(child(n, 'start')),
      end: point(child(n, 'end')),
      width: number(child(n, 'width')),
      layer: val(child(n, 'layer')) as PCB['tracks'][number]['layer'],
      netId: netId!,
      ...(n.includes('locked') || val(lock[0]) === 'yes' ? { locked: true as const } : {}),
    };
  });
  const vias = children(root, 'via').map((n, i) => {
    allow(
      n,
      ['at', 'size', 'drill', 'layers', 'net', 'uuid', 'free', 'remove_unused_layers', 'locked'],
      'via',
    );
    const netId = net(n);
    if (!netId) fail('Via lacks a net.');
    if (
      JSON.stringify(
        child(n, 'layers')
          ?.slice(1)
          .map((_, i) => val(child(n, 'layers'), i + 1)),
      ) !== JSON.stringify(['F.Cu', 'B.Cu'])
    )
      fail('Only through vias are supported.');
    return {
      id: id(n, `via:${i}`),
      ...(nativeLocked(n) ? { locked: true as const } : {}),
      ...point(child(n, 'at')),
      diameter: number(child(n, 'size')),
      drill: number(child(n, 'drill')),
      netId: netId!,
    };
  });
  const zones = children(root, 'zone').map((n, i) => zone(n, `zone:${i}`));
  const graphics = root
    .filter(
      (n): n is SExpr =>
        Array.isArray(n) && (String(n[0]).startsWith('gr_') || n[0] === 'dimension'),
    )
    .map((n, i) => graph(n, `graphic:${i}`));
  const layers = child(root, 'layers')!
    .filter((l): l is SExpr => Array.isArray(l) && val(l, 1).endsWith('.Cu'))
    .map((l) => val(l, 1)) as PCB['layers'];
  const board: PCB = {
    id: stable('board'),
    thickness: number(child(child(root, 'general')!, 'thickness')),
    layers,
    nets: [...nets].map(([name, id]) => ({ id, name })),
    footprints,
    tracks,
    vias,
    graphics,
    zones,
  };
  return {
    board,
    audit: {
      footprints: footprints.length,
      pads: footprints.reduce((n, f) => n + f.pads.length, 0),
      tracks: tracks.length,
      vias: vias.length,
      zones: zones.length + footprints.reduce((n, f) => n + (f.zones?.length ?? 0), 0),
      graphics: graphics.length + footprints.reduce((n, f) => n + f.graphics.length, 0),
      unlinkedReferences: footprints.filter((f) => !f.symbolId).map((f) => f.reference!),
    },
  };
}
