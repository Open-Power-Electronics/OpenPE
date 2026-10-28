'use client';

import type { MouseEventHandler, ReactNode } from 'react';

export function VisualizationToggle({
  label,
  checked,
  onChange,
  disabled,
  icon,
  ariaLabel,
  indeterminate,
  detail,
  description,
  onContextMenu,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  icon?: ReactNode;
  ariaLabel?: string;
  indeterminate?: boolean;
  detail?: ReactNode;
  description?: string;
  onContextMenu?: MouseEventHandler<HTMLLabelElement>;
}) {
  return (
    <label
      className="visualization-option"
      aria-description={description}
      onContextMenu={onContextMenu}
    >
      {icon}
      <span className="visualization-label">{label}</span>
      {detail != null && <small>{detail}</small>}
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        ref={(input) => {
          if (input) input.indeterminate = indeterminate ?? false;
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
