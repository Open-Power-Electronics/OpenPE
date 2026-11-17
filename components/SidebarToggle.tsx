'use client';

import { PanelLeft, PanelRight } from 'lucide-react';

export default function SidebarToggle({
  visible,
  onToggle,
  className = '',
  side = 'right',
}: {
  side?: 'left' | 'right';
  visible: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const label = side === 'left' ? 'Toggle sidebar' : 'Toggle right sidebar';
  const Icon = side === 'left' ? PanelLeft : PanelRight;
  return (
    <button
      type="button"
      className={`tool-button sidebar-toggle${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={visible}
      onClick={(event) => {
        const editor = event.currentTarget.closest(
          '.workspace, .editor, .schematic-surface, .layout-editor, .pcb-model-preview',
        );
        onToggle();
        requestAnimationFrame(() => {
          const counterpart = Array.from(
            editor?.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [],
          ).find((button) => button.getClientRects().length > 0);
          counterpart?.focus({ preventScroll: true });
        });
      }}
    >
      <Icon size={17} aria-hidden="true" />
    </button>
  );
}
