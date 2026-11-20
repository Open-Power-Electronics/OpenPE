import type { Pad } from './pcb';
import { children, type SExpr } from './sexpr';

type PadRoleFields = Pick<Pad, 'type' | 'number' | 'layers'>;
type ApertureLayer = 'F.Paste' | 'B.Paste' | 'F.Mask' | 'B.Mask';

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

export function readPadHeatsink(
  node: SExpr,
  fail: (message: string) => never,
): Pick<Pad, 'heatsink'> {
  const properties = children(node, 'property');
  if (!properties.length) return {};
  const [property] = properties;
  if (properties.length !== 1 || property.length !== 2 || property[1] !== 'pad_prop_heatsink')
    fail('Unsupported pad fabrication property.');
  return { heatsink: true };
}
