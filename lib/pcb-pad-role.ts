import type { Pad } from './pcb';
import { children, val, type SExpr } from './sexpr';
import { pcbCopperLayers, type CopperLayer } from './pcb-layer-stack';

type PadRoleFields = Pick<Pad, 'type' | 'number' | 'layers'>;
type ApertureLayer = 'F.Paste' | 'B.Paste' | 'F.Mask' | 'B.Mask';
const silkscreenPadLayers = ['F.SilkS', 'B.SilkS'] as const;

export function padSilkscreenLayers(pad: Pick<Pad, 'layers'>) {
  const layers = pad.layers;
  if (!layers) return [];
  if (layers.includes('*.SilkS')) return silkscreenPadLayers;
  return silkscreenPadLayers.filter((layer) => layers.includes(layer));
}

function isApertureLayer(layer: string): layer is ApertureLayer {
  return layer === 'F.Paste' || layer === 'B.Paste' || layer === 'F.Mask' || layer === 'B.Mask';
}

export function padApertureLayers(pad: PadRoleFields): readonly ApertureLayer[] | undefined {
  const { layers } = pad;
  if (pad.type !== 'smd' || pad.number !== '' || !layers?.length || layers.length > 2) return;
  if (!layers.every(isApertureLayer)) return;
  const [first, second] = layers;
  if (!second || (first !== second && first[0] === second[0])) return layers;
}

export function padHasElectricalPin(pad: PadRoleFields): boolean {
  return pad.type !== 'np_thru_hole' && !padApertureLayers(pad);
}

export function isDrillOnlyPlatedPad(pad: Pad): boolean {
  return (
    pad.type === 'thru_hole' &&
    pad.number === '' &&
    pad.netId === null &&
    pad.shape === 'circle' &&
    pad.drill !== undefined &&
    pad.drill === pad.size.x &&
    pad.drill === pad.size.y &&
    !pad.drillOffset &&
    !pad.drillSlot
  );
}

type PCBPadPruning = Pick<Pad, 'removeUnusedLayers' | 'keepEndLayers' | 'zoneLayerConnections'>;

export function readPCBPadPruning(record: SExpr, fail: (message: string) => never): PCBPadPruning {
  const flag = (key: string) => {
    const [node, duplicate] = children(record, key);
    if (!node) return;
    if (duplicate || node.length !== 2 || (node[1] !== 'yes' && node[1] !== 'no'))
      fail(`Invalid pad ${key} setting.`);
    return node[1] === 'yes';
  };
  const removeUnusedLayers = flag('remove_unused_layers');
  const keepEndLayers = flag('keep_end_layers');
  const [connectionRecord, duplicate] = children(record, 'zone_layer_connections');
  if (duplicate || connectionRecord?.slice(1).some((item) => typeof item !== 'string'))
    fail('Invalid pad zone_layer_connections.');
  const zoneLayerConnections = connectionRecord
    ?.slice(1)
    .map((_, i) => val(connectionRecord, i + 1) as CopperLayer);
  if (zoneLayerConnections?.some((layer) => !pcbCopperLayers.includes(layer)))
    fail('Pad zone layer connections require copper layers.');
  return {
    ...(removeUnusedLayers === undefined ? {} : { removeUnusedLayers }),
    ...(keepEndLayers === undefined ? {} : { keepEndLayers }),
    ...(zoneLayerConnections === undefined ? {} : { zoneLayerConnections }),
  };
}

export function validatePCBPadPruning(
  pad: PCBPadPruning & Pick<Pad, 'type' | 'layers'>,
  copperLayers: readonly CopperLayer[],
  fail: (message: string) => never,
): void {
  if (pad.removeUnusedLayers && pad.type !== 'thru_hole')
    fail('Unused copper layer removal requires a plated through-hole pad.');
  if (pad.keepEndLayers !== undefined || pad.zoneLayerConnections) {
    if (!pad.removeUnusedLayers)
      fail('Pad end-layer and zone connections require unused copper layer removal.');
    if (
      pad.zoneLayerConnections?.some(
        (layer) =>
          !copperLayers.includes(layer) ||
          (pad.layers && !pad.layers.includes('*.Cu') && !pad.layers.includes(layer)),
      )
    )
      fail('Pad zone layer connections must use active copper layers on the pad.');
  }
}

export function validatePCBNetTiePadGroups(
  groups: readonly string[],
  pads: readonly PadRoleFields[],
  fail: (message: string) => never,
): void {
  if (!groups.length || groups.length > 128) fail('Invalid number of footprint net-tie groups.');
  const eligible = new Set(pads.filter(padHasElectricalPin).map((pad) => pad.number));
  const assigned = new Set<string>();
  for (const group of groups) {
    const numbers = group.split(',').map((number) => number.trim());
    if (numbers.length < 2) fail('A footprint net-tie group requires two or more pad numbers.');
    for (const number of numbers) {
      if (!number || !eligible.has(number) || assigned.has(number))
        fail('Footprint net ties require distinct existing electrical pad numbers.');
      assigned.add(number);
    }
  }
}

export function readPCBNetTiePadGroups(
  footprint: SExpr,
  pads: readonly PadRoleFields[],
  fail: (message: string) => never,
): string[] | undefined {
  const [node, duplicate] = children(footprint, 'net_tie_pad_groups');
  if (!node) return;
  if (
    duplicate ||
    node.slice(1).some((group) => typeof group !== 'string' || !group.startsWith('"'))
  )
    fail('Invalid native footprint net-tie groups.');
  const groups = node.slice(1).map((_, index) => val(node, index + 1));
  validatePCBNetTiePadGroups(groups, pads, fail);
  return groups;
}

export function validatePCBJumperPadGroups(
  groups: string[][],
  pads: readonly PadRoleFields[],
  fail: (message: string) => never,
) {
  const numbers = new Set(pads.filter(padHasElectricalPin).map((pad) => pad.number));
  const claimed = new Set<string>();
  if (!groups.length || groups.length > 128) return fail('Invalid native footprint jumper groups.');
  for (const group of groups) {
    if (group.length < 2 || group.length > 128)
      return fail('Invalid native footprint jumper group.');
    for (const number of group) {
      if (!numbers.has(number) || claimed.has(number))
        return fail('Footprint jumper groups require distinct existing electrical pad numbers.');
      claimed.add(number);
    }
  }
}

export function readPCBPadFabricationProperty(
  node: SExpr,
  fail: (message: string) => never,
): Pick<Pad, 'heatsink' | 'fabricationProperty'> {
  const properties = children(node, 'property');
  if (!properties.length) return {};
  const [property] = properties;
  const kind = property[1];
  if (properties.length !== 1 || property.length !== 2)
    fail('Unsupported pad fabrication property.');
  if (kind === 'pad_prop_heatsink') return { heatsink: true };
  if (
    kind === 'pad_prop_bga' ||
    kind === 'pad_prop_mechanical' ||
    kind === 'pad_prop_pressfit' ||
    kind === 'pad_prop_fiducial_glob' ||
    kind === 'pad_prop_fiducial_loc' ||
    kind === 'pad_prop_castellated' ||
    kind === 'pad_prop_testpoint'
  )
    return { fabricationProperty: kind };
  return fail('Unsupported pad fabrication property.');
}
