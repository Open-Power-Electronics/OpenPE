import { uid, type Circuit, type Point } from './circuit';
import type { BoardLine, BoardText, CopperLayer, Footprint, Pad, PCB } from './pcb';
import { child, children, val, type SExpr } from './sexpr';
import { pcbGraphicPoints, transformPCBGraphic, transformPCBZone } from './pcb-geometry';
import { footprintModels } from './pcb-models';
import { squaredDistance } from './pcb-collision';
import { localPadDrillLine, padDrillClearance, readPadDrill } from './pcb-drill';
import { padBoundPoints, readCustomPad, validateCustomPad } from './pcb-custom-pad';
import { footprintTextPlacement } from './pcb-text';
import { padApertureLayers, padHasElectricalPin, readPadHeatsink } from './pcb-pad-role';
export { insidePolygon, pointSegmentDistance, segmentDistance } from './pcb-collision';
export { pcbPadChamferEndpoints, pcbPadCorners } from './pcb-geometry';

export type PCBSelection = {
  kind: 'footprint' | 'track' | 'via' | 'graphic' | 'zone';
  id: string;
};
export type PCBBounds = { minX: number; minY: number; maxX: number; maxY: number };
type Selection = PCBSelection | readonly PCBSelection[];

// Canonicalize signed zero when transforming native coordinates.
const round = (n: number) => Number(n.toFixed(6)) + 0;
const angle = (n: number) => round(((n % 360) + 360) % 360);
function fail(message: string): never {
  throw new Error(`Layout: ${message}`);
}
const coordinate = (n: number) => {
  if (!Number.isFinite(n) || Math.abs(n) > 100000) fail('Coordinates must be within ±100000 mm.');
  return round(n);
};
const point = (p: Point): Point => ({ x: coordinate(p.x), y: coordinate(p.y) });

export function createEmptyPCB(): PCB {
  return {
    id: uid(),
    thickness: 1.6,
    layers: ['F.Cu', 'B.Cu'],
    nets: [],
    footprints: [],
    tracks: [],
    vias: [],
    graphics: [],
    zones: [],
  };
}

/** Native PCB coordinates are already mirrored for a back-side footprint.
 * KiCad 10 rotates local coordinates counterclockwise in its downward-Y canvas;
 * applying another reflection merely because side is back would misplace pads.
 */
export function footprintPoint(footprint: Point & { rotation: number }, local: Point): Point {
  const radians = (-footprint.rotation * Math.PI) / 180;
  return {
    x: round(footprint.x + local.x * Math.cos(radians) - local.y * Math.sin(radians)),
    y: round(footprint.y + local.x * Math.sin(radians) + local.y * Math.cos(radians)),
  };
}
export const padPosition = (footprint: Footprint, pad: Pad) => footprintPoint(footprint, pad);
/** Positive KiCad angle; negate this value for an SVG rotate transform. */
export const padRotation = (footprint: Footprint, pad: Pad) =>
  angle(footprint.rotation + pad.rotation);
export function padDrillPosition(footprint: Footprint, pad: Pad): Point {
  return footprintPoint(footprint, pad.drillOffset ? footprintPoint(pad, pad.drillOffset) : pad);
}

export function padDrillLine(footprint: Footprint, pad: Pad): [Point, Point] {
  const at = { ...padDrillPosition(footprint, pad), rotation: padRotation(footprint, pad) };
  const [start, end] = localPadDrillLine({ drill: pad.drill, drillSlot: pad.drillSlot });
  return [footprintPoint(at, start), footprintPoint(at, end)];
}

/** Flip through the footprint origin's horizontal board axis, preserving IDs/nets. */
export function flipPCBFootprint(footprint: Footprint): Footprint {
  if (footprint.locked) fail('Unlock the footprint before editing.');
  const mirror = (p: Point): Point => ({ x: p.x, y: -p.y || 0 });
  const flipText = (text: BoardText): BoardText => {
    const { justify, ...rest } = text;
    const next = justify?.includes('mirror')
      ? justify.filter((v) => v !== 'mirror')
      : [...(justify ?? []), 'mirror' as const];
    return { ...rest, rotation: angle(-text.rotation), ...(next.length ? { justify: next } : {}) };
  };
  return {
    ...footprint,
    side: footprint.side === 'front' ? 'back' : 'front',
    rotation: angle(-footprint.rotation),
    pads: footprint.pads.map((p) => ({
      ...p,
      ...mirror(p),
      rotation: angle(-p.rotation),
      ...(p.outline ? { outline: p.outline.map(mirror) } : {}),
      ...(p.drillOffset ? { drillOffset: mirror(p.drillOffset) } : {}),
      ...(p.layers
        ? {
            layers: p.layers.map(
              (l) =>
                l
                  .replace(/^F\./, 'temporary.')
                  .replace(/^B\./, 'F.')
                  .replace(/^temporary\./, 'B.') as NonNullable<Pad['layers']>[number],
            ),
          }
        : {}),
      ...(p.chamfer
        ? {
            chamfer: p.chamfer.map(
              (c) =>
                c
                  .replace(/^top_/, 'temporary_')
                  .replace(/^bottom_/, 'top_')
                  .replace(/^temporary_/, 'bottom_') as NonNullable<Pad['chamfer']>[number],
            ),
          }
        : {}),
    })),
    graphics: footprint.graphics.map((g) => ({
      ...transformPCBGraphic(g, mirror, (n) => angle(-n)),
      ...(g.text ? { text: flipText(g.text) } : {}),
      layer: (g.layer.startsWith('F.')
        ? g.layer.replace(/^F\./, 'B.')
        : g.layer.replace(/^B\./, 'F.')) as BoardLine['layer'],
    })),
    ...(footprint.referencePoints
      ? {
          referencePoints: footprint.referencePoints.map((p): typeof p => ({
            ...p,
            ...mirror(p),
            layer: p.layer === 'F.Fab' ? 'B.Fab' : 'F.Fab',
          })),
        }
      : {}),
    ...(footprint.zones
      ? {
          zones: footprint.zones.map((z) => ({
            ...transformPCBZone(z, mirror),
            layer: z.layer
              .replace(/^F\./, 'temporary.')
              .replace(/^B\./, 'F.')
              .replace(/^temporary\./, 'B.') as BoardLine['layer'],
          })),
        }
      : {}),
  };
}

function allowedChildren(node: SExpr, allowed: readonly string[], context: string) {
  const seen = new Set<string>();
  for (const item of node.filter((n): n is SExpr => Array.isArray(n))) {
    const name = String(item[0]);
    if (!allowed.includes(name))
      fail(`${context} uses unsupported ${name}. Choose another footprint.`);
    if (seen.has(name)) fail(`${context} repeats ${name}. Choose another footprint.`);
    seen.add(name);
  }
}
function sourceNumber(node: SExpr | undefined, index: number, context: string, optional = false) {
  const raw = val(node, index);
  if (!raw && optional) return 0;
  const n = Number(raw);
  if (
    !raw ||
    !Number.isFinite(n) ||
    Math.abs(n) > 100000 ||
    Math.abs(n - Number(n.toFixed(6))) > 1e-9
  )
    fail(`${context} needs finite dimensions at 0.000001 mm precision.`);
  return n;
}
const sourcePoint = (node: SExpr | undefined, context: string): Point => ({
  x: sourceNumber(node, 1, context),
  y: sourceNumber(node, 2, context),
});
function tuple(node: SExpr | undefined, min: number, max: number, context: string) {
  if (!node || node.length < min + 1 || node.length > max + 1 || node.slice(1).some(Array.isArray))
    fail(`${context} uses unsupported coordinates or dimensions.`);
}
function sourcePositive(node: SExpr | undefined, index: number, context: string, minimum = 0.0001) {
  const n = sourceNumber(node, index, context);
  if (n < minimum || n > 1000) fail(`${context} must be between ${minimum} and 1000 mm.`);
  return n;
}
function sourceFlag(node: SExpr, name: string, context: string): boolean {
  const flags = node.filter((item) => item === name),
    flag = child(node, name);
  if (flags.length > 1 || (flags.length && flag)) fail(`${context} repeats ${name}.`);
  if (!flag) return Boolean(flags.length);
  tuple(flag, 1, 1, `${context} ${name}`);
  if (!['yes', 'no'].includes(val(flag))) fail(`${context} ${name} must be yes or no.`);
  return val(flag) === 'yes';
}

/** Library user text is native package artwork, including polarity markers. */
function sourceFootprintText(node: SExpr, graphicLayers: readonly string[]): BoardLine {
  allowedChildren(
    node,
    ['at', 'layer', 'effects', 'hide', 'unlocked', 'uuid', 'tstamp'],
    'The footprint text',
  );
  if (
    typeof node[2] !== 'string' ||
    node.slice(3).some((item) => !Array.isArray(item) && item !== 'hide' && item !== 'unlocked') ||
    val(node, 2).length > 4096
  )
    fail('The footprint text uses unsupported content or flags.');
  const { at, unlocked } = footprintTextPlacement(node, fail);
  tuple(at, 2, 3, 'Text position');
  tuple(child(node, 'layer'), 1, 1, 'Text layer');
  const layer = val(child(node, 'layer'));
  if (!graphicLayers.includes(layer)) fail(`Footprint text on ${layer} is not supported.`);
  const effects = child(node, 'effects');
  if (!effects) fail('The footprint text has no font geometry.');
  allowedChildren(effects, ['font', 'justify', 'hide'], 'The text effects');
  if (effects.slice(1).some((item) => !Array.isArray(item) && item !== 'hide'))
    fail('The text effects contain unsupported flags.');
  const font = child(effects, 'font');
  if (!font) fail('The footprint text has no font geometry.');
  allowedChildren(font, ['size', 'thickness', 'bold', 'italic'], 'The text font');
  if (font.slice(1).some((item) => !Array.isArray(item) && item !== 'bold' && item !== 'italic'))
    fail('The footprint text uses an unsupported font.');
  tuple(child(font, 'size'), 2, 2, 'Text size');
  const size = sourcePoint(child(font, 'size'), 'Text size');
  if (size.x <= 0 || size.y <= 0 || size.x > 1000 || size.y > 1000)
    fail('Text size must be greater than 0 and at most 1000 mm.');
  const thicknessNode = child(font, 'thickness');
  if (thicknessNode) tuple(thicknessNode, 1, 1, 'Text thickness');
  const thickness = thicknessNode ? sourceNumber(thicknessNode, 1, 'Text thickness') : 0;
  if (thickness < 0 || thickness > 1000) fail('Text thickness must be between 0 and 1000 mm.');
  const justifyNode = child(effects, 'justify');
  if (justifyNode) tuple(justifyNode, 1, 3, 'Text justification');
  const justify = justifyNode?.slice(1).map((_, i) => val(justifyNode, i + 1));
  if (
    justify &&
    (new Set(justify).size !== justify.length ||
      justify.some((item) => !['left', 'right', 'top', 'bottom', 'mirror'].includes(item)))
  )
    fail('The footprint text uses unsupported justification.');
  const nodeHidden = sourceFlag(node, 'hide', 'The footprint text'),
    effectsHidden = sourceFlag(effects, 'hide', 'The text effects'),
    hidden = nodeHidden || effectsHidden,
    bold = sourceFlag(font, 'bold', 'The text font'),
    italic = sourceFlag(font, 'italic', 'The text font');
  const position = sourcePoint(at, 'Text position');
  return {
    id: uid(),
    kind: 'text',
    start: position,
    end: { ...position },
    width: 0,
    layer: layer as BoardLine['layer'],
    ...(unlocked ? { keepUpright: false } : {}),
    text: {
      value: val(node, 2),
      rotation: angle(sourceNumber(at, 3, 'Text rotation', true)),
      size,
      thickness,
      ...(justify ? { justify: justify as BoardText['justify'] } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
    },
  };
}

type FootprintMargins = Pick<
  Footprint,
  'solderMaskMargin' | 'solderPasteMargin' | 'solderPasteMarginRatio'
>;
const footprintMarginFields = new Map<string, keyof FootprintMargins>([
  ['solder_mask_margin', 'solderMaskMargin'],
  ['solder_paste_margin', 'solderPasteMargin'],
  ['solder_paste_margin_ratio', 'solderPasteMarginRatio'],
]);

/** Convert only geometry represented exactly by the existing PCB v1 schema.
 * Author standard captions as native fields whose content follows the schematic.
 * Pads remain unassigned until the user explicitly assigns a board net.
 */
export function readLibraryFootprint(detail: {
  id: string;
  footprint: SExpr;
}): Pick<Footprint, 'pads' | 'graphics' | 'models'> & FootprintMargins {
  const root = detail.footprint;
  if (
    !detail.id.includes(':') ||
    detail.id.length > 4096 ||
    root[0] !== 'footprint' ||
    detail.id.split(':').slice(1).join(':') !== val(root)
  )
    fail('The selected footprint does not match its library identity.');
  if (root.length > 10000) fail('This footprint exceeds the supported size.');
  if (val(child(root, 'layer')) !== 'F.Cu')
    fail('Only front-side library footprints can be placed.');
  const pads: Pad[] = [],
    graphics: BoardLine[] = [];
  const margins: FootprintMargins = {};
  const graphicLayers = [
    'F.SilkS',
    'B.SilkS',
    'F.Fab',
    'B.Fab',
    'F.CrtYd',
    'B.CrtYd',
    'Dwgs.User',
    'Cmts.User',
    'Eco1.User',
    'Eco2.User',
    'User.1',
    'User.2',
    'User.3',
    'User.4',
  ];
  for (const node of root.slice(2)) {
    if (!Array.isArray(node)) fail('This footprint contains an unsupported top-level flag.');
    const kind = String(node[0]);
    const margin = footprintMarginFields.get(kind);
    if (margin) {
      if (margins[margin] !== undefined) fail(`The footprint repeats ${kind}.`);
      tuple(node, 1, 1, `Footprint ${kind}`);
      margins[margin] = sourceNumber(node, 1, `Footprint ${kind}`);
      continue;
    }
    if (
      [
        'version',
        'generator',
        'generator_version',
        'layer',
        'descr',
        'tags',
        'tstamp',
        'tedit',
        'uuid',
        'model',
      ].includes(kind)
    )
      continue;
    if (kind === 'embedded_fonts' || kind === 'duplicate_pad_numbers_are_jumpers') {
      if (val(node) !== 'no') fail(`Footprints with ${kind} enabled are not supported.`);
      continue;
    }
    if (kind === 'attr') {
      if (node.slice(1).some((a) => a !== 'smd' && a !== 'through_hole'))
        fail('This footprint uses unsupported placement attributes.');
      continue;
    }
    if (kind === 'property') {
      if (
        !['Reference', 'Value', 'Datasheet', 'Description'].includes(val(node)) &&
        val(child(node, 'hide')) !== 'yes'
      )
        fail('Custom visible footprint properties are not supported.');
      continue;
    }
    if (kind === 'fp_text') {
      if (['reference', 'value'].includes(val(node))) continue;
      if (val(node) !== 'user') fail('This footprint uses an unsupported text type.');
      graphics.push(sourceFootprintText(node, graphicLayers));
      if (graphics.length > 2000) fail('This footprint exceeds the supported geometry limit.');
      continue;
    }
    if (kind === 'pad') {
      allowedChildren(
        node,
        [
          'at',
          'size',
          'drill',
          'layers',
          'uuid',
          'tstamp',
          'remove_unused_layers',
          'roundrect_rratio',
          'chamfer_ratio',
          'chamfer',
          'options',
          'primitives',
          'solder_mask_margin',
          'solder_paste_margin',
          'solder_paste_margin_ratio',
          'thermal_bridge_angle',
          'zone_connect',
          'property',
        ],
        'The pad',
      );
      const type = val(node, 2),
        shape = val(node, 3),
        number = val(node);
      if (type !== 'smd' && type !== 'thru_hole' && type !== 'np_thru_hole')
        fail(`Pad type ${type} is not supported.`);
      if (!['rect', 'circle', 'oval', 'roundrect', 'custom'].includes(shape))
        fail(`Pad shape ${shape} is not supported.`);
      const customPad = readCustomPad(node, fail);
      const { outline } = customPad;
      const ratioNode = child(node, 'roundrect_rratio');
      if ((shape === 'roundrect') !== Boolean(ratioNode))
        fail(
          'Rounded rectangular pads require an explicit corner ratio; other pad shapes cannot use it.',
        );
      let roundrectRatio: number | undefined;
      if (ratioNode) {
        tuple(ratioNode, 1, 1, 'Pad corner ratio');
        const rawRatio = val(ratioNode);
        roundrectRatio = Number(rawRatio);
        if (
          !rawRatio ||
          !Number.isFinite(roundrectRatio) ||
          roundrectRatio < 0 ||
          roundrectRatio > 0.5
        )
          fail('Pad corner ratio must be between 0 and 0.5.');
      }
      const chamferNode = child(node, 'chamfer');
      const chamferRatioNode = child(node, 'chamfer_ratio');
      let chamfer: Pad['chamfer'];
      let chamferRatio: number | undefined;
      if (chamferNode || chamferRatioNode) {
        const allowed = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
        tuple(chamferNode, 1, 4, 'Pad chamfer corners');
        tuple(chamferRatioNode, 1, 1, 'Pad chamfer ratio');
        const rawRatio = val(chamferRatioNode);
        const corners = chamferNode!.slice(1).map((_, i) => val(chamferNode, i + 1));
        const ratio = Number(rawRatio);
        if (
          shape !== 'roundrect' ||
          !rawRatio ||
          !Number.isFinite(ratio) ||
          ratio <= 0 ||
          ratio > 0.5 ||
          new Set(corners).size !== corners.length ||
          corners.some((corner) => !allowed.includes(corner))
        )
          fail(
            'Pad chamfers require distinct corners and a ratio greater than zero and at most 0.5.',
          );
        chamferRatio = ratio;
        chamfer = corners as Pad['chamfer'];
      }
      const attributes: Partial<
        Pick<
          Pad,
          | 'solderMaskMargin'
          | 'solderPasteMargin'
          | 'solderPasteMarginRatio'
          | 'thermalBridgeAngle'
          | 'zoneConnect'
        >
      > = {};
      for (const [native, key, minimum, maximum] of [
        ['solder_mask_margin', 'solderMaskMargin', -100000, 100000],
        ['solder_paste_margin', 'solderPasteMargin', -100000, 100000],
        ['solder_paste_margin_ratio', 'solderPasteMarginRatio', -1, 1],
        ['thermal_bridge_angle', 'thermalBridgeAngle', -360, 360],
        ['zone_connect', 'zoneConnect', 0, 3],
      ] as const) {
        const attribute = child(node, native);
        if (!attribute) continue;
        tuple(attribute, 1, 1, `Pad ${native}`);
        let value: number;
        if (key === 'solderPasteMarginRatio') {
          const raw = val(attribute);
          if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))
            fail('Pad solder_paste_margin_ratio must be a finite ratio.');
          value = Number(raw);
        } else {
          value = sourceNumber(attribute, 1, `Pad ${native}`);
        }
        if (
          !Number.isFinite(value) ||
          value < minimum ||
          value > maximum ||
          (key === 'zoneConnect' && !Number.isInteger(value))
        )
          fail(
            `Pad ${native} must be ${key === 'zoneConnect' ? 'an integer ' : ''}between ${minimum} and ${maximum}.`,
          );
        attributes[key] = value;
      }
      tuple(child(node, 'size'), 2, 2, 'Pad size');
      tuple(child(node, 'at'), 2, 3, 'Pad position');
      const minimumSize = customPad.customAnchor === 'circle' ? 0.000001 : 0.0001;
      const size = {
        x: sourcePositive(child(node, 'size'), 1, 'Pad width', minimumSize),
        y: sourcePositive(child(node, 'size'), 2, 'Pad height', minimumSize),
      };
      if (shape === 'circle' && size.x !== size.y)
        fail('Circular pads must have equal width and height.');
      const layerNode = child(node, 'layers');
      tuple(layerNode, 1, 3, 'Pad layers');
      const layers = layerNode!
        .slice(1)
        .map((_, i) => val(layerNode, i + 1))
        .sort();
      const roundMechanicalCopperMarker =
        type === 'np_thru_hole' &&
        layers.length === 2 &&
        layers.includes('*.Mask') &&
        (layers.includes('F&B.Cu') || layers.includes('*.Cu'));
      let retainedLayers = layers as NonNullable<Pad['layers']> | undefined;
      const padRole: Pick<Pad, 'type' | 'number' | 'layers'> = {
        type,
        number,
        layers: retainedLayers,
      };
      if (padHasElectricalPin(padRole) && number !== '' && !number.trim())
        fail('Footprint pad numbers cannot contain only whitespace.');
      if (type === 'smd') {
        const side = layers.includes('B.Cu') ? 'B' : 'F';
        if (
          !padApertureLayers(padRole) &&
          (!layers.includes(`${side}.Cu`) ||
            new Set(layers).size !== layers.length ||
            layers.some(
              (layer) => ![`${side}.Cu`, `${side}.Mask`, `${side}.Paste`].includes(layer),
            ))
        )
          fail('Custom pad layer sets are not supported.');
        if (side === 'F' && layers.length === 3) retainedLayers = undefined;
      } else if (type === 'thru_hole') {
        if (
          layers[0] !== '*.Cu' ||
          layers.slice(1).some((layer) => !['*.Mask', 'F.Mask', 'B.Mask'].includes(layer)) ||
          new Set(layers).size !== layers.length ||
          (layers.includes('*.Mask') && layers.length > 2)
        )
          fail('Custom pad layer sets are not supported.');
        if (layers.length === 2 && layers[1] === '*.Mask') retainedLayers = undefined;
      } else if (!(layers.length === 1 && layers[0] === '*.Mask') && !roundMechanicalCopperMarker) {
        fail('Custom pad layer sets are not supported.');
      }
      const remove = child(node, 'remove_unused_layers');
      if (remove && val(remove) !== 'no')
        fail('Pads that remove unused copper layers are not supported.');
      const drill = readPadDrill(child(node, 'drill'), fail);
      if (!!drill.drill !== (type !== 'smd')) fail('Pad drill does not match its type.');
      if (drill.drill !== undefined && drill.drill < 0.0001)
        fail('Pad drill must be at least 0.0001 mm.');
      const padShape = shape as Pad['shape'];
      validateCustomPad(
        { shape: padShape, type, size, ...customPad, drillOffset: drill.drillOffset },
        fail,
      );
      const drillClearance = () =>
        padDrillClearance({
          ...drill,
          size,
          shape: padShape,
          roundrectRatio,
          chamferRatio,
          chamfer,
          outline,
        });
      if (type === 'np_thru_hole') {
        const fits = drill.drillSlot
          ? !roundMechanicalCopperMarker && shape === 'oval' && drillClearance() >= -1e-12
          : shape === 'circle' && !drill.drillOffset && drill.drill === size.x;
        if (!fits) fail('A non-plated hole must fit its mask opening.');
      }
      const position = child(node, 'at');
      const rotation = angle(sourceNumber(position, 3, 'Pad rotation', true));
      const anchor = sourcePoint(position, 'Pad position');
      const land = drill.drillOffset
        ? footprintPoint(
            { ...anchor, rotation },
            { x: -drill.drillOffset.x, y: -drill.drillOffset.y },
          )
        : anchor;
      if (type === 'thru_hole' && drillClearance() <= 1e-12)
        fail('A through-hole drill must be smaller than and stay inside its copper pad.');
      pads.push({
        id: uid(),
        number,
        ...land,
        rotation,
        type,
        shape: padShape,
        ...(retainedLayers ? { layers: retainedLayers } : {}),
        ...(roundrectRatio === undefined ? {} : { roundrectRatio }),
        ...(chamfer ? { chamfer, chamferRatio } : {}),
        ...customPad,
        ...attributes,
        ...readPadHeatsink(node, fail),
        size,
        ...drill,
        netId: null,
      });
    } else if (['fp_line', 'fp_rect', 'fp_circle', 'fp_arc', 'fp_poly'].includes(kind)) {
      if (node.slice(1).some((item) => !Array.isArray(item)))
        fail('This footprint graphic contains an unsupported flag.');
      allowedChildren(
        node,
        [
          ...(kind === 'fp_poly'
            ? ['pts']
            : kind === 'fp_circle'
              ? ['center', 'end']
              : kind === 'fp_arc'
                ? ['start', 'mid', 'end']
                : ['start', 'end']),
          'stroke',
          'width',
          'layer',
          'fill',
          'uuid',
          'tstamp',
        ],
        'The footprint graphic',
      );
      tuple(child(node, 'layer'), 1, 1, 'Graphic layer');
      const layer = val(child(node, 'layer'));
      const pasteLayer = layer === 'F.Paste' || layer === 'B.Paste';
      const maskLayer = layer === 'F.Mask' || layer === 'B.Mask';
      const edgeLayer = layer === 'Edge.Cuts';
      if (!pasteLayer && !maskLayer && !edgeLayer && !graphicLayers.includes(layer))
        fail(`Footprint graphics on ${layer} are not supported.`);
      const fillNode = child(node, 'fill');
      if (fillNode) tuple(fillNode, 1, 1, 'Graphic fill');
      const fill = val(fillNode);
      if (fillNode && !['no', 'none', 'yes', 'solid'].includes(fill))
        fail(`Footprint fill ${fill} is not supported.`);
      const filled = fill === 'yes' || fill === 'solid';
      const filledRectangle = filled && kind === 'fp_rect';
      const polygon = kind === 'fp_poly' || filledRectangle;
      if (filled && kind !== 'fp_circle' && !polygon)
        fail('Only footprint circles, rectangles and polygons support filled graphics.');
      const stroke = child(node, 'stroke');
      const nativeWidth = child(node, 'width');
      if (
        nativeWidth &&
        (stroke || !['20210108', '20211014'].includes(val(child(root, 'version'))))
      )
        fail('A native width field requires a KiCad 6 library footprint without a stroke record.');
      if (!stroke && !nativeWidth) fail('The footprint graphic has no supported stroke.');
      if (stroke) {
        if (stroke.slice(1).some((item) => !Array.isArray(item)))
          fail('This footprint graphic contains an unsupported stroke flag.');
        allowedChildren(stroke, ['width', 'type'], 'The graphic stroke');
        tuple(child(stroke, 'type'), 1, 1, 'Graphic stroke type');
      }
      const strokeType = stroke ? val(child(stroke, 'type')) : 'solid';
      if (!['solid', 'default'].includes(strokeType))
        fail('Dashed footprint graphics are not supported.');
      const widthNode = nativeWidth ?? child(stroke!, 'width');
      tuple(widthNode, 1, 1, 'Graphic width');
      const width =
        kind === 'fp_line' || (kind === 'fp_rect' && !filledRectangle)
          ? sourcePositive(widthNode, 1, 'Graphic width')
          : sourceNumber(widthNode, 1, 'Graphic width');
      if (width < 0 || width > 1000) fail('Graphic width must be between 0 and 1000 mm.');
      if ((pasteLayer || maskLayer) && (!polygon || !filled || width !== 0))
        fail(
          'Footprint mask and paste graphics require filled polygons or rectangles without a stroke.',
        );
      if (edgeLayer && (filled || width <= 0))
        fail('Footprint board edges require an unfilled contour with a positive stroke.');
      const common = {
        id: uid(),
        width,
        layer: layer as BoardLine['layer'],
        stroke: strokeType as BoardLine['stroke'],
      };
      let points: Point[];
      if (kind === 'fp_poly') {
        const pts = child(node, 'pts');
        if (!pts || pts.slice(1).some((p) => !Array.isArray(p) || p[0] !== 'xy'))
          fail('Curved footprint polygons are not supported.');
        points = children(pts, 'xy').map((p) => {
          tuple(p, 2, 2, 'Polygon vertex');
          return sourcePoint(p, 'Polygon vertex');
        });
        if (points.length < 3 || points.length > 10000)
          fail('A footprint polygon needs between 3 and 10000 vertices.');
        graphics.push({
          ...common,
          kind: 'polygon',
          start: points[0],
          points: points.slice(1, -1),
          end: points[points.length - 1],
          fill: filled,
        });
      } else if (kind === 'fp_circle') {
        tuple(child(node, 'center'), 2, 2, 'Circle center');
        tuple(child(node, 'end'), 2, 2, 'Circle end');
        graphics.push({
          ...common,
          kind: 'circle',
          start: sourcePoint(child(node, 'center'), 'Circle center'),
          end: sourcePoint(child(node, 'end'), 'Circle end'),
          fill: filled,
        });
      } else if (kind === 'fp_arc') {
        tuple(child(node, 'start'), 2, 2, 'Arc start');
        tuple(child(node, 'mid'), 2, 2, 'Arc middle');
        tuple(child(node, 'end'), 2, 2, 'Arc end');
        graphics.push({
          ...common,
          kind: 'arc',
          start: sourcePoint(child(node, 'start'), 'Arc start'),
          mid: sourcePoint(child(node, 'mid'), 'Arc middle'),
          end: sourcePoint(child(node, 'end'), 'Arc end'),
        });
      } else {
        tuple(child(node, 'start'), 2, 2, 'Graphic start');
        tuple(child(node, 'end'), 2, 2, 'Graphic end');
        const start = sourcePoint(child(node, 'start'), 'Graphic start'),
          end = sourcePoint(child(node, 'end'), 'Graphic end');
        if (filledRectangle) {
          if (start.x === end.x || start.y === end.y)
            fail('A filled footprint rectangle needs a positive area.');
          graphics.push({
            ...common,
            kind: 'polygon',
            start,
            points: [{ x: end.x, y: start.y }, end],
            end: { x: start.x, y: end.y },
            fill: true,
          });
          if (graphics.length > 2000) fail('This footprint exceeds the supported geometry limit.');
          continue;
        }
        points =
          kind === 'fp_rect'
            ? [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start]
            : [start, end];
        for (let i = 1; i < points.length; i++)
          graphics.push({
            id: uid(),
            start: { ...points[i - 1] },
            end: { ...points[i] },
            width,
            layer: layer as BoardLine['layer'],
          });
      }
    } else
      fail(
        `Footprint feature ${kind} is not supported. Choose a footprint with supported artwork and rectangular, circular, oval or rounded rectangular pads.`,
      );
    if (pads.length > 2000 || graphics.length > 2000)
      fail('This footprint exceeds the supported geometry limit.');
  }
  if (!pads.length && !graphics.length) fail('The footprint has no supported physical geometry.');
  return {
    pads,
    graphics,
    ...margins,
    ...(children(root, 'model').length ? { models: footprintModels(root) } : {}),
  };
}

export function createPCBFootprint(
  detail: { id: string; footprint: SExpr },
  circuit: Circuit,
  symbolId: string,
  at: Point,
): Footprint {
  const symbol = circuit.parts.find((p) => p.id === symbolId);
  if (!symbol) fail('Choose a component in the primary schematic before placing a footprint.');
  const library = circuit.libraries[symbol.libId];
  if (!library) fail('The schematic component has no embedded symbol.');
  const geometry = readLibraryFootprint(detail);
  const electrical = geometry.pads.filter(padHasElectricalPin);
  if (!electrical.some((pad) => pad.number))
    fail('Choose a footprint with numbered electrical pads.');
  const pins = new Set(
    children(library, 'symbol')
      .flatMap((unit) => children(unit, 'pin'))
      .map((pin) => val(child(pin, 'number'))),
  );
  for (const pad of electrical) {
    if (!pad.number) pad.unconnected = true;
    else if (!pins.has(pad.number))
      fail(`${symbol.ref} has no pin ${pad.number} for this footprint pad.`);
  }
  for (const [property, layer, y] of [
    ['Reference', 'F.SilkS', -3],
    ['Value', 'F.Fab', 3],
  ] as const) {
    geometry.graphics.push({
      id: uid(),
      kind: 'text',
      layer,
      width: 0,
      start: { x: 0, y },
      end: { x: 0, y },
      text: {
        property,
        value: '${' + property.toUpperCase() + '}',
        rotation: 0,
        size: { x: 1, y: 1 },
        thickness: 0.15,
      },
    });
  }
  return {
    id: uid(),
    symbolId,
    libraryId: detail.id,
    ...point(at),
    rotation: 0,
    side: 'front',
    ...geometry,
  };
}

function selected(selection: Selection, kind: PCBSelection['kind'], id: string) {
  return (Array.isArray(selection) ? selection : [selection]).some(
    (s) => s.kind === kind && s.id === id,
  );
}

/** Footprint text has its own native identity. Other footprint artwork belongs to the body. */
export function findPCBGraphic(
  board: PCB,
  id: string,
): { graphic: BoardLine; owner?: Footprint } | undefined {
  const graphic = board.graphics.find((item) => item.id === id);
  if (graphic) return { graphic };
  for (const owner of board.footprints) {
    const graphic = owner.graphics.find((item) => item.kind === 'text' && item.id === id);
    if (graphic) return { graphic, owner };
  }
}

export function replacePCBGraphic(board: PCB, graphic: BoardLine): PCB {
  const existing = findPCBGraphic(board, graphic.id);
  if (!existing) fail('This board graphic no longer exists.');
  const { owner } = existing;
  if (!owner)
    return { ...board, graphics: board.graphics.map((g) => (g.id === graphic.id ? graphic : g)) };
  if (
    graphic.kind !== 'text' ||
    !graphic.text ||
    graphic.text.property !== existing.graphic.text?.property
  )
    fail('Preserve the footprint text type and field identity.');
  if (
    (graphic.text.property === 'Reference' || graphic.text.property === 'Value') &&
    graphic.text.value !== existing.graphic.text?.value
  )
    fail('Edit the footprint field content through its owning component.');
  return {
    ...board,
    footprints: board.footprints.map((f) =>
      f === owner
        ? { ...f, graphics: f.graphics.map((g) => (g.id === graphic.id ? graphic : g)) }
        : f,
    ),
  };
}

function mapSelectedFootprintText(
  owner: Footprint,
  selection: Selection,
  edit: (graphic: BoardLine) => BoardLine | undefined,
): Footprint {
  if (!owner.graphics.some((g) => g.kind === 'text' && selected(selection, 'graphic', g.id)))
    return owner;
  return {
    ...owner,
    graphics: owner.graphics.flatMap((g) => {
      const next = g.kind === 'text' && selected(selection, 'graphic', g.id) ? edit(g) : g;
      return next ? [next] : [];
    }),
  };
}

function footprintLocalPoint(owner: Footprint, at: Point): Point {
  return footprintPoint(
    { x: 0, y: 0, rotation: -owner.rotation },
    {
      x: at.x - owner.x,
      y: at.y - owner.y,
    },
  );
}

export function assertPCBSelectionUnlocked(board: PCB, selection: Selection) {
  if (
    board.graphics.some((graphic) => graphic.locked && selected(selection, 'graphic', graphic.id))
  )
    fail('Unlock selected graphics before editing.');
  if (
    board.footprints.some((f) =>
      f.graphics.some(
        (g) => g.kind === 'text' && (g.locked || f.locked) && selected(selection, 'graphic', g.id),
      ),
    )
  )
    fail('Unlock selected footprint text before editing.');
  if (
    board.footprints.some(
      (footprint) => footprint.locked && selected(selection, 'footprint', footprint.id),
    )
  )
    fail('Unlock selected footprints before editing.');
  if (board.tracks.some((track) => track.locked && selected(selection, 'track', track.id)))
    fail('Unlock selected tracks before editing.');
  if (board.vias.some((via) => via.locked && selected(selection, 'via', via.id)))
    fail('Unlock selected vias before editing.');
  if (board.zones.some((zone) => zone.locked && selected(selection, 'zone', zone.id)))
    fail('Unlock selected zones before editing.');
}

export function setPCBTrackProperties(
  board: PCB,
  trackId: string,
  changes: { netId?: string; layer?: CopperLayer; width?: number; locked?: boolean },
): PCB {
  const track = board.tracks.find((track) => track.id === trackId);
  if (!track) fail('The selected track is no longer on this board.');
  if (changes.netId !== undefined && !board.nets.some((net) => net.id === changes.netId))
    fail('Choose an existing track net.');
  if (changes.layer !== undefined && !board.layers.some((layer) => layer === changes.layer))
    fail('Choose an existing copper layer.');
  if (
    changes.width !== undefined &&
    (!Number.isFinite(changes.width) || changes.width <= 0 || changes.width > 1000)
  )
    fail('Track width must be greater than zero and at most 1000 mm.');
  const { locked } = changes;
  const next = { ...track };
  if (changes.netId !== undefined) next.netId = changes.netId;
  if (changes.layer !== undefined) next.layer = changes.layer;
  if (changes.width !== undefined) next.width = changes.width;
  if (locked === false) delete next.locked;
  else if (locked === true) next.locked = true;
  if (
    track.locked &&
    locked !== false &&
    (next.netId !== track.netId || next.layer !== track.layer || next.width !== track.width)
  )
    fail('Unlock the track before changing its properties.');
  if (JSON.stringify(next) === JSON.stringify(track)) return board;
  return { ...board, tracks: board.tracks.map((item) => (item.id === trackId ? next : item)) };
}

export function movePCBSelection(board: PCB, selection: Selection, delta: Point): PCB {
  const d = point(delta);
  if (!d.x && !d.y) return board;
  assertPCBSelectionUnlocked(board, selection);
  const move = (p: Point) => point({ x: p.x + d.x, y: p.y + d.y });
  return {
    ...board,
    footprints: board.footprints.map((f) =>
      selected(selection, 'footprint', f.id)
        ? { ...f, ...move(f) }
        : mapSelectedFootprintText(f, selection, (g) => {
            const local = footprintLocalPoint(f, { x: f.x + d.x, y: f.y + d.y });
            return transformPCBGraphic(g, (p) => point({ x: p.x + local.x, y: p.y + local.y }));
          }),
    ),
    vias: board.vias.map((v) => (selected(selection, 'via', v.id) ? { ...v, ...move(v) } : v)),
    tracks: board.tracks.map((t) =>
      selected(selection, 'track', t.id) ? { ...t, start: move(t.start), end: move(t.end) } : t,
    ),
    graphics: board.graphics.map((g) =>
      selected(selection, 'graphic', g.id) ? transformPCBGraphic(g, move) : g,
    ),
    zones: board.zones.map((z) =>
      selected(selection, 'zone', z.id) ? transformPCBZone(z, move) : z,
    ),
  };
}
/** A supplied pivot rotates the complete selection as one group in board coordinates. */
export function rotatePCBSelection(
  board: PCB,
  selection: Selection,
  degrees = 90,
  pivot?: Point,
): PCB {
  if (!Number.isFinite(degrees)) fail('Rotation must be finite.');
  const origin = pivot ? point(pivot) : undefined;
  if (!angle(degrees)) return board;
  assertPCBSelectionUnlocked(board, selection);
  const rotate = (p: Point, center: Point) =>
    point(
      footprintPoint(
        { ...center, rotation: degrees },
        {
          x: p.x - center.x,
          y: p.y - center.y,
        },
      ),
    );
  const line = <T extends { start: Point; end: Point }>(item: T): T => {
    const center = origin ?? {
      x: (item.start.x + item.end.x) / 2,
      y: (item.start.y + item.end.y) / 2,
    };
    return { ...item, start: rotate(item.start, center), end: rotate(item.end, center) };
  };
  return {
    ...board,
    footprints: board.footprints.map((f) =>
      selected(selection, 'footprint', f.id)
        ? { ...f, ...(origin ? rotate(f, origin) : {}), rotation: angle(f.rotation + degrees) }
        : mapSelectedFootprintText(f, selection, (g) =>
            transformPCBGraphic(
              g,
              (p) => (origin ? footprintLocalPoint(f, rotate(footprintPoint(f, p), origin)) : p),
              (n) => angle(n + degrees),
            ),
          ),
    ),
    vias: origin
      ? board.vias.map((v) =>
          selected(selection, 'via', v.id) ? { ...v, ...rotate(v, origin) } : v,
        )
      : board.vias,
    tracks: board.tracks.map((t) => (selected(selection, 'track', t.id) ? line(t) : t)),
    graphics: board.graphics.map((g) => {
      if (!selected(selection, 'graphic', g.id)) return g;
      const center = origin ?? {
        x: (g.start.x + g.end.x) / 2,
        y: (g.start.y + g.end.y) / 2,
      };
      return transformPCBGraphic(
        g,
        (p) => rotate(p, center),
        (n) => angle(n + degrees),
      );
    }),
    zones: board.zones.map((z) => {
      if (!selected(selection, 'zone', z.id)) return z;
      const center = origin ?? {
        x: z.outline.reduce((n, p) => n + p.x, 0) / z.outline.length,
        y: z.outline.reduce((n, p) => n + p.y, 0) / z.outline.length,
      };
      return transformPCBZone(z, (p) => rotate(p, center));
    }),
  };
}
/** Pickup flips reflect package origins across the anchor's horizontal axis. */
export function flipPCBSelection(board: PCB, selection: Selection, pivot?: Point): PCB {
  const origin = pivot ? point(pivot) : undefined;
  return {
    ...board,
    footprints: board.footprints.map((footprint) => {
      if (!selected(selection, 'footprint', footprint.id)) return footprint;
      const flipped = flipPCBFootprint(footprint);
      return origin ? { ...flipped, y: coordinate(2 * origin.y - footprint.y) } : flipped;
    }),
  };
}

type PCBMoveOperation = 'rotate' | 'rotateReverse' | 'flip';

/** Apply the same ordered pickup edits as the canvas, then place its exact pose. */
export function previewPCBMove(
  board: PCB,
  selection: readonly PCBSelection[],
  anchor: Point,
  target: Point,
  operations: readonly PCBMoveOperation[] = [],
): PCB {
  const origin = point(anchor),
    destination = point(target);
  let posed = board;
  for (const operation of operations)
    posed =
      operation === 'flip'
        ? flipPCBSelection(posed, selection, origin)
        : rotatePCBSelection(posed, selection, operation === 'rotate' ? 90 : -90, origin);
  return movePCBSelection(posed, selection, {
    x: destination.x - origin.x,
    y: destination.y - origin.y,
  });
}

export function deletePCBSelection(board: PCB, selection: Selection): PCB {
  assertPCBSelectionUnlocked(board, selection);
  return {
    ...board,
    footprints: board.footprints.flatMap((f) =>
      selected(selection, 'footprint', f.id)
        ? []
        : [
            mapSelectedFootprintText(f, selection, (g) =>
              g.text?.property ? { ...g, text: { ...g.text, hidden: true } } : undefined,
            ),
          ],
    ),
    tracks: board.tracks.filter((t) => !selected(selection, 'track', t.id)),
    vias: board.vias.filter((v) => !selected(selection, 'via', v.id)),
    graphics: board.graphics.filter((g) => !selected(selection, 'graphic', g.id)),
    zones: board.zones.filter((z) => !selected(selection, 'zone', z.id)),
  };
}

/** Keep precise pad endpoints; only pointer placement is snapped by the caller. */
export function routePoints(start: Point, end: Point, mode: 'straight' | '45' = '45'): Point[] {
  const a = point(start),
    b = point(end),
    dx = b.x - a.x,
    dy = b.y - a.y;
  if (!dx && !dy) return [a];
  if (mode === 'straight' || !dx || !dy || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.00005)
    return [a, b];
  const diagonal = Math.min(Math.abs(dx), Math.abs(dy));
  return [a, point({ x: a.x + Math.sign(dx) * diagonal, y: a.y + Math.sign(dy) * diagonal }), b];
}

/** Anchor a pointer hit to the finite track segment at canonical coordinate precision. */
export function projectPointToTrack(
  track: Pick<PCB['tracks'][number], 'start' | 'end'>,
  p: Point,
): Point {
  const dx = track.end.x - track.start.x,
    dy = track.end.y - track.start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(0, ((p.x - track.start.x) * dx + (p.y - track.start.y) * dy) / lengthSquared),
        );
  return point({ x: track.start.x + dx * t, y: track.start.y + dy * t });
}

/** Closest finite-track contacts, retaining canonical precision and endpoint tie order. */
export function closestTrackPoints(
  a: Pick<PCB['tracks'][number], 'start' | 'end'>,
  b: Pick<PCB['tracks'][number], 'start' | 'end'>,
): [Point, Point] {
  const ax = a.end.x - a.start.x,
    ay = a.end.y - a.start.y,
    bx = b.end.x - b.start.x,
    by = b.end.y - b.start.y,
    denominator = ax * by - ay * bx;
  if (Math.abs(denominator) > 1e-12) {
    const dx = b.start.x - a.start.x,
      dy = b.start.y - a.start.y,
      t = (dx * by - dy * bx) / denominator,
      u = (dx * ay - dy * ax) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const contact = { x: round(a.start.x + t * ax), y: round(a.start.y + t * ay) };
      return [contact, contact];
    }
  }
  return (
    [
      [a.start, projectPointToTrack(b, a.start)],
      [a.end, projectPointToTrack(b, a.end)],
      [projectPointToTrack(a, b.start), b.start],
      [projectPointToTrack(a, b.end), b.end],
    ] as [Point, Point][]
  ).sort((p, q) => squaredDistance(...p) - squaredDistance(...q))[0];
}

export function pcbBounds(board: PCB): PCBBounds {
  const points: Point[] = [];
  const add = (p: Point, radius = 0) =>
    points.push({ x: p.x - radius, y: p.y - radius }, { x: p.x + radius, y: p.y + radius });
  for (const f of board.footprints) {
    add(f);
    for (const p of f.pads) {
      const center = padPosition(f, p),
        radians = (-padRotation(f, p) * Math.PI) / 180;
      for (const { x, y } of padBoundPoints(p))
        add({
          x: center.x + x * Math.cos(radians) - y * Math.sin(radians),
          y: center.y + x * Math.sin(radians) + y * Math.cos(radians),
        });
    }
    for (const g of f.graphics) {
      for (const p of pcbGraphicPoints(g)) add(footprintPoint(f, p), g.width / 2);
    }
  }
  for (const item of board.tracks) {
    add(item.start, item.width / 2);
    add(item.end, item.width / 2);
  }
  for (const g of board.graphics) for (const p of pcbGraphicPoints(g)) add(p, g.width / 2);
  for (const v of board.vias) add(v, v.diameter / 2);
  for (const z of board.zones) for (const p of z.outline) add(p);
  if (!points.length) return { minX: 0, minY: 0, maxX: 80, maxY: 60 };
  return points.reduce(
    (b, p) => ({
      minX: Math.min(b.minX, p.x),
      minY: Math.min(b.minY, p.y),
      maxX: Math.max(b.maxX, p.x),
      maxY: Math.max(b.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}
