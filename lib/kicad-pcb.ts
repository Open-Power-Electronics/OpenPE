/** Bounded, browser-safe PCB reader for native KiCad projects. */
import { nativeIdentity, normalizeNativePCBIdentifiers } from './kicad-project-identity';
import type { Circuit, Point } from './circuit';
import type { PCB, BoardLine, BoardText, BoardZone, Footprint, Pad, BoardLayer } from './pcb';
import {
  maxPCBZonePriority,
  pcbFootprintZoneOverrideFields,
  pcbPadZoneOverrideFields,
  pcbPlacementSourceKinds,
  pcbZoneHatchBorderAlgorithms,
  pcbZoneHatchNumericFields,
  type PCBPlacementArea,
  type PCBZoneOverrides,
} from './pcb-zone-settings';
import { parseOwnedSExpr, parseSExpr, child, children, val, quote, type SExpr } from './sexpr';
import { KICAD_PCB_VERSION } from './kicad-version';
import { MAX_NATIVE_PCB_BYTES, MAX_NATIVE_PCB_NODES } from './project-size-limits';
import { isPCBCopperStack, pcbBoardLayers } from './pcb-layer-stack';
import {
  nativePCBGroupLocks,
  validatePCBAssemblyVariants,
  validateNativeBoardMetadata,
  validateNativePCBEmbeddedFiles,
  validateNativePCBTuningPatterns,
} from './kicad-pcb-metadata';
import { footprintModels } from './pcb-models';
import { readPadDrill, readPCBPadPostMachining } from './pcb-drill';
import {
  readPCBPadRoundRectRatio,
  readPCBPadTrapezoidDelta,
  validatePCBPadTrapezoid,
} from './pcb-geometry';
import { readBoardCustomPad } from './pcb-custom-pad';
import { footprintPoint } from './pcb-layout';
import {
  footprintTextPlacement,
  isExplicitlyHiddenFootprintCaption,
  nativeFootprintCaptionDefaultSize,
  readPCBTextFont,
  readPCBTextLineSpacing,
} from './pcb-text';
import {
  padHasElectricalPin,
  readPCBPadFabricationProperty,
  readPCBNetTiePadGroups,
  readPCBPadPruning,
} from './pcb-pad-role';
import { readPCBTeardropKind, readPCBTeardropSettings } from './pcb-teardrops';
import { defaultPCBTeardropThermal } from './pcb-teardrop-settings';
import { readPCBViaTenting } from './pcb-via-tenting';
import { pcbBarcodes } from './pcb-barcode';
import { pcbReferenceImages } from './pcb-reference-image';
import { readNativePCBTable } from './pcb-native-table';
import { isOwnedProjectNode, ownProjectData } from './immutable-project';
import {
  readPCBViaBackdrills,
  readPCBViaFlag,
  readPCBViaPruning,
  readPCBViaSpan,
  readPCBViaTreatment,
} from './pcb-native-via';
import { readPCBPadstack, readPCBViaPadstack } from './pcb-padstack';

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
const footprintZoneOverrideNames = pcbFootprintZoneOverrideFields.map(([native]) => native);
const padZoneOverrideNames = pcbPadZoneOverrideFields.map(([native]) => native);

function readZoneOverrides(node: SExpr, footprint = false): PCBZoneOverrides {
  const overrides: PCBZoneOverrides = {};
  const fields = footprint ? pcbFootprintZoneOverrideFields : pcbPadZoneOverrideFields;
  for (const [native, key] of fields) {
    const records = children(node, native);
    if (!records.length) continue;
    const [record] = records;
    if (records.length !== 1 || record.length !== 2 || typeof record[1] !== 'string')
      fail(`Invalid ${native} override.`);
    const value = number(record);
    if (key === 'zoneConnect' ? !Number.isInteger(value) || value < -1 || value > 3 : value < 0)
      fail(`Invalid ${native} override.`);
    overrides[key] = value;
  }
  return overrides;
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

function boardVersion(tree: SExpr): string {
  const versions = children(tree, 'version');
  const version = versions[0]?.[1];
  if (
    tree[0] !== 'kicad_pcb' ||
    versions.length !== 1 ||
    versions[0].length !== 2 ||
    typeof version !== 'string' ||
    !/^\d{8}$/.test(version)
  )
    return fail('Expected a native KiCad board with one valid format version.');
  return version;
}

function hasKiCad10Generator(tree: SExpr): boolean {
  const [generator, extraGenerator] = children(tree, 'generator');
  const [release, extraRelease] = children(tree, 'generator_version');
  return (
    !extraGenerator &&
    !extraRelease &&
    generator?.length === 2 &&
    val(generator) === 'pcbnew' &&
    release?.length === 2 &&
    /^10\.(?!99(?:\.|$))\d+(?:\.\d+)?$/.test(val(release))
  );
}

export type NativePCBPlacementLayer = { id: string; layer: string };

/** Keep a native UUID on the first layer when supplied. Clean native files
 * retain their original bytes, including any omitted zone UUIDs. */
export function expandNativeBoardZones(
  root: SExpr,
  stableIdSeed: string,
  placementLayers?: (layers: readonly NativePCBPlacementLayer[]) => void,
): SExpr {
  const copper = (child(root, 'layers') ?? [])
    .filter(Array.isArray)
    .map((layer) => val(layer))
    .filter((layer) => layer.endsWith('.Cu'));
  const expand = (container: SExpr, scope: string): SExpr => {
    const groupedZoneLayers = child(container, 'group') ? new Map<string, string[]>() : undefined;
    let footprintIndex = 0;
    let zoneIndex = 0;
    const expanded = container.flatMap((node): SExpr => {
      if (!Array.isArray(node)) return [node];
      if (node[0] === 'footprint') return [expand(node, `${scope}fp:${footprintIndex++}:`)];
      if (node[0] !== 'zone') return [node];
      const zoneKey = `${scope}zone:${zoneIndex++}`;
      const layers = child(node, 'layers');
      if (!layers) return [node];
      if (child(node, 'layer')) fail('Zone cannot specify both layer and layers.');
      const names = layers.slice(1).flatMap((_, index) => {
        const name = val(layers, index + 1);
        return name === '*.Cu' ? copper : [name];
      });
      const [uuidField, extraUuid] = children(node, 'uuid');
      const nativeUuid = val(uuidField);
      if (
        extraUuid ||
        (uuidField && !nativeUuid) ||
        !names.length ||
        names.length > 64 ||
        new Set(names).size !== names.length
      )
        fail('Invalid multi-layer zone identity or layers.');
      if (
        children(node, 'filled_polygon').some((fill) => !names.includes(val(child(fill, 'layer'))))
      )
        fail('Filled polygon layer disagrees with its multi-layer zone.');
      if (
        children(node, 'property').some(
          (property) => !names.includes(val(child(property, 'layer'))),
        )
      )
        fail('Property layer disagrees with its multi-layer zone.');
      const uuid = nativeUuid || nativeIdentity(`${stableIdSeed}: native multi-layer ${zoneKey}`);
      const layerIds = names.map((name, index) =>
        index === 0 ? uuid : nativeIdentity(`${uuid}:layer:${name}`),
      );
      if (nativeUuid && layerIds.length > 1)
        groupedZoneLayers?.set(nativeUuid.toLowerCase(), layerIds.slice(1).map(quote));
      const placement = child(node, 'placement');
      if (
        placementLayers &&
        names.length > 1 &&
        placement &&
        val(child(placement, 'enabled')) === 'yes'
      )
        placementLayers(names.map((layer, index) => ({ layer, id: layerIds[index] })));
      return names.map((name, index) =>
        node.flatMap((item): SExpr => {
          if (!Array.isArray(item)) return [item];
          if (item[0] === 'layers')
            return [
              ['layer', quote(name)],
              ...(uuidField ? [] : [['uuid', quote(layerIds[index])]]),
            ];
          if (item[0] === 'uuid' && index) return [['uuid', quote(layerIds[index])]];
          if (item[0] === 'filled_polygon' && val(child(item, 'layer')) !== name) return [];
          if (item[0] === 'property' && val(child(item, 'layer')) !== name) return [];
          return [item];
        }),
      );
    });
    if (!groupedZoneLayers?.size) return expanded;
    return expanded.map((node) => {
      if (!Array.isArray(node) || node[0] !== 'group') return node;
      const members = child(node, 'members');
      if (!members) return node;
      const expandedMembers = members.flatMap((member, index): SExpr => [
        member,
        ...(groupedZoneLayers.get(val(members, index).toLowerCase()) ?? []),
      ]);
      return expandedMembers.length === members.length
        ? node
        : node.map((item) => (item === members ? expandedMembers : item));
    });
  };
  return expand(root, '');
}
function textData(n: SExpr, value: string, at = child(n, 'at')): BoardText {
  const e = child(n, 'effects'),
    f = e && child(e, 'font');
  if (!f) {
    if (
      e ||
      !isExplicitlyHiddenFootprintCaption(n) ||
      child(n, 'render_cache') ||
      child(n, 'layer')?.includes('knockout')
    )
      return fail('Text has no font geometry.');
    const size = nativeFootprintCaptionDefaultSize;
    return {
      value,
      rotation: number(at, 3, 0),
      size: { x: size, y: size },
      thickness: 0,
      hidden: true,
    };
  }
  allow(e!, ['font', 'justify', 'hide'], 'text effects');
  allow(f!, ['size', 'thickness', 'line_spacing', 'bold', 'italic', 'face'], 'font');
  return {
    value,
    rotation: number(at, 3, 0),
    size: point(child(f!, 'size')),
    thickness: number(child(f!, 'thickness'), 1, 0),
    ...readPCBTextLineSpacing(f!, fail),
    ...readPCBTextFont(n, f!, fail),
    ...(child(n, 'layer')?.includes('knockout') ? { knockout: true as const } : {}),
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

function readBoardTextBox(
  n: SExpr,
  common: Pick<BoardLine, 'id' | 'layer' | 'width' | 'locked'>,
  readText: (record: SExpr, literal: string) => BoardText = textData,
): BoardLine {
  const fields = [
    'start',
    'end',
    'pts',
    'angle',
    'layer',
    'uuid',
    'effects',
    'locked',
    'render_cache',
    'margins',
    'border',
    'stroke',
    'knockout',
  ];
  allow(n, fields, 'text box');
  if (
    fields.some((key) => children(n, key).length > 1) ||
    typeof n[1] !== 'string' ||
    !n[1].startsWith('"')
  )
    return fail('Invalid PCB text box fields.');
  const boundary = child(n, 'pts');
  const a = child(n, 'start');
  const b = child(n, 'end');
  if (boundary ? a || b : a?.length !== 3 || b?.length !== 3)
    return fail('PCB text box requires one native boundary.');
  if (
    boundary &&
    (boundary.length < 4 ||
      boundary.length > 257 ||
      boundary
        .slice(1)
        .some((item) => !Array.isArray(item) || item[0] !== 'xy' || item.length !== 3))
  )
    return fail('PCB text box polygon has unsupported points.');
  const outline = boundary ? points(boundary) : undefined;
  const margins = child(n, 'margins');
  if (margins?.length !== 5) return fail('PCB text box requires four native margins.');
  const flag = (key: 'border' | 'knockout') => {
    const record = child(n, key);
    if (record?.length !== 2 || (record[1] !== 'yes' && record[1] !== 'no'))
      return fail(`Invalid PCB text box ${key}.`);
    return record[1] === 'yes';
  };
  const stroke = child(n, 'stroke');
  const strokeType = val(child(stroke ?? [], 'type'));
  if (
    stroke?.length !== 3 ||
    child(stroke, 'width')?.length !== 2 ||
    child(stroke, 'type')?.length !== 2 ||
    !['default', 'solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'].includes(strokeType)
  )
    return fail('Unsupported PCB text box stroke.');
  const boxAngle = child(n, 'angle');
  if (boxAngle && boxAngle.length !== 2) return fail('Invalid PCB text box angle.');
  const text = readText(n, val(n));
  text.rotation = number(boxAngle, 1, 0);
  if (flag('knockout')) text.knockout = true;
  const start = outline?.[0] ?? point(a);
  const end = outline?.at(-1) ?? point(b);
  return {
    ...common,
    width: Math.max(0, common.width),
    start,
    end,
    kind: 'text',
    stroke: strokeType as BoardLine['stroke'],
    text,
    textBox: {
      ...(outline ? { outline } : {}),
      margins: [number(margins), number(margins, 2), number(margins, 3), number(margins, 4)],
      border: flag('border'),
      strokeWidth: common.width,
    },
  };
}

function readNativePCBTableDrawing(record: SExpr) {
  const table = readNativePCBTable(record);
  return {
    id: table.id,
    layer: table.layer,
    graphics: [
      ...table.cells.map((cell) =>
        readBoardTextBox(cell, {
          id: val(child(cell, 'uuid')),
          layer: table.layer,
          width: 0,
          ...(nativeLocked(cell) ? { locked: true as const } : {}),
        }),
      ),
      ...table.borders,
    ],
  };
}

const nativePCBTableDrawings = new WeakMap<SExpr, ReturnType<typeof readNativePCBTableDrawing>>();

export function pcbTableDrawings(records?: readonly SExpr[]) {
  if (!records?.length) return [];
  if (records.length > 32) return fail('A board can contain at most 32 native tables.');
  return records.map((record) => {
    const cached = nativePCBTableDrawings.get(record);
    if (cached) return cached;
    const drawing = readNativePCBTableDrawing(record);
    if (!isOwnedProjectNode(record)) return drawing;
    const owned = ownProjectData(drawing);
    nativePCBTableDrawings.set(record, owned);
    return owned;
  });
}

export function parseKiCadPCB(
  source: string,
  schematic: Circuit,
  stableIdSeed: string,
  referenceMapping?: Record<string, string>,
) {
  return parseKiCadPCBTree(parseNativePCBSource(source), schematic, stableIdSeed, referenceMapping);
}

export function parseNativePCBSource(source: string, owned = false): SExpr {
  const parse = owned ? parseOwnedSExpr : parseSExpr;
  return parse(source, MAX_NATIVE_PCB_BYTES, MAX_NATIVE_PCB_NODES);
}

/** Project a parsed board without changing its native records. */
function parseKiCadPCBTree(
  tree: SExpr,
  schematic: Circuit,
  stableIdSeed: string,
  referenceMapping: Record<string, string> = {},
): {
  board: PCB;
  normalized: SExpr;
  nativeRectangleIds: ReadonlySet<string>;
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
  const version = boardVersion(tree);
  if (version !== KICAD_PCB_VERSION && !hasKiCad10Generator(tree))
    fail(`Unsupported board format ${version}. Use KiCad 10.`);
  const normalized = normalizeNativePCBIdentifiers(tree);
  const textVariables = validateNativeBoardMetadata(normalized);
  validatePCBAssemblyVariants(normalized);
  validateNativePCBEmbeddedFiles(normalized);
  const root = expandNativeBoardZones(normalized, stableIdSeed);
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
      'image',
      'table',
      'property',
      'variants',
      'group',
      'net',
      'footprint',
      'gr_line',
      'gr_rect',
      'gr_arc',
      'gr_curve',
      'gr_circle',
      'gr_poly',
      'gr_text',
      'gr_text_box',
      'dimension',
      'segment',
      'arc',
      'generated',
      'via',
      'zone',
      'embedded_fonts',
      'embedded_files',
      'point',
      'barcode',
    ],
    'board',
  );
  const stable = (key: string) => nativeIdentity(stableIdSeed + ': ' + key);
  const id = (n: SExpr, key: string) => val(child(n, 'uuid')) || stable(key);
  const nativeRectangleIds = new Set<string>();
  const groupLocked = nativePCBGroupLocks(root);
  const groupLocks: NonNullable<PCB['groupLocks']> = [];
  const lock = (n: SExpr, id: string, native = nativeLocked(n)) => {
    const inherited = groupLocked.has(id.toLowerCase());
    if (inherited) groupLocks.push(id);
    return native || inherited ? { locked: true as const } : {};
  };
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
    const name =
      node.length > 2
        ? val(node, 2)
        : typeof node[1] === 'string' && node[1].startsWith('"')
          ? val(node)
          : (nativeNets.get(val(node)) ?? val(node));
    if (!name || (node[1] === '0' && name === '0')) return null;
    if (!nets.has(name)) nets.set(name, stable('net:' + name));
    return nets.get(name)!;
  };
  const readText = (record: SExpr, literal: string, at?: SExpr): BoardText => {
    const text = textData(record, literal, at);
    if (!textVariables.size || !literal.includes('${')) return text;
    let length = literal.length;
    const value = literal.replace(/\$\{([^{}]+)\}/g, (token, name: string) => {
      const replacement = textVariables.get(name);
      if (replacement === undefined || name === 'REFERENCE' || name === 'VALUE') return token;
      length += replacement.length - token.length;
      if (length > 4096 || replacement.includes('${'))
        return fail('Unsupported nested or oversized PCB text expansion.');
      return replacement;
    });
    return value === literal ? text : { ...text, nativeExpansion: { source: literal, value } };
  };
  const graph = (n: SExpr, key: string, footprintRotation?: number): BoardLine => {
    const kind = String(n[0]).replace(/^(fp|gr)_/, '');
    const nativeLayer = child(n, 'layer');
    const nativeLayers = child(n, 'layers');
    const layer = val(nativeLayer ?? nativeLayers) as BoardLayer;
    const recordId = id(n, key);
    const common = {
      id: recordId,
      layer,
      width: number(child(child(n, 'stroke') ?? [], 'width'), 1, 0),
      ...lock(n, recordId),
    };
    if (kind === 'point') {
      const fields = ['at', 'size', 'layer', 'uuid', 'locked'];
      allow(n, fields, 'board reference point');
      const anchor = child(n, 'at');
      const size = child(n, 'size');
      if (
        anchor?.length !== 3 ||
        size?.length !== 2 ||
        fields.some((field) => children(n, field).length > 1)
      )
        return fail('Invalid board reference point.');
      const start = point(anchor);
      return { ...common, kind, start, end: start, width: number(size) };
    }
    if (kind === 'text_box') return readBoardTextBox(n, common, readText);
    if (kind === 'text' || kind === 'property') {
      const inFootprint = footprintRotation !== undefined;
      allow(
        n,
        [
          'at',
          'layer',
          'uuid',
          'effects',
          'hide',
          'locked',
          'render_cache',
          ...(inFootprint ? ['unlocked'] : []),
        ],
        'text',
      );
      const placement = inFootprint ? footprintTextPlacement(n, fail) : { at: child(n, 'at') };
      const at = point(placement.at);
      const t = readText(
        n,
        val(n, kind === 'property' || n[0] === 'fp_text' ? 2 : 1),
        placement.at,
      );
      t.rotation = angle(t.rotation - (footprintRotation ?? 0));
      if (kind === 'property') t.property = val(n);
      return {
        ...common,
        kind: 'text',
        start: at,
        end: { ...at },
        text: t,
        ...('unlocked' in placement && placement.unlocked ? { keepUpright: false } : {}),
      };
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
          'orientation',
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
      const f = child(n, 'format'),
        s = child(n, 'style'),
        t = child(n, 'gr_text');
      const dimensionType = val(child(n, 'type')) as NonNullable<BoardLine['dimension']>['type'];
      if (
        !s ||
        (dimensionType === 'center'
          ? f || t || child(n, 'height') || child(n, 'leader_length')
          : !f || !t)
      )
        return fail('Invalid PCB dimension caption, format or style for its native type.');
      if (f)
        allow(
          f,
          [
            'prefix',
            'suffix',
            'units',
            'units_format',
            'precision',
            'override_value',
            'suppress_zeroes',
          ],
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
      const orientation = child(n, 'orientation');
      if (
        (dimensionType === 'orthogonal') !== Boolean(orientation) ||
        (orientation &&
          (orientation.length !== 2 || (orientation[1] !== '0' && orientation[1] !== '1')))
      )
        return fail('Invalid orthogonal PCB dimension orientation.');
      const suppressZeroes = f && child(f, 'suppress_zeroes');
      if (
        suppressZeroes &&
        (suppressZeroes.length !== 2 || !['yes', 'no'].includes(val(suppressZeroes)))
      )
        return fail('Invalid PCB dimension suppress-zeroes flag.');
      return {
        ...common,
        width: number(child(s, 'thickness')),
        kind: 'dimension',
        start: pts[0],
        end: pts[1],
        dimension: {
          type: dimensionType,
          ...(orientation ? { orientation: number(orientation) as 0 | 1 } : {}),
          ...(child(n, 'height') ? { height: number(child(n, 'height')) } : {}),
          ...(child(n, 'leader_length') ? { leaderLength: number(child(n, 'leader_length')) } : {}),
          ...(f && t
            ? {
                format: {
                  prefix: val(child(f, 'prefix')),
                  suffix: val(child(f, 'suffix')),
                  units: number(child(f, 'units')),
                  unitsFormat: number(child(f, 'units_format')),
                  precision: number(child(f, 'precision')),
                  ...(suppressZeroes ? { suppressZeroes: val(suppressZeroes) === 'yes' } : {}),
                  ...(child(f, 'override_value')
                    ? { overrideValue: val(child(f, 'override_value')) }
                    : {}),
                },
                caption: { ...point(child(t, 'at')), ...readText(t, val(t)) },
              }
            : {}),
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
        },
      };
    }
    allow(
      n,
      [
        'start',
        'mid',
        'end',
        'center',
        'pts',
        'stroke',
        'fill',
        'layer',
        'layers',
        'net',
        'solder_mask_margin',
        'uuid',
        'locked',
        ...(kind === 'rect' ? ['radius'] : []),
      ],
      'graphic',
    );
    const mask = val(nativeLayers, 2);
    if (
      children(n, 'layer').length + children(n, 'layers').length !== 1 ||
      (nativeLayers &&
        (nativeLayers.length !== 3 ||
          !((layer === 'F.Cu' && mask === 'F.Mask') || (layer === 'B.Cu' && mask === 'B.Mask'))))
    )
      return fail('Graphic layers require one native layer or a same-side copper and mask pair.');
    const nativeNet = child(n, 'net');
    if (
      nativeNet &&
      (footprintRotation !== undefined ||
        !layer.endsWith('.Cu') ||
        nativeNet.length !== 2 ||
        typeof nativeNet[1] !== 'string' ||
        children(n, 'net').length !== 1 ||
        (typeof nativeNet[1] === 'string' &&
          /^\d+$/.test(nativeNet[1]) &&
          nativeNet[1] !== '0' &&
          !nativeNets.has(nativeNet[1])))
    )
      return fail('Invalid native board graphic net.');
    const margin = child(n, 'solder_mask_margin');
    if (
      margin &&
      (!nativeLayers || margin.length !== 2 || children(n, 'solder_mask_margin').length !== 1)
    )
      return fail('Graphic solder-mask margin requires native paired layers.');
    const graphicNet = net(n);
    const stroke = val(child(child(n, 'stroke') ?? [], 'type')) as BoardLine['stroke'];
    const filled = ['yes', 'solid'].includes(val(child(n, 'fill')));
    const noStroke =
      common.width === -0.000001 && filled && ['rect', 'poly', 'circle'].includes(kind);
    const extra = {
      ...(graphicNet ? { netId: graphicNet } : {}),
      ...(nativeLayers ? { maskLayer: mask as 'F.Mask' | 'B.Mask' } : {}),
      ...(margin ? { solderMaskMargin: number(margin) } : {}),
      ...(stroke ? { stroke } : {}),
      ...(child(n, 'fill') ? { fill: filled } : {}),
      ...(noStroke ? { width: 0, nativeNoStroke: true as const } : {}),
    };
    if (kind === 'rect') {
      nativeRectangleIds.add(common.id);
      const a = point(child(n, 'start')),
        b = point(child(n, 'end'));
      const radii = children(n, 'radius');
      const nativeRadius = radii[0];
      if (radii.length > 1 || (nativeRadius && nativeRadius.length !== 2))
        return fail('Invalid native rounded rectangle radius.');
      const roundedRectRadius = nativeRadius ? number(nativeRadius) : undefined;
      return {
        ...common,
        ...extra,
        kind: 'polygon',
        start: a,
        end: { x: a.x, y: b.y },
        points: [{ x: b.x, y: a.y }, b],
        ...(roundedRectRadius === undefined ? {} : { roundedRectRadius }),
      };
    }
    if (kind === 'poly') {
      const records = children(n, 'pts');
      if (records.length !== 1) fail('A PCB polygon requires one native contour.');
      const p: Point[] = [];
      const polygonArcs: NonNullable<BoardLine['polygonArcs']> = [];
      for (const item of records[0].slice(1)) {
        if (!Array.isArray(item)) return fail('Invalid PCB polygon vertex.');
        if (item[0] === 'xy' && item.length === 3) p.push(point(item));
        else if (
          item[0] === 'arc' &&
          item.length === 4 &&
          ['start', 'mid', 'end'].every(
            (name) => children(item, name).length === 1 && child(item, name)?.length === 3,
          )
        ) {
          polygonArcs.push({ vertex: p.length, mid: point(child(item, 'mid')) });
          p.push(point(child(item, 'start')), point(child(item, 'end')));
        } else fail('Unsupported PCB polygon vertex.');
      }
      if (p.length + polygonArcs.length < 3) fail('Degenerate polygon.');
      return {
        ...common,
        ...extra,
        kind: 'polygon',
        start: p[0],
        end: p[p.length - 1],
        points: p.slice(1, -1),
        ...(polygonArcs.length ? { polygonArcs } : {}),
      };
    }
    if (kind === 'curve') {
      const records = children(n, 'pts');
      const coordinates = records[0]?.slice(1);
      if (
        records.length !== 1 ||
        coordinates?.length !== 4 ||
        ['start', 'mid', 'end', 'center', 'fill'].some((name) => child(n, name))
      )
        return fail('A native PCB Bézier requires four XY points.');
      const [start, firstControl, secondControl, end] = coordinates.map((item) => {
        if (!Array.isArray(item) || item[0] !== 'xy' || item.length !== 3)
          return fail('Invalid native PCB Bézier point.');
        return point(item);
      });
      return { ...common, ...extra, kind, start, end, points: [firstControl, secondControl] };
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
  const zone = (
    n: SExpr,
    key: string,
    local: (p: Point, digits?: number) => Point = (p) => p,
  ): BoardZone => {
    allow(
      n,
      [
        'net',
        'net_name',
        'layer',
        'uuid',
        'name',
        'hatch',
        'property',
        'priority',
        'connect_pads',
        'min_thickness',
        'filled_areas_thickness',
        'fill',
        'polygon',
        'filled_polygon',
        'keepout',
        'placement',
        'attr',
        'locked',
      ],
      'zone',
    );
    const fill = child(n, 'fill')!,
      connection = child(n, 'connect_pads')!,
      keep = child(n, 'keepout');
    const [fillThickness, repeatFillThickness] = children(n, 'filled_areas_thickness');
    if (
      fillThickness &&
      (repeatFillThickness || fillThickness.length !== 2 || fillThickness[1] !== 'no')
    )
      return fail('Only unstroked native zone contours are supported.');
    allow(
      fill,
      [
        'thermal_gap',
        'thermal_bridge_width',
        'island_removal_mode',
        'island_area_min',
        'smoothing',
        'radius',
        'mode',
        'hatch_border_algorithm',
        ...pcbZoneHatchNumericFields.map(([field]) => field),
      ],
      'zone fill',
    );
    const netId = net(n);
    const netName = child(n, 'net_name');
    if (
      netName &&
      (children(n, 'net_name').length !== 1 ||
        netName.length !== 2 ||
        typeof netName[1] !== 'string' ||
        !netName[1].startsWith('"') ||
        val(netName) !== (netId ? [...nets].find(([, id]) => id === netId)?.[0] : ''))
    )
      fail('Zone net name disagrees with its electrical net.');
    const smoothing = child(fill, 'smoothing');
    const [fillMode, extraMode] = children(fill, 'mode');
    const [hatchBorder, extraBorder] = children(fill, 'hatch_border_algorithm');
    const hatchBorderAlgorithm = pcbZoneHatchBorderAlgorithms.find(
      (option) => option === hatchBorder?.[1],
    );
    const hatchFields = pcbZoneHatchNumericFields.map(([field]) => {
      const [record, duplicate] = children(fill, field);
      if (duplicate || (record && (record.length !== 2 || typeof record[1] !== 'string')))
        fail(`Invalid native zone ${field} setting.`);
      return record && number(record);
    });
    let hatchFill: BoardZone['hatchFill'];
    if (fillMode || hatchBorder || hatchFields.some((field) => field !== undefined)) {
      const [thickness, gap, orientation, minHoleArea, smoothingLevel, smoothingValue] =
        hatchFields;
      if (
        extraMode ||
        extraBorder ||
        fillMode?.length !== 2 ||
        fillMode[1] !== 'hatch' ||
        hatchBorder?.length !== 2 ||
        !hatchBorderAlgorithm ||
        thickness === undefined ||
        gap === undefined ||
        orientation === undefined ||
        minHoleArea === undefined
      )
        return fail('Invalid or unsupported native zone hatch fill.');
      hatchFill = {
        thickness,
        gap,
        orientation,
        minHoleArea,
        borderAlgorithm: hatchBorderAlgorithm,
        ...(smoothingLevel === undefined ? {} : { smoothingLevel }),
        ...(smoothingValue === undefined ? {} : { smoothingValue }),
      };
    }
    const radius = child(fill, 'radius');
    const style = val(smoothing);
    let cornerSmoothing: BoardZone['cornerSmoothing'];
    if (smoothing || radius) {
      if (
        smoothing?.length !== 2 ||
        (radius && radius.length !== 2) ||
        children(fill, 'smoothing').length !== 1 ||
        children(fill, 'radius').length > 1 ||
        (style !== 'chamfer' && style !== 'fillet')
      )
        return fail('Invalid zone corner smoothing.');
      cornerSmoothing = { style, ...(radius ? { radius: number(radius) } : {}) };
    }
    const priority = child(n, 'priority');
    const priorityValue = priority ? Number(val(priority)) : undefined;
    if (
      priority &&
      (children(n, 'priority').length !== 1 ||
        priority.length !== 2 ||
        !/^\d+$/.test(val(priority)) ||
        !Number.isInteger(priorityValue) ||
        priorityValue! > maxPCBZonePriority)
    )
      fail('Invalid zone priority.');
    const islandAreas = children(fill, 'island_area_min');
    const islandArea = islandAreas[0];
    if (islandArea && (islandAreas.length !== 1 || islandArea.length !== 2))
      fail('Invalid minimum island area.');
    const [property, extraProperty] = children(n, 'property');
    let hatchPosition: Point | undefined;
    if (property) {
      const propertyLayer = child(property, 'layer');
      const hatch = child(property, 'hatch_position');
      const xy = hatch && child(hatch, 'xy');
      if (
        extraProperty ||
        property.length !== 3 ||
        propertyLayer?.length !== 2 ||
        val(propertyLayer) !== val(child(n, 'layer')) ||
        hatch?.length !== 2 ||
        xy?.length !== 3
      )
        return fail('Invalid or unsupported native zone layer property.');
      hatchPosition = point(xy);
    }
    const polygons = children(n, 'polygon');
    const outlines = polygons.map((polygon) => {
      const pts = child(polygon, 'pts');
      if (polygon.length !== 2 || !pts) return fail('Invalid native zone polygon.');
      return pts;
    });
    let nativeCircularOutline: true | undefined;
    let nativeOutlineArcs: BoardZone['nativeOutlineArcs'];
    const rings = outlines.map((pts) => {
      const curved = children(pts, 'arc').length > 0;
      const outlinePoint = (p: Point) => local(p, curved ? 9 : 6);
      const vertices: Point[] = [];
      for (const entry of pts.slice(1)) {
        if (Array.isArray(entry) && entry[0] === 'xy' && entry.length === 3) {
          vertices.push(outlinePoint(point(entry)));
          continue;
        }
        if (
          !keep ||
          outlines.length !== 1 ||
          !Array.isArray(entry) ||
          entry[0] !== 'arc' ||
          entry.length !== 4 ||
          !['start', 'mid', 'end'].every(
            (name) => children(entry, name).length === 1 && child(entry, name)?.length === 3,
          )
        )
          return fail('Unsupported native zone polygon vertex or curved contour.');
        const a = point(child(entry, 'start'));
        const b = point(child(entry, 'mid'));
        const c = point(child(entry, 'end'));
        if (a.x === c.x && a.y === c.y) {
          if (pts.length !== 2 || (a.x === b.x && a.y === b.y))
            return fail('Invalid complete circular native rule-area outline.');
          nativeCircularOutline = true;
          return [outlinePoint(a), outlinePoint(b)];
        }
        (nativeOutlineArcs ??= []).push({ vertex: vertices.length, mid: outlinePoint(b) });
        vertices.push(outlinePoint(a), outlinePoint(c));
      }
      if (vertices.length + (nativeOutlineArcs?.length ?? 0) < 3)
        return fail('Invalid native zone polygon vertices.');
      return vertices;
    });
    const filled = children(n, 'filled_polygon').map((p) => {
      allow(p, ['layer', 'island', 'pts'], 'filled polygon');
      const islands = children(p, 'island');
      const island = islands[0];
      if (
        islands.length > 1 ||
        (island &&
          island.length !== 1 &&
          (island.length !== 2 || !['yes', 'no'].includes(val(island))))
      )
        fail('Invalid zone fill island flag.');
      if (val(child(p, 'layer')) !== val(child(n, 'layer')))
        fail('Filled polygon layer disagrees with its zone.');
      const pts = child(p, 'pts');
      if (pts) allow(pts, ['xy'], 'filled polygon points');
      return {
        points: points(pts).map((p) => local(p)),
        ...(island && val(island) !== 'no' ? { island: true as const } : {}),
      };
    });
    if (!polygons.length && (filled.length || keep))
      fail('Native zones without an outline cannot have saved fills or keepout rules.');
    const [placement, extraPlacement] = children(n, 'placement');
    let nativePlacement: PCBPlacementArea | undefined;
    if (placement) {
      const [enabled, extraEnabled] = children(placement, 'enabled');
      if (
        extraPlacement ||
        extraEnabled ||
        enabled?.length !== 2 ||
        !['yes', 'no'].includes(val(enabled))
      )
        fail('Invalid native placement rule.');
      if (val(enabled) === 'yes') {
        const source = placement.slice(1).find((field) => field !== enabled);
        const sourceKind = Array.isArray(source)
          ? pcbPlacementSourceKinds.find((kind) => kind === source[0])
          : undefined;
        const sourceName = Array.isArray(source) ? val(source) : '';
        if (
          !keep ||
          placement.length !== 3 ||
          !Array.isArray(source) ||
          source.length !== 2 ||
          !sourceKind ||
          !sourceName ||
          sourceName.length > 4096
        )
          return fail('Enabled native placement areas require a rule area and a named source.');
        nativePlacement = { sourceKind, sourceName };
      }
    }
    const teardrop = readPCBTeardropKind(n, fail);
    const thermalGap = child(fill, 'thermal_gap');
    const thermalBridge = child(fill, 'thermal_bridge_width');
    const recordId = id(n, key);
    const layer = val(child(n, 'layer')) as BoardLayer;
    return {
      id: recordId,
      ...(teardrop ? { teardrop } : {}),
      ...lock(n, recordId),
      netId,
      layer,
      outline: rings[0] ?? [],
      ...(nativeCircularOutline ? { nativeCircularOutline } : {}),
      ...(nativeOutlineArcs ? { nativeOutlineArcs } : {}),
      ...(rings.length > 1 ? { holes: rings.slice(1) } : {}),
      ...(filled.length ? { filledPolygons: filled } : {}),
      ...(filled.length && netId === null && layer.endsWith('.Cu')
        ? { nativeUnassignedFill: true as const }
        : {}),
      clearance: number(child(connection, 'clearance')),
      minThickness: number(child(n, 'min_thickness')),
      thermalGap: teardrop && !thermalGap ? defaultPCBTeardropThermal : number(thermalGap),
      thermalBridge: teardrop && !thermalBridge ? defaultPCBTeardropThermal : number(thermalBridge),
      fillEnabled: fill.includes('yes'),
      ...(priorityValue === undefined ? {} : { priority: priorityValue }),
      ...(typeof connection[1] === 'string'
        ? { padConnection: val(connection) as BoardZone['padConnection'] }
        : {}),
      ...(child(fill, 'island_removal_mode')
        ? { islandRemovalMode: number(child(fill, 'island_removal_mode')) }
        : {}),
      ...(islandArea ? { islandAreaMin: number(islandArea) } : {}),
      ...(cornerSmoothing ? { cornerSmoothing } : {}),
      ...(hatchPosition ? { hatchPosition } : {}),
      ...(hatchFill ? { hatchFill } : {}),
      ...(nativePlacement ? { nativePlacement } : {}),
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
    if (typeof n[1] !== 'string') fail('Expected a native footprint library identity.');
    allow(
      n,
      [
        'version',
        'generator',
        'generator_version',
        'layer',
        'uuid',
        'at',
        'locked',
        'placed',
        'units',
        'solder_mask_margin',
        'solder_paste_margin',
        'solder_paste_margin_ratio',
        ...footprintZoneOverrideNames,
        'path',
        'attr',
        'sheetname',
        'sheetfile',
        'tags',
        'property',
        'variant',
        'duplicate_pad_numbers_are_jumpers',
        'jumper_pad_groups',
        'net_tie_pad_groups',
        'descr',
        'fp_line',
        'fp_rect',
        'fp_arc',
        'fp_curve',
        'fp_circle',
        'fp_poly',
        'fp_text',
        'fp_text_box',
        'group',
        'point',
        'pad',
        'zone',
        'embedded_fonts',
        'embedded_files',
        'stackup',
        'model',
      ],
      'footprint',
    );
    const versions = children(n, 'version');
    if (
      versions.length > 1 ||
      (versions[0] &&
        (versions[0].length !== 2 ||
          typeof versions[0][1] !== 'string' ||
          !/^\d{8}$/.test(versions[0][1]) ||
          versions[0][1] > KICAD_PCB_VERSION))
    )
      fail('Invalid or unsupported native embedded footprint format version.');
    for (const key of ['generator', 'generator_version']) {
      const fields = children(n, key);
      if (
        fields.length > 1 ||
        fields.some((field) => field.length !== 2 || typeof field[1] !== 'string' || !val(field))
      )
        fail(`Invalid native embedded footprint ${key}.`);
    }
    const placed = children(n, 'placed');
    if (
      placed.length > 1 ||
      (placed[0] && (placed[0].length !== 2 || !['yes', 'no'].includes(val(placed[0]))))
    )
      fail('Invalid native footprint placement state.');
    validateNativePCBEmbeddedFiles(n);
    const stackups = children(n, 'stackup');
    if (stackups.length) {
      const [stackup] = stackups;
      const layerNames = new Set<string>();
      if (
        stackups.length !== 1 ||
        stackup.length < 2 ||
        stackup.length > 78 ||
        stackup.slice(1).some((item) => {
          if (
            !Array.isArray(item) ||
            item[0] !== 'layer' ||
            item.length !== 2 ||
            typeof item[1] !== 'string' ||
            !item[1].startsWith('"')
          )
            return true;
          const layer = val(item);
          if (layerNames.has(layer) || !layer) return true;
          layerNames.add(layer);
          return false;
        })
      )
        return fail('Invalid native footprint stackup.');
    }
    const footprintId = id(n, `footprint:${fi}`);
    const units = child(n, 'units');
    if (units) {
      allow(units, ['unit'], 'footprint units');
      for (const unit of children(units, 'unit')) {
        allow(unit, ['name', 'pins'], 'footprint unit');
        if (!child(unit, 'name') || !child(unit, 'pins'))
          fail('Incomplete footprint unit metadata.');
      }
    }
    const referenceField = children(n, 'property').find((p) => val(p) === 'Reference');
    const valueField = children(n, 'property').find((p) => val(p) === 'Value');
    if ([referenceField, valueField].some((record) => record && typeof record[2] !== 'string'))
      fail('Invalid native footprint caption.');
    const reference = val(referenceField, 2),
      value = val(valueField, 2);
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
    const radians = (rotation * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const local = (p: Point, digits: number): Point => {
      const x = p.x - at.x;
      const y = p.y - at.y;
      return {
        x: Number((x * cosine - y * sine).toFixed(digits)) + 0,
        y: Number((x * sine + y * cosine).toFixed(digits)) + 0,
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
          'keep_end_layers',
          'zone_layer_connections',
          'front_post_machining',
          'back_post_machining',
          'die_length',
          'die_delay',
          'padstack',
          'solder_mask_margin',
          'solder_paste_margin',
          'solder_paste_margin_ratio',
          'thermal_bridge_angle',
          'teardrops',
          'roundrect_rratio',
          'rect_delta',
          'chamfer_ratio',
          'chamfer',
          'options',
          'primitives',
          ...padZoneOverrideNames,
          'pinfunction',
          'pintype',
          'property',
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
      const drills = children(p, 'drill');
      if (drills.length > 1) fail('A pad repeats its drill.');
      const type = (val(p, 2) === 'connect' ? 'smd' : val(p, 2)) as Pad['type'];
      const drill = readPadDrill(drills[0], fail, type === 'smd');
      const shape = val(p, 3) as Pad['shape'];
      const nativeSize = point(child(p, 'size'));
      if (nativeSize.x < 0.000001 || nativeSize.y < 0.000001)
        fail('Pad dimensions must be positive.');
      // KiCad renders a circle with a radius of half its X dimension.
      const size = shape === 'circle' ? { x: nativeSize.x, y: nativeSize.x } : nativeSize;
      const customPad = readBoardCustomPad(
        p,
        { type, shape, size, drillOffset: drill.drillOffset },
        fail,
      );
      const padRotation = angle(number(child(p, 'at'), 3, 0) - rotation);
      const anchor = point(child(p, 'at'));
      const offset = drill.drillOffset;
      const copper = offset
        ? footprintPoint({ ...anchor, rotation: padRotation }, { x: -offset.x, y: -offset.y })
        : anchor;
      const teardrops = readPCBTeardropSettings(p, fail);
      const padId = id(p, `fp:${fi}:pad:${pi}`);
      const roundrectRatio = readPCBPadRoundRectRatio(p, fail);
      const trapezoidDelta = readPCBPadTrapezoidDelta(p, fail);
      const postMachining = readPCBPadPostMachining(p, fail);
      const padstack = readPCBPadstack(p, fail);
      const result: Pad = {
        id: padId,
        ...lock(p, padId),
        number: val(p),
        type,
        ...(val(p, 2) === 'connect' ? { nativeConnect: true as const } : {}),
        shape,
        ...copper,
        rotation: padRotation,
        ...drill,
        size,
        ...(roundrectRatio === undefined ? {} : { roundrectRatio }),
        ...(trapezoidDelta ? { trapezoidDelta } : {}),
        ...(postMachining ? { postMachining } : {}),
        ...(padstack ? { padstack } : {}),
        ...customPad,
        ...readPCBPadFabricationProperty(p, fail),
        ...readPCBPadPruning(p, fail),
        ...(teardrops ? { teardrops } : {}),
        ...readZoneOverrides(p),
        netId: net(p),
        layers: child(p, 'layers')!
          .slice(1)
          .map((_, i) => val(child(p, 'layers'), i + 1)) as Pad['layers'],
      };
      validatePCBPadTrapezoid(result, fail);
      for (const [key, native] of [
        ['dieLength', 'die_length'],
        ['dieDelay', 'die_delay'],
        ['chamferRatio', 'chamfer_ratio'],
        ['solderMaskMargin', 'solder_mask_margin'],
        ['solderPasteMargin', 'solder_paste_margin'],
        ['solderPasteMarginRatio', 'solder_paste_margin_ratio'],
        ['thermalBridgeAngle', 'thermal_bridge_angle'],
      ] as const) {
        const fields = children(p, native);
        if (!fields.length) continue;
        if (fields.length !== 1 || fields[0].length !== 2) fail(`Invalid native pad ${native}.`);
        result[key] = number(fields[0]);
      }
      if (child(p, 'chamfer'))
        result.chamfer = child(p, 'chamfer')!
          .slice(1)
          .map((_, i) => val(child(p, 'chamfer'), i + 1)) as Pad['chamfer'];
      if (
        part &&
        symbolPins.size &&
        !symbolPins.has(result.number) &&
        padHasElectricalPin(result)
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
          [
            'fp_line',
            'fp_rect',
            'fp_arc',
            'fp_curve',
            'fp_circle',
            'fp_poly',
            'fp_text',
            'fp_text_box',
            'property',
          ].includes(String(c[0])),
      )
      .map((g, gi) => graph(g, `fp:${fi}:graphic:${gi}`, rotation));
    for (const g of graphics) {
      if (g.text?.property === 'Reference') g.text.value = '${REFERENCE}';
      if (g.text?.property === 'Value') g.text.value = '${VALUE}';
    }
    const referencePoints = children(n, 'point').map<
      NonNullable<Footprint['referencePoints']>[number]
    >((record) => {
      const position = child(record, 'at');
      const size = child(record, 'size');
      const layer = child(record, 'layer');
      const uuid = child(record, 'uuid');
      if (
        record.length !== 5 ||
        position?.length !== 3 ||
        size?.length !== 2 ||
        layer?.length !== 2 ||
        uuid?.length !== 2
      )
        fail('Invalid footprint reference point.');
      const layerName = pcbBoardLayers.find((name) => name === val(layer));
      if (!layerName) return fail('Unsupported footprint reference point layer.');
      // Keep enough precision to round-trip native board coordinates through an arbitrary angle.
      return { ...local(point(position), 12), id: val(uuid), size: number(size), layer: layerName };
    });
    const hasPins =
      part &&
      children(schematic.libraries[part.libId], 'symbol').some((s) => children(s, 'pin').length);
    const netTiePadGroups = readPCBNetTiePadGroups(n, pads, fail);
    const [jumpers, duplicateJumpers] = children(n, 'jumper_pad_groups');
    const jumperPadGroups = jumpers?.slice(1).map((group) => {
      if (
        !Array.isArray(group) ||
        group.some((item) => typeof item !== 'string' || !item.startsWith('"'))
      )
        return fail('Invalid native footprint jumper group.');
      return group.map((item) => val(['pad', item]));
    });
    if (duplicateJumpers) return fail('Repeated native footprint jumper groups.');
    return {
      id: footprintId,
      symbolId: hasPins ? part!.id : null,
      libraryId: val(n),
      ...at,
      rotation,
      ...readZoneOverrides(n, true),
      ...lock(n, footprintId),
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
      ...(!hasPins && !referenceField ? { nativeMissingReference: true as const } : {}),
      ...(!hasPins && !valueField ? { nativeMissingValue: true as const } : {}),
      ...(netTiePadGroups ? { netTiePadGroups } : {}),
      ...(jumperPadGroups ? { jumperPadGroups } : {}),
      pads,
      graphics,
      ...(referencePoints.length ? { referencePoints } : {}),
      ...(children(n, 'model').length ? { models: footprintModels(n) } : {}),
      ...(child(n, 'zone')
        ? {
            zones: children(n, 'zone').map((z, i) =>
              zone(z, `fp:${fi}:zone:${i}`, (p, digits = 6) => local(p, digits)),
            ),
          }
        : {}),
    };
  });
  const trackLayers = (
    n: SExpr,
  ): Pick<PCB['tracks'][number], 'layer' | 'maskLayer' | 'solderMaskMargin'> => {
    const [single, duplicateSingle] = children(n, 'layer');
    const [pair, duplicatePair] = children(n, 'layers');
    const [margin, duplicateMargin] = children(n, 'solder_mask_margin');
    if (
      duplicateSingle ||
      duplicatePair ||
      duplicateMargin ||
      (single && pair) ||
      (single ? single.length !== 2 || margin : !pair || pair.length !== 3)
    )
      return fail('Invalid native track layers or solder mask margin.');
    const names = (single ?? pair)!.slice(1).map((_, index) => val(single ?? pair, index + 1));
    const layer = names.find((name) => name.endsWith('.Cu')) as
      PCB['tracks'][number]['layer'] | undefined;
    if (!layer) return fail('Native track requires a copper layer.');
    if (!pair) return { layer };
    const maskLayer = names.find(
      (name): name is 'F.Mask' | 'B.Mask' => name === 'F.Mask' || name === 'B.Mask',
    );
    if (
      !maskLayer ||
      ((layer !== 'F.Cu' || maskLayer !== 'F.Mask') &&
        (layer !== 'B.Cu' || maskLayer !== 'B.Mask')) ||
      (margin && (margin.length !== 2 || typeof margin[1] !== 'string'))
    )
      return fail('Native track solder mask must match its outer copper side.');
    return { layer, maskLayer, ...(margin ? { solderMaskMargin: number(margin) } : {}) };
  };
  const trackFields = [
    'start',
    'end',
    'width',
    'layer',
    'layers',
    'solder_mask_margin',
    'net',
    'uuid',
    'locked',
  ];
  const tracks = children(root, 'segment').map((n, i) => {
    allow(n, trackFields, 'track');
    const flags = children(n, 'locked');
    if (
      n.filter((entry) => entry === 'locked').length > 1 ||
      flags.length > 1 ||
      (flags.length && n.includes('locked')) ||
      (flags.length && (flags[0].length !== 2 || !['yes', 'no'].includes(val(flags[0]))))
    )
      fail('Track has an invalid locked setting.');
    const netId = net(n) ?? '';
    const recordId = id(n, `track:${i}`);
    return {
      id: recordId,
      start: point(child(n, 'start')),
      end: point(child(n, 'end')),
      width: number(child(n, 'width')),
      ...trackLayers(n),
      netId,
      ...lock(n, recordId, n.includes('locked') || val(flags[0]) === 'yes'),
    };
  });
  const arcTracks = children(root, 'arc').map((n, i) => {
    allow(n, [...trackFields, 'mid'], 'arc track');
    const netId = net(n) ?? '';
    const recordId = id(n, `arcTrack:${i}`);
    return {
      id: recordId,
      start: point(child(n, 'start')),
      mid: point(child(n, 'mid')),
      end: point(child(n, 'end')),
      width: number(child(n, 'width')),
      ...trackLayers(n),
      netId,
      ...lock(n, recordId),
    };
  });
  const layers = (child(root, 'layers') ?? [])
    .filter((l): l is SExpr => Array.isArray(l) && val(l, 1).endsWith('.Cu'))
    .map((l) => val(l, 1));
  if (!isPCBCopperStack(layers)) return fail('Expected 2 to 32 ordered KiCad copper layers.');
  const vias = children(root, 'via').map((n, i) => {
    allow(
      n,
      [
        'at',
        'size',
        'drill',
        'backdrill',
        'tertiary_drill',
        'layers',
        'net',
        'uuid',
        'free',
        'remove_unused_layers',
        'keep_end_layers',
        'start_end_only',
        'zone_layer_connections',
        'locked',
        'capping',
        'covering',
        'plugging',
        'filling',
        'tenting',
        'teardrops',
        'padstack',
      ],
      'via',
    );
    const span = readPCBViaSpan(n, layers, fail);
    const backdrills = readPCBViaBackdrills(n, fail);
    const treatment = readPCBViaTreatment(n, fail);
    const padstack = readPCBViaPadstack(n, fail);
    const free = readPCBViaFlag(n, 'free', fail, true);
    const netId = net(n);
    const teardrops = readPCBTeardropSettings(n, fail);
    const tenting = readPCBViaTenting(n, fail);
    const recordId = id(n, `via:${i}`);
    return {
      id: recordId,
      ...(span ? { span } : {}),
      ...(backdrills ? { backdrills } : {}),
      ...(treatment ? { treatment } : {}),
      ...(padstack ? { padstack } : {}),
      ...(free !== undefined ? { free } : {}),
      ...readPCBViaPruning(n, fail),
      ...(teardrops ? { teardrops } : {}),
      ...(tenting ? { tenting } : {}),
      ...lock(n, recordId),
      ...point(child(n, 'at')),
      diameter: number(child(n, 'size')),
      drill: number(child(n, 'drill')),
      netId: netId ?? '',
    };
  });
  const zones = children(root, 'zone').map((n, i) => zone(n, `zone:${i}`));
  const graphics = root
    .filter(
      (n): n is SExpr =>
        Array.isArray(n) &&
        (String(n[0]).startsWith('gr_') || n[0] === 'dimension' || n[0] === 'point'),
    )
    .map((n, i) => graph(n, `graphic:${i}`));
  const referenceImages = children(root, 'image');
  pcbReferenceImages(referenceImages);
  const barcodes = children(root, 'barcode');
  pcbBarcodes(barcodes);
  const nativeTables = children(root, 'table');
  pcbTableDrawings(nativeTables);
  const tuningPatterns = children(root, 'generated');
  if (tuningPatterns.length)
    validateNativePCBTuningPatterns(
      tuningPatterns,
      tracks.concat(arcTracks),
      layers,
      children(root, 'group'),
    );
  const thickness = child(child(root, 'general') ?? [], 'thickness');
  const board: PCB = {
    id: stable('board'),
    thickness: thickness ? number(thickness) : 1.6,
    layers,
    nets: [...nets].map(([name, id]) => ({ id, name })),
    footprints,
    tracks,
    ...(arcTracks.length ? { arcTracks } : {}),
    ...(tuningPatterns.length ? { tuningPatterns } : {}),
    ...(referenceImages.length ? { referenceImages } : {}),
    ...(barcodes.length ? { barcodes } : {}),
    ...(nativeTables.length ? { nativeTables } : {}),
    ...(groupLocks.length ? { groupLocks: groupLocks.sort() } : {}),
    vias,
    graphics,
    zones,
  };
  return {
    board,
    normalized,
    nativeRectangleIds,
    audit: {
      footprints: footprints.length,
      pads: footprints.reduce((n, f) => n + f.pads.length, 0),
      tracks: tracks.length + arcTracks.length,
      vias: vias.length,
      zones: zones.length + footprints.reduce((n, f) => n + (f.zones?.length ?? 0), 0),
      graphics: graphics.length + footprints.reduce((n, f) => n + f.graphics.length, 0),
      unlinkedReferences: footprints.filter((f) => !f.symbolId).map((f) => f.reference!),
    },
  };
}
