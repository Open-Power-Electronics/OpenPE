export const pcbTeardropDimensionFields = {
  bestLengthRatio: 'best_length_ratio',
  maxLength: 'max_length',
  bestWidthRatio: 'best_width_ratio',
  maxWidth: 'max_width',
  filterRatio: 'filter_ratio',
} as const;

export const pcbTeardropOptionFields = {
  curvedEdges: 'curved_edges',
  enabled: 'enabled',
  allowTwoSegments: 'allow_two_segments',
  preferZoneConnections: 'prefer_zone_connections',
} as const;

export const maxPCBTeardropParameter = 1000;
// KiCad's ZONE_SETTINGS defaults in zones.h, in millimetres. KiCad 10 omits
// both records when writing generated teardrop zones.
export const defaultPCBTeardropThermal = 0.5;
