import type { Point } from './circuit';
import type { BoardLayer, Pad, PCB } from './pcb';
import { pcbCopperLayers, type CopperLayer } from './pcb-layer-stack';
import { pcbViaBackdrillDiameterOnLayer, pcbViaCopperLayers } from './pcb-native-via';
import { maxPCBPadstackSize, pcbPadstackShapes } from './pcb-padstack-format';
import { child, children, quote, val, type SExpr } from './sexpr';

type PCBPadstackShape = {
  shape: (typeof pcbPadstackShapes)[number];
  size: Point;
  zoneConnect?: number;
  offset?: Point;
};
type LayerStack<T> = { inner: T; back: T };
export type PCBPadstack =
  | LayerStack<PCBPadstackShape>
  | {
      mode: 'custom';
      layers: (PCBPadstackShape & { layer: CopperLayer })[];
    };
export type PCBViaPadstack = LayerStack<number>;

function readLayerStack<T>(
  records: SExpr[],
  readLayer: (layer: SExpr) => T,
  fail: (message: string) => never,
): LayerStack<T> | undefined {
  const [record] = records;
  if (!record) return;
  const modes = children(record, 'mode');
  const layers = children(record, 'layer');
  const inner = layers.find((layer) => val(layer) === 'Inner');
  const back = layers.find((layer) => val(layer) === 'B.Cu');
  if (
    records.length !== 1 ||
    record.length !== 4 ||
    modes.length !== 1 ||
    modes[0].length !== 2 ||
    modes[0][1] !== 'front_inner_back' ||
    layers.length !== 2 ||
    !inner ||
    !back
  )
    return fail(
      'Only native front_inner_back padstacks with Inner and B.Cu records are supported.',
    );
  return { inner: readLayer(inner), back: readLayer(back) };
}

function readNumericAtoms(node: SExpr, count: number, fail: (message: string) => never) {
  const atoms = node.slice(1);
  if (
    atoms.length !== count ||
    atoms.some((atom) => typeof atom !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(atom))
  )
    return fail(`Invalid native padstack ${node[0]} number.`);
  const numbers = atoms.map(Number);
  if (numbers.some((number) => !Number.isFinite(number) || Math.abs(number) > maxPCBPadstackSize))
    return fail(`Invalid native padstack ${node[0]} number.`);
  return numbers;
}

export function readPCBPadstack(
  node: SExpr,
  fail: (message: string) => never,
): PCBPadstack | undefined {
  const readShape = (layer: SExpr): PCBPadstackShape => {
    const shapes = children(layer, 'shape');
    const sizes = children(layer, 'size');
    const zones = children(layer, 'zone_connect');
    const offsets = children(layer, 'offset');
    const shape = pcbPadstackShapes.find((option) => option === shapes[0]?.[1]);
    if (
      layer.length !== 4 + zones.length + offsets.length ||
      shapes.length !== 1 ||
      shapes[0].length !== 2 ||
      !shape ||
      sizes.length !== 1 ||
      zones.length > 1 ||
      offsets.length > 1
    )
      return fail('Unsupported through-pad layer shape in native padstack.');
    const [x, y] = readNumericAtoms(sizes[0], 2, fail);
    if (x < 0.000001 || y < 0.000001 || (shape === 'circle' && x !== y))
      return fail('Invalid native padstack layer size.');
    const zoneConnect = zones.length ? readNumericAtoms(zones[0], 1, fail)[0] : undefined;
    if (
      zoneConnect !== undefined &&
      (!Number.isInteger(zoneConnect) || zoneConnect < -1 || zoneConnect > 3)
    )
      return fail('Invalid native padstack zone connection.');
    const offset = offsets[0] ? readNumericAtoms(offsets[0], 2, fail) : undefined;
    return {
      shape,
      size: { x, y },
      ...(zoneConnect !== undefined ? { zoneConnect } : {}),
      ...(offset ? { offset: { x: offset[0], y: offset[1] } } : {}),
    };
  };
  const records = children(node, 'padstack');
  const [record, duplicate] = records;
  const mode = record && child(record, 'mode');
  if (mode?.[1] !== 'custom') return readLayerStack(records, readShape, fail);
  const layers = children(record, 'layer');
  if (
    duplicate ||
    mode.length !== 2 ||
    record.length !== layers.length + 2 ||
    !layers.length ||
    layers.length > 32
  )
    return fail('Invalid native custom padstack.');
  const seen = new Set<CopperLayer>();
  return {
    mode: 'custom',
    layers: layers.map((item) => {
      const layer = pcbCopperLayers.find((name) => name === val(item));
      if (!layer || seen.has(layer))
        return fail('Native custom padstack needs unique copper layer records.');
      seen.add(layer);
      return { layer, ...readShape(item) };
    }),
  };
}

export function readPCBViaPadstack(
  node: SExpr,
  fail: (message: string) => never,
): PCBViaPadstack | undefined {
  return readLayerStack(
    children(node, 'padstack'),
    (layer) => {
      const [size] = children(layer, 'size');
      if (layer.length !== 3 || !size)
        return fail('Unsupported via layer shape in native padstack.');
      const [diameter] = readNumericAtoms(size, 1, fail);
      if (diameter < 0) return fail('Invalid native via padstack diameter.');
      return diameter;
    },
    fail,
  );
}

export function validatePCBPadstack(
  pad: Pad,
  boardLayers: PCB['layers'],
  fail: (message: string) => never,
) {
  const stack = pad.padstack;
  if (!stack) return;
  const custom = 'mode' in stack;
  if (
    custom
      ? !stack.layers || 'inner' in stack || 'back' in stack
      : !stack.inner || !stack.back || 'layers' in stack
  )
    fail('Invalid native padstack layer records.');
  const shapes = custom ? stack.layers : [stack.inner, stack.back];
  if (
    pad.type !== 'thru_hole' ||
    pad.shape === 'custom' ||
    shapes.some(({ shape, size }) => shape === 'circle' && size.x !== size.y)
  )
    fail('Native padstacks require regular plated pad geometry with supported layer shapes.');
  if (
    custom &&
    (new Set(stack.layers.map(({ layer }) => layer)).size !== stack.layers.length ||
      stack.layers.some(({ layer }) => !boardLayers.includes(layer)))
  )
    fail('Native custom padstack layers must be unique board copper layers.');
}

const format = (n: number) => String(Number(n.toFixed(12)));
function writeLayerStack<T>(data: LayerStack<T>, writeLayer: (value: T) => string) {
  return `(padstack (mode front_inner_back) (layer ${quote('Inner')} ${writeLayer(data.inner)}) (layer ${quote('B.Cu')} ${writeLayer(data.back)}))`;
}
export function writePCBPadstack(stack: PCBPadstack) {
  const writeShape = ({ shape, size, zoneConnect, offset }: PCBPadstackShape) =>
    `(shape ${shape}) (size ${format(size.x)} ${format(size.y)})${offset ? ` (offset ${format(offset.x)} ${format(offset.y)})` : ''}${zoneConnect === undefined ? '' : ` (zone_connect ${zoneConnect})`}`;
  return 'mode' in stack
    ? `(padstack (mode custom) ${stack.layers.map((geometry) => `(layer ${quote(geometry.layer)} ${writeShape(geometry)})`).join(' ')})`
    : writeLayerStack(stack, writeShape);
}
export function writePCBViaPadstack(stack: PCBViaPadstack) {
  return writeLayerStack(stack, (size) => `(size ${format(size)})`);
}

function stackLayer(layer: BoardLayer) {
  return layer.startsWith('In') && layer.endsWith('.Cu')
    ? 'inner'
    : layer.startsWith('B.')
      ? 'back'
      : undefined;
}

function pcbPadStackShapeOnLayer(pad: Pad, layer: BoardLayer): PCBPadstackShape | undefined {
  if (!pad.padstack) return;
  const key = stackLayer(layer);
  const copperLayer = layer.endsWith('.Cu')
    ? layer
    : layer.startsWith('B.')
      ? 'B.Cu'
      : layer.startsWith('F.')
        ? 'F.Cu'
        : undefined;
  return 'mode' in pad.padstack
    ? (pad.padstack.layers.find(({ layer }) => layer === copperLayer) ??
        pad.padstack.layers.find(({ layer }) => layer === 'F.Cu'))
    : key && pad.padstack[key];
}

function pcbPadWithStackShape(pad: Pad, geometry: PCBPadstackShape): Pad {
  const x = geometry.offset?.x ?? 0;
  const y = geometry.offset?.y ?? 0;
  const dx = x + (pad.drillOffset?.x ?? 0);
  const dy = y + (pad.drillOffset?.y ?? 0);
  const angle = (-pad.rotation * Math.PI) / 180;
  return {
    ...pad,
    shape: geometry.shape,
    size: geometry.size,
    ...(geometry.zoneConnect === undefined ? {} : { zoneConnect: geometry.zoneConnect }),
    x: pad.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: pad.y + dx * Math.sin(angle) + dy * Math.cos(angle),
    drillOffset: geometry.offset ? { x: -x, y: -y } : undefined,
    padstack: undefined,
    roundrectRatio: undefined,
    trapezoidDelta: undefined,
    chamferRatio: undefined,
    chamfer: undefined,
  };
}

export function pcbPadOnLayer(pad: Pad, layer?: BoardLayer): Pad {
  const geometry = layer && pcbPadStackShapeOnLayer(pad, layer);
  return geometry ? pcbPadWithStackShape(pad, geometry) : pad;
}

export function pcbPadCopperSections(pad: Pad, layers: BoardLayer[]) {
  if (!pad.padstack) return [{ pad, layers }];
  const sections = new Map<PCBPadstackShape | undefined, { pad: Pad; layers: BoardLayer[] }>();
  for (const layer of layers) {
    const geometry = pcbPadStackShapeOnLayer(pad, layer);
    const section = sections.get(geometry);
    if (section) section.layers.push(layer);
    else
      sections.set(geometry, {
        pad: geometry ? pcbPadWithStackShape(pad, geometry) : pad,
        layers: [layer],
      });
  }
  return [...sections.values()];
}

export function pcbViaDiameter(via: PCB['vias'][number], layer?: BoardLayer) {
  if (layer) {
    const endpoint = layer === (via.span?.start ?? 'F.Cu') || layer === (via.span?.end ?? 'B.Cu');
    if (via.startEndOnly && !endpoint) return 0;
    if (
      via.removeUnusedLayers &&
      !(via.keepEndLayers && endpoint) &&
      !via.zoneLayerConnections?.some((item) => item === layer)
    )
      return 0;
  }
  return pcbViaLandDiameter(via, layer);
}

function pcbViaLandDiameter(via: PCB['vias'][number], layer?: BoardLayer) {
  const key = layer && stackLayer(layer);
  return (key ? via.padstack?.[key] : undefined) ?? via.diameter;
}

/** Copper artwork and the mechanical cut are independent on every native layer. */
export function pcbViaLayerSections(
  layers: readonly CopperLayer[],
  via: PCB['vias'][number],
  flashed?: ReadonlySet<CopperLayer>,
) {
  return pcbViaCopperLayers(layers, via).map((layer) => {
    const cutter = pcbViaBackdrillDiameterOnLayer(via, layer);
    return {
      layer,
      diameter: flashed
        ? flashed.has(layer)
          ? pcbViaLandDiameter(via, layer)
          : 0
        : pcbViaDiameter(via, layer),
      drill: Math.max(via.drill, cutter),
      plated: cutter <= via.drill,
    };
  });
}
