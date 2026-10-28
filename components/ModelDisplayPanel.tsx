'use client';

import {
  Box,
  Eye,
  EyeOff,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Square,
  SquareDashed,
} from 'lucide-react';
import { useId, useState } from 'react';
import type { ModelCadSelectionFilters } from '@/lib/model-cad-selection';
import EditorDisplayDrawer from './EditorDisplayDrawer';

const filterCategories = [
  ['bodies', 'Solids'],
  ['faces', 'Faces'],
  ['edges', 'Edges'],
  ['lines', 'Lines'],
] as const;
const visualizationTabs = ['Views', 'Display'] as const;
const modelViews = [
  { view: 'top', label: 'Top view', Icon: PanelTop },
  { view: 'bottom', label: 'Bottom view', Icon: PanelBottom },
  { view: 'front', label: 'Front view', Icon: Square },
  { view: 'back', label: 'Back view', Icon: SquareDashed },
  { view: 'left', label: 'Left view', Icon: PanelLeft },
  { view: 'right', label: 'Right view', Icon: PanelRight },
  { view: 'isometric', label: 'Isometric view', Icon: Box },
] as const;
export type ModelView = (typeof modelViews)[number]['view'];

export default function ModelDisplayPanel({
  ready,
  orthographic,
  onOrthographicChange,
  cadVisible,
  modelsVisible,
  silkscreenVisible,
  onCadVisibleChange,
  onModelsVisibleChange,
  onSilkscreenVisibleChange,
  selectionDisabled = false,
  filters,
  onFiltersChange,
  onView,
}: {
  ready: boolean;
  orthographic: boolean;
  onOrthographicChange: (value: boolean) => void;
  cadVisible: boolean;
  modelsVisible: boolean;
  silkscreenVisible: boolean;
  onCadVisibleChange: (visible: boolean) => void;
  onModelsVisibleChange: (visible: boolean) => void;
  onSilkscreenVisibleChange: (visible: boolean) => void;
  selectionDisabled?: boolean;
  filters: ModelCadSelectionFilters;
  onFiltersChange: (filters: ModelCadSelectionFilters) => void;
  onView: (view: ModelView) => void;
}) {
  const id = useId();
  const [tab, setTab] = useState<(typeof visualizationTabs)[number]>('Views');
  const allItemsChecked = filterCategories.every(([key]) => filters[key]);
  const someItemsChecked = filterCategories.some(([key]) => filters[key]);
  const visibilityRows = [
    {
      label: 'CAD solids',
      ariaLabel: 'Show CAD solids',
      checked: cadVisible,
      onChange: onCadVisibleChange,
      color: 'var(--muted)',
    },
    {
      label: 'Component models',
      ariaLabel: 'Show component models',
      checked: modelsVisible,
      onChange: onModelsVisibleChange,
      color: 'var(--text-strong)',
    },
    {
      label: 'Silkscreen',
      ariaLabel: 'Show silkscreen',
      checked: silkscreenVisible,
      onChange: onSilkscreenVisibleChange,
      color: 'var(--soft)',
    },
  ];

  return (
    <div className="editor-display-drawers model-display-panel">
      <EditorDisplayDrawer
        label="Visualization"
        className="editor-visualization-drawer"
        defaultOpen
      >
        <>
          <div
            className="layout-appearance-tabs model-visualization-tabs"
            role="tablist"
            aria-label="Model visualization"
          >
            {visualizationTabs.map((name, index) => (
              <button
                key={name}
                type="button"
                role="tab"
                id={`${id}-${name}-tab`}
                aria-selected={tab === name}
                aria-controls={`${id}-panel`}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % visualizationTabs.length;
                  else if (event.key === 'ArrowLeft')
                    next = (index + visualizationTabs.length - 1) % visualizationTabs.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = visualizationTabs.length - 1;
                  else return;
                  event.preventDefault();
                  setTab(visualizationTabs[next]);
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <div
            className="model-visualization-content"
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-${tab}-tab`}
          >
            {tab === 'Views' && (
              <>
                <div className="model-view-controls">
                  {modelViews.map(({ view, label, Icon }) => (
                    <button
                      key={view}
                      type="button"
                      className="editor-visibility-name"
                      data-model-view={view}
                      disabled={!ready}
                      onClick={() => onView(view)}
                    >
                      <Icon size={14} aria-hidden />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <div className="model-projection-controls" role="group" aria-label="Projection">
                  <button
                    type="button"
                    className="editor-visibility-name"
                    aria-label="Orthographic projection"
                    aria-pressed={orthographic}
                    disabled={!ready}
                    onClick={() => onOrthographicChange(!orthographic)}
                  >
                    <Box size={14} aria-hidden />
                    <span>Orthographic projection</span>
                  </button>
                </div>
              </>
            )}
            {tab === 'Display' && (
              <div className="model-visibility-list">
                {visibilityRows.map(({ label, ariaLabel, checked, color, onChange }) => (
                  <label className="editor-visibility-row" key={ariaLabel}>
                    <span className="editor-visibility-name">
                      <span
                        className="editor-visibility-swatch"
                        style={{ background: color }}
                        aria-hidden
                      />
                      <span>{label}</span>
                    </span>
                    <span
                      className="editor-visibility-toggle"
                      aria-description={`${checked ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
                    >
                      {checked ? <Eye size={15} aria-hidden /> : <EyeOff size={15} aria-hidden />}
                      <input
                        type="checkbox"
                        aria-label={ariaLabel}
                        checked={checked}
                        onChange={(event) => onChange(event.target.checked)}
                      />
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      </EditorDisplayDrawer>
      <EditorDisplayDrawer label="Selection" className="editor-filters-drawer" defaultOpen>
        <div className="editor-filter-grid">
          <label>
            <input
              type="checkbox"
              aria-label="All items"
              disabled={selectionDisabled}
              checked={allItemsChecked}
              ref={(input) => {
                if (input) input.indeterminate = someItemsChecked && !allItemsChecked;
              }}
              onChange={(event) => {
                const checked = event.target.checked;
                onFiltersChange({
                  bodies: checked,
                  faces: checked,
                  edges: checked,
                  lines: checked,
                });
              }}
            />
            <span>All items</span>
          </label>
          {filterCategories.map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                aria-label={label}
                disabled={selectionDisabled}
                checked={filters[key]}
                onChange={(event) => onFiltersChange({ ...filters, [key]: event.target.checked })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </EditorDisplayDrawer>
    </div>
  );
}
