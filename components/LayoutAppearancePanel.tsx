'use client';

import { useId, useLayoutEffect, useMemo, useRef, type Ref } from 'react';
import { Eraser, Eye, EyeOff, Scan, X } from 'lucide-react';
import type { PCB, BoardLayer } from '@/lib/pcb';
import { pcbLayerColor, type PCBDisplay } from '@/lib/pcb-display';
import type { PCBSelectionFilters } from '@/lib/pcb-selection';
import { VisualizationToggle } from './VisualizationMenu';
import EditorDisplayDrawer from './EditorDisplayDrawer';

export type LayoutAppearanceTab = 'layers' | 'objects' | 'nets';

const selectionCategories = [
  ['footprint', 'Footprints'],
  ['text', 'Text'],
  ['track', 'Tracks'],
  ['via', 'Vias'],
  ['pad', 'Pads'],
  ['graphic', 'Graphics'],
  ['zone', 'Zones'],
  ['ruleArea', 'Rule areas'],
  ['dimension', 'Dimensions'],
] as const;
const selectionRows = [
  ['all', 'All items'],
  ['locked', 'Locked items'],
  ...selectionCategories,
  ['point', 'Points'],
] as const;

export default function LayoutAppearancePanel({
  panelRef,
  board,
  displayLayers,
  layers,
  onLayersChange,
  priorityLayer,
  onPriorityLayerChange,
  tab,
  onTabChange,
  visualizationExpanded,
  onVisualizationExpandedChange,
  filters,
  onFiltersChange,
  filtersExpanded,
  onFiltersExpandedChange,
  hiddenNets,
  onHiddenNetsChange,
  highlightNets,
  onHighlightNetsChange,
  netSearch,
  onNetSearchChange,
  netEdges,
  airwireCount,
  connectivityError,
}: {
  panelRef?: Ref<HTMLElement>;
  board: Pick<PCB, 'layers' | 'nets'>;
  displayLayers: BoardLayer[];
  layers: PCBDisplay;
  onLayersChange: (layers: PCBDisplay) => void;
  priorityLayer: BoardLayer | null;
  onPriorityLayerChange: (layer: BoardLayer | null) => void;
  tab: LayoutAppearanceTab;
  onTabChange: (tab: LayoutAppearanceTab) => void;
  visualizationExpanded: boolean;
  onVisualizationExpandedChange: (expanded: boolean) => void;
  filters: PCBSelectionFilters;
  onFiltersChange: (filters: PCBSelectionFilters) => void;
  filtersExpanded: boolean;
  onFiltersExpandedChange: (expanded: boolean) => void;
  hiddenNets: Set<string>;
  onHiddenNetsChange: (nets: Set<string>) => void;
  highlightNets: Set<string>;
  onHighlightNetsChange: (nets: Set<string>) => void;
  netSearch: string;
  onNetSearchChange: (value: string) => void;
  netEdges: readonly { netId: string }[];
  airwireCount: number;
  connectivityError?: string;
}) {
  const id = useId();
  const netSearchInput = useRef<HTMLInputElement>(null);
  const currentActions = {
    onLayersChange,
    onPriorityLayerChange,
    onTabChange,
    onVisualizationExpandedChange,
    onFiltersChange,
    onFiltersExpandedChange,
    onHiddenNetsChange,
    onHighlightNetsChange,
    onNetSearchChange,
  };
  const latestActions = useRef(currentActions);
  useLayoutEffect(() => {
    latestActions.current = currentActions;
  });
  const actions = useMemo(
    () => ({
      onLayersChange: (...args: Parameters<typeof onLayersChange>) =>
        latestActions.current.onLayersChange(...args),
      onPriorityLayerChange: (...args: Parameters<typeof onPriorityLayerChange>) =>
        latestActions.current.onPriorityLayerChange(...args),
      onTabChange: (...args: Parameters<typeof onTabChange>) =>
        latestActions.current.onTabChange(...args),
      onVisualizationExpandedChange: (...args: Parameters<typeof onVisualizationExpandedChange>) =>
        latestActions.current.onVisualizationExpandedChange(...args),
      onFiltersChange: (...args: Parameters<typeof onFiltersChange>) =>
        latestActions.current.onFiltersChange(...args),
      onFiltersExpandedChange: (...args: Parameters<typeof onFiltersExpandedChange>) =>
        latestActions.current.onFiltersExpandedChange(...args),
      onHiddenNetsChange: (...args: Parameters<typeof onHiddenNetsChange>) =>
        latestActions.current.onHiddenNetsChange(...args),
      onHighlightNetsChange: (...args: Parameters<typeof onHighlightNetsChange>) =>
        latestActions.current.onHighlightNetsChange(...args),
      onNetSearchChange: (...args: Parameters<typeof onNetSearchChange>) =>
        latestActions.current.onNetSearchChange(...args),
    }),
    [],
  );
  const tabs = [
    ['layers', 'Layers'],
    ['objects', 'Objects'],
    ['nets', 'Nets'],
  ] as const;
  const netCounts = new Map<string, number>();
  for (const edge of netEdges) netCounts.set(edge.netId, (netCounts.get(edge.netId) ?? 0) + 1);
  const matchingNets = board.nets.filter((net) =>
    net.name.toLowerCase().includes(netSearch.toLowerCase()),
  );
  const categoryChecked = (key: keyof PCBSelectionFilters) =>
    key === 'pad' || key === 'point'
      ? Boolean(filters[key])
      : key === 'text' || key === 'dimension'
        ? (filters[key] ?? filters.graphic)
        : key === 'ruleArea'
          ? (filters.ruleArea ?? filters.zone)
          : key === 'locked'
            ? filters.locked !== false
            : Boolean(filters[key]);
  const allItemsChecked = selectionCategories.every(([key]) => categoryChecked(key));
  const someItemsChecked = selectionCategories.some(([key]) => categoryChecked(key));

  // Keep controls intact while their display data agrees; actions read current props.
  const body = useMemo(
    () => (
      <div className="editor-display-drawers">
        <EditorDisplayDrawer
          label="Visualization"
          className="editor-visualization-drawer"
          open={visualizationExpanded}
          onOpenChange={actions.onVisualizationExpandedChange}
        >
          <div className="layout-appearance-tabs" role="tablist" aria-label="Appearance">
            {tabs.map(([key, label], index) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`${id}-${key}-tab`}
                aria-selected={tab === key}
                aria-controls={`${id}-${key}-panel`}
                tabIndex={tab === key ? 0 : -1}
                onClick={() => actions.onTabChange(key)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
                  else if (event.key === 'ArrowLeft')
                    next = (index + tabs.length - 1) % tabs.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = tabs.length - 1;
                  else return;
                  event.preventDefault();
                  actions.onTabChange(tabs[next][0]);
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="layout-appearance-content"
            role="tabpanel"
            id={`${id}-${tab}-panel`}
            aria-labelledby={`${id}-${tab}-tab`}
          >
            {tab === 'layers' && (
              <div role="group" aria-label="Visible layers">
                {displayLayers.map((name) => (
                  <div
                    className="layout-design-layer editor-visibility-row"
                    key={name}
                    data-active={priorityLayer === name}
                  >
                    <button
                      type="button"
                      className="layout-layer-name editor-visibility-name"
                      aria-label={name}
                      aria-pressed={priorityLayer === name}
                      onClick={() =>
                        actions.onPriorityLayerChange(priorityLayer === name ? null : name)
                      }
                    >
                      <i
                        className="layout-layer-swatch editor-visibility-swatch"
                        style={{ background: pcbLayerColor(name) }}
                        aria-hidden
                      />
                      <span>{name}</span>
                    </button>
                    <label
                      className="layout-layer-visibility editor-visibility-toggle"
                      aria-description={layers[name] ? `Hide ${name}` : `Show ${name}`}
                    >
                      {layers[name] ? (
                        <Eye size={15} aria-hidden />
                      ) : (
                        <EyeOff size={15} aria-hidden />
                      )}
                      <input
                        type="checkbox"
                        aria-label={name}
                        checked={Boolean(layers[name])}
                        onChange={(event) =>
                          actions.onLayersChange({ ...layers, [name]: event.target.checked })
                        }
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
            {tab === 'objects' && (
              <div role="group" aria-label="Visible objects">
                {(
                  [
                    ['footprints', 'Footprints', 'var(--pcb-silk-front)'],
                    ['padNumbers', 'Pad numbers', 'var(--pcb-through)'],
                    ['padNets', 'Pad net names', 'var(--pcb-through)'],
                    ['airwires', 'Airwires', 'var(--pcb-airwire)'],
                    ['zoneOutlines', 'Zone outlines', 'var(--pcb-zone)'],
                    ['copper', 'Copper preview', 'var(--pcb-front)'],
                  ] as const
                ).map(([key, label, color]) => (
                  <label className="editor-visibility-row" key={key}>
                    <span className="editor-visibility-name">
                      <i
                        className="layout-layer-swatch editor-visibility-swatch"
                        style={{ background: color }}
                        aria-hidden
                      />
                      <span>{label}</span>
                    </span>
                    <span
                      className="editor-visibility-toggle"
                      aria-description={`${layers[key] ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
                    >
                      {layers[key] ? (
                        <Eye size={15} aria-hidden />
                      ) : (
                        <EyeOff size={15} aria-hidden />
                      )}
                      <input
                        type="checkbox"
                        aria-label={label}
                        checked={layers[key]}
                        onChange={(event) =>
                          actions.onLayersChange({ ...layers, [key]: event.target.checked })
                        }
                      />
                    </span>
                  </label>
                ))}
              </div>
            )}
            {tab === 'nets' && (
              <div className="layout-net-panel" role="group" aria-label="Net visibility">
                <div className="layout-net-controls">
                  <div className="layout-net-search-row">
                    <div className="layout-net-search-field">
                      <input
                        ref={netSearchInput}
                        className="layout-net-search"
                        aria-label="Search nets"
                        placeholder="Search nets"
                        value={netSearch}
                        onChange={(event) => actions.onNetSearchChange(event.target.value)}
                      />
                      {netSearch && (
                        <button
                          type="button"
                          className="layout-net-clear-search"
                          aria-label="Clear net search"
                          title="Clear net search"
                          onClick={() => {
                            actions.onNetSearchChange('');
                            netSearchInput.current?.focus({ preventScroll: true });
                          }}
                        >
                          <X size={14} aria-hidden />
                        </button>
                      )}
                    </div>
                    {highlightNets.size > 0 && (
                      <button
                        type="button"
                        className="layout-net-clear-highlight"
                        aria-label="Clear net highlight"
                        title="Clear net highlight"
                        onClick={(event) => {
                          const returnFocus =
                            event.detail === 0 && document.activeElement === event.currentTarget;
                          actions.onHighlightNetsChange(new Set());
                          if (returnFocus) netSearchInput.current?.focus({ preventScroll: true });
                        }}
                      >
                        <Eraser size={17} aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
                <div className="layout-net-summary">
                  <VisualizationToggle
                    label="All nets"
                    ariaLabel="All nets"
                    checked={
                      board.nets.length > 0 && board.nets.every((net) => !hiddenNets.has(net.id))
                    }
                    disabled={!board.nets.length}
                    indeterminate={
                      board.nets.some((net) => hiddenNets.has(net.id)) &&
                      board.nets.some((net) => !hiddenNets.has(net.id))
                    }
                    icon={
                      board.nets.some((net) => !hiddenNets.has(net.id)) ? (
                        <Eye size={16} aria-hidden />
                      ) : (
                        <EyeOff size={16} aria-hidden />
                      )
                    }
                    detail={netEdges.length ? `${airwireCount} / ${netEdges.length}` : undefined}
                    onChange={(checked) =>
                      actions.onHiddenNetsChange(
                        new Set(checked ? [] : board.nets.map((net) => net.id)),
                      )
                    }
                  />
                  <span aria-hidden />
                </div>
                {matchingNets.map((net) => (
                  <div className="layout-net-row" key={net.id}>
                    <VisualizationToggle
                      label={net.name}
                      ariaLabel={`Show airwires for ${net.name}`}
                      description={net.name}
                      checked={!hiddenNets.has(net.id)}
                      icon={
                        hiddenNets.has(net.id) ? (
                          <EyeOff size={16} aria-hidden />
                        ) : (
                          <Eye size={16} aria-hidden />
                        )
                      }
                      detail={netCounts.get(net.id) || undefined}
                      onChange={(checked) => {
                        const next = new Set(hiddenNets);
                        if (checked) next.delete(net.id);
                        else next.add(net.id);
                        actions.onHiddenNetsChange(next);
                      }}
                    />
                    <button
                      type="button"
                      className={highlightNets.has(net.id) ? 'active' : ''}
                      aria-label={`Highlight ${net.name}`}
                      title="Highlight net"
                      aria-pressed={highlightNets.has(net.id)}
                      onClick={() => {
                        const next = new Set(highlightNets);
                        if (next.has(net.id)) next.delete(net.id);
                        else next.add(net.id);
                        actions.onHighlightNetsChange(next);
                      }}
                    >
                      <Scan size={16} aria-hidden />
                    </button>
                  </div>
                ))}
                {!board.nets.length && (
                  <p className="layout-sidebar-empty">No nets in this board.</p>
                )}
                {!!board.nets.length && !matchingNets.length && (
                  <p className="layout-sidebar-empty">No matching nets.</p>
                )}
                {connectivityError && <p role="alert">{connectivityError}</p>}
              </div>
            )}
          </div>
        </EditorDisplayDrawer>
        <EditorDisplayDrawer
          label="Selection"
          className="editor-filters-drawer"
          open={filtersExpanded}
          onOpenChange={actions.onFiltersExpandedChange}
        >
          <div className="layout-filter-grid editor-filter-grid">
            {selectionRows.map(([key, label]) => (
              <label
                key={key}
                aria-description={
                  key === 'point'
                    ? 'Point and endpoint selection is not available in Layout.'
                    : key === 'pad'
                      ? 'Footprint pads and non-plated holes; independent of board vias.'
                      : key === 'via'
                        ? 'Board through vias connecting copper layers; independent of footprint pads.'
                        : key === 'locked'
                          ? 'Select locked tracks'
                          : label
                }
              >
                <input
                  type="checkbox"
                  checked={key === 'all' ? allItemsChecked : categoryChecked(key)}
                  aria-label={label}
                  disabled={key === 'point'}
                  ref={(input) => {
                    if (input)
                      input.indeterminate = key === 'all' && someItemsChecked && !allItemsChecked;
                  }}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    const next = { ...filters };
                    if (key === 'all') {
                      for (const [category] of selectionCategories) next[category] = checked;
                    } else next[key] = checked;
                    actions.onFiltersChange(next);
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </EditorDisplayDrawer>
      </div>
    ),
    [
      id,
      board,
      displayLayers,
      layers,
      priorityLayer,
      tab,
      visualizationExpanded,
      filters,
      filtersExpanded,
      hiddenNets,
      highlightNets,
      netSearch,
      netEdges,
      airwireCount,
      tab === 'nets' ? connectivityError : undefined,
      actions,
    ],
  );
  return (
    <section ref={panelRef} className="layout-appearance" aria-label="Appearance">
      {body}
    </section>
  );
}
