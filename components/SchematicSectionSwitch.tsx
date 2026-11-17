'use client';
import type { RefObject } from 'react';
import { Layers2 } from 'lucide-react';
import type { SchematicSectionView } from '@/lib/schematic-section';
import Select from './Select';

const sections = [
  ['all', 'All'],
  ['hardware', 'Real'],
  ['simulation', 'Virtual'],
] as const;

export default function SchematicSectionSwitch({
  value,
  onChange,
  composing,
  disabled,
}: {
  value: SchematicSectionView;
  onChange: (section: SchematicSectionView) => boolean;
  composing: RefObject<boolean>;
  disabled: boolean;
}) {
  // Checking the current view runs the same safety gates without changing it.
  const canOpen = () => !disabled && !composing.current && onChange(value);
  return (
    <div
      className="schematic-section-switch layout-status-selects"
      onPointerDownCapture={(event) => {
        if (!canOpen()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClickCapture={(event) => {
        if (!canOpen()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key) && !canOpen())
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <Select
        label="Schematic section"
        value={value}
        disabled={disabled}
        icon={<Layers2 size={14} aria-hidden="true" />}
        showChevron={false}
        popupPlacement="top-end"
        popupBoundary=".editor-drawing-region"
        popupClassName="grid-density-popup status-mode-popup"
        popupMatchWidth="content"
        options={sections.map(([value, label]) => ({ value, label }))}
        onChange={(next) => {
          if (!disabled && !composing.current && sections.some(([section]) => section === next))
            onChange(next as SchematicSectionView);
        }}
      />
    </div>
  );
}
