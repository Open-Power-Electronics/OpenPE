export const gridSpacingOptions = [0.5, 1, 2, 5, 10] as const;
export type GridSpacing = (typeof gridSpacingOptions)[number];

export const schematicLayerOptions = [
  { id: 'symbols', label: 'Symbols', color: '--symbol' },
  { id: 'references', label: 'References', color: '--schematic-reference' },
  { id: 'values', label: 'Values', color: '--schematic-value' },
  { id: 'fields', label: 'Other fields', color: '--schematic-field' },
  { id: 'pinNames', label: 'Pin names', color: '--schematic-pin-name' },
  { id: 'pinNumbers', label: 'Pin numbers', color: '--schematic-pin-number' },
  { id: 'wires', label: 'Wires and junctions', color: '--wire' },
  { id: 'labels', label: 'Net labels', color: '--schematic-net-label' },
  { id: 'notes', label: 'Notes', color: '--schematic-note' },
  { id: 'noConnects', label: 'No-connect markers', color: '--symbol' },
  { id: 'grid', label: 'Grid', color: '--grid-dot' },
] as const;
export type SchematicLayer = (typeof schematicLayerOptions)[number]['id'];
export type SchematicLayers = Record<SchematicLayer, boolean>;
export const defaultSchematicLayers = Object.fromEntries(
  schematicLayerOptions.map(({ id }) => [id, id !== 'fields']),
) as SchematicLayers;

export const schematicTextColors = {
  light: {
    '--wire': '#007106',
    '--schematic-reference': '#1d4ed8',
    '--schematic-value': '#7e22ce',
    '--schematic-field': '#576579',
    '--schematic-pin-name': '#1d4ed8',
    '--schematic-pin-number': '#1d4ed8',
    '--schematic-net-label': '#007106',
    '--schematic-global-label': '#007106',
    '--schematic-note': '#576579',
    '--schematic-guide': '#576579',
  },
  dark: {
    '--wire': '#98d5a6',
    '--schematic-reference': '#93b4ff',
    '--schematic-value': '#d0a3ff',
    '--schematic-field': '#adb9cc',
    '--schematic-pin-name': '#93b4ff',
    '--schematic-pin-number': '#93b4ff',
    '--schematic-net-label': '#98d5a6',
    '--schematic-global-label': '#98d5a6',
    '--schematic-note': '#adb9cc',
    '--schematic-guide': '#adb9cc',
  },
} as const;

export function validateSchematicLayers(value: unknown): SchematicLayers {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid schematic layers');
  const entries = Object.entries(value);
  if (
    entries.length !== Object.keys(defaultSchematicLayers).length ||
    entries.some(
      ([key, enabled]) =>
        !Object.hasOwn(defaultSchematicLayers, key) || typeof enabled !== 'boolean',
    )
  )
    throw new Error('Invalid schematic layer visibility');
  return { ...value } as SchematicLayers;
}
