'use client';

import {
  schematicSelectionFilterOptions,
  type SchematicSelectionFilter,
  type SchematicSelectionFilters as Filters,
} from '@/lib/schematic-selection-filters';

export default function SchematicSelectionFilters({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  const all = schematicSelectionFilterOptions.every(({ id }) => filters[id]);
  const any = schematicSelectionFilterOptions.some(({ id }) => filters[id]);
  function selectCategories(selected: boolean | SchematicSelectionFilter) {
    onChange(
      Object.fromEntries(
        schematicSelectionFilterOptions.map(({ id }) => [
          id,
          typeof selected === 'boolean' ? selected : selected === id,
        ]),
      ) as Filters,
    );
  }
  return (
    <div className="editor-filter-grid schematic-filter-grid">
      <label>
        <input
          type="checkbox"
          aria-label="All"
          checked={all}
          ref={(input) => {
            if (input) input.indeterminate = any && !all;
          }}
          onChange={(event) => selectCategories(event.target.checked)}
        />
        <span>All</span>
      </label>
      {schematicSelectionFilterOptions.map(({ id, label }) => (
        <label
          key={id}
          aria-description={`Right-click to select only ${label.toLowerCase()}`}
          onContextMenu={(event) => {
            event.preventDefault();
            selectCategories(id);
          }}
        >
          <input
            type="checkbox"
            aria-label={label}
            checked={filters[id]}
            onChange={(event) => onChange({ ...filters, [id]: event.target.checked })}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}
