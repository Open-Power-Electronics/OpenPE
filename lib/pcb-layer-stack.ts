const innerLayerIndices = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30,
] as const;
type InnerCopperLayer = `In${(typeof innerLayerIndices)[number]}.Cu`;
export type CopperLayer = 'F.Cu' | InnerCopperLayer | 'B.Cu';

export const pcbCopperLayers = [
  'F.Cu',
  ...innerLayerIndices.map((index): InnerCopperLayer => `In${index}.Cu`),
  'B.Cu',
] as const;

const userLayerIndices = [
  ...innerLayerIndices,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
] as const;
type PCBUserLayer = `User.${(typeof userLayerIndices)[number]}`;
export const pcbUserLayers = userLayerIndices.map((index): PCBUserLayer => `User.${index}`);

export const pcbBoardLayers = [
  ...pcbCopperLayers,
  'F.SilkS',
  'B.SilkS',
  'F.Fab',
  'B.Fab',
  'F.CrtYd',
  'B.CrtYd',
  'Edge.Cuts',
  'F.Mask',
  'B.Mask',
  'F.Paste',
  'B.Paste',
  'F.Adhes',
  'B.Adhes',
  'Dwgs.User',
  'Cmts.User',
  'Eco1.User',
  'Eco2.User',
  'Margin',
  ...pcbUserLayers,
] as const;
export type BoardLayer = (typeof pcbBoardLayers)[number];

/** Physical front-to-back stacks in the native file order. */
export const pcbCopperStacks = Array.from(
  { length: pcbCopperLayers.length / 2 },
  (_, index): readonly CopperLayer[] => [
    'F.Cu',
    ...pcbCopperLayers.slice(1, index * 2 + 1),
    'B.Cu',
  ],
);

export function isPCBCopperStack(value: unknown): value is CopperLayer[] {
  if (!Array.isArray(value) || value.length % 2 !== 0) return false;
  const expected = pcbCopperStacks[value.length / 2 - 1];
  return expected !== undefined && expected.every((layer, index) => value[index] === layer);
}

/** KiCad 10 uses even numeric IDs for the complete copper domain. */
export function pcbNativeCopperLayerId(layer: CopperLayer): number {
  if (layer === 'F.Cu') return 0;
  if (layer === 'B.Cu') return 2;
  return 2 + 2 * pcbCopperLayers.indexOf(layer);
}
