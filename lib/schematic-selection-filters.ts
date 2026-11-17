import type { Circuit } from './circuit';
import { selectedField } from './schematic-edit';
import type { SchematicLayers } from './schematic-layers';
import { visibleSchematicIds } from './schematic-view';
import type { SchematicSectionView } from './schematic-section';

export const schematicSelectionFilterOptions = [
  { id: 'symbols', label: 'Symbols' },
  { id: 'wires', label: 'Wires' },
  { id: 'labels', label: 'Labels' },
  { id: 'text', label: 'Text' },
  { id: 'noConnects', label: 'No-connects' },
] as const;
export type SchematicSelectionFilter = (typeof schematicSelectionFilterOptions)[number]['id'];
export type SchematicSelectionFilters = Record<SchematicSelectionFilter, boolean>;
export const defaultSchematicSelectionFilters: SchematicSelectionFilters = {
  symbols: true,
  wires: true,
  labels: true,
  text: true,
  noConnects: true,
};

/** Selection eligibility is local view state, independent of drawing and wire targets. */
export function selectableSchematicIds(
  doc: Circuit,
  layers: SchematicLayers,
  filters: SchematicSelectionFilters = defaultSchematicSelectionFilters,
  sectionView: SchematicSectionView = 'all',
): Set<string> {
  const visible = visibleSchematicIds(doc, layers, sectionView);
  if (schematicSelectionFilterOptions.every(({ id }) => filters[id])) return visible;
  const parts = new Set(doc.parts.map((part) => part.id));
  const wires = new Set([...doc.wires, ...doc.junctions].map((item) => item.id));
  const labels = new Set(doc.labels.map((label) => label.id));
  const noConnects = new Set((doc.noConnects || []).map((marker) => marker.id));
  return new Set(
    [...visible].filter((id) => {
      if (selectedField(id)) return filters.text;
      if (parts.has(id)) return filters.symbols;
      if (wires.has(id)) return filters.wires;
      if (labels.has(id)) return filters.labels;
      if (noConnects.has(id)) return filters.noConnects;
      return filters.text;
    }),
  );
}
