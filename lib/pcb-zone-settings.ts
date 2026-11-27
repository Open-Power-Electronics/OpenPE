import type { BoardZone, Footprint, Pad, PCB } from './pcb';

export type PCBZoneOverrides = {
  copperClearance?: number;
  thermalGap?: number;
  thermalBridge?: number;
  zoneConnect?: number;
};

export const pcbFootprintZoneOverrideFields = [
  ['clearance', 'copperClearance'],
  ['zone_connect', 'zoneConnect'],
] as const;
export const pcbPadZoneOverrideFields = [
  ...pcbFootprintZoneOverrideFields,
  ['thermal_gap', 'thermalGap'],
  ['thermal_bridge_width', 'thermalBridge'],
] as const;

export const defaultPCBIslandAreaMin = 10;
export const maxPCBZonePriority = 2147483647;
export const pcbPlacementSourceKinds = ['sheetname', 'component_class', 'group'] as const;
export type PCBPlacementArea = {
  sourceKind: (typeof pcbPlacementSourceKinds)[number];
  sourceName: string;
};

export const pcbZoneLayerActive = (board: Pick<PCB, 'layers'>, layer: BoardZone['layer']) =>
  !layer.endsWith('.Cu') || board.layers.some((copper) => copper === layer);

export const pcbZoneHatchNumericFields = [
  ['hatch_thickness', 'thickness'],
  ['hatch_gap', 'gap'],
  ['hatch_orientation', 'orientation'],
  ['hatch_min_hole_area', 'minHoleArea'],
  ['hatch_smoothing_level', 'smoothingLevel'],
  ['hatch_smoothing_value', 'smoothingValue'],
] as const;
export const pcbZoneHatchBorderAlgorithms = ['hatch_thickness', 'min_thickness'] as const;
export type PCBZoneHatchFill = {
  thickness: number;
  gap: number;
  orientation: number;
  minHoleArea: number;
  borderAlgorithm: (typeof pcbZoneHatchBorderAlgorithms)[number];
  smoothingLevel?: number;
  smoothingValue?: number;
};

export const pcbPadCopperClearance = (footprint: Footprint, pad: Pad) =>
  pad.copperClearance ?? footprint.copperClearance;

export function pcbPadZoneConnection(footprint: Footprint, pad: Pad, zone: BoardZone) {
  const override = pad.zoneConnect ?? -1;
  const connection = override === -1 ? (footprint.zoneConnect ?? -1) : override;
  if (connection === 0) return 'none';
  if (connection === 1) return 'thermal';
  if (connection === 2) return 'solid';
  if (connection === 3 || zone.padConnection === 'thru_hole_only')
    return pad.type === 'thru_hole' ? 'thermal' : 'solid';
  if (zone.padConnection === 'no') return 'none';
  return zone.padConnection === 'yes' ? 'solid' : 'thermal';
}
