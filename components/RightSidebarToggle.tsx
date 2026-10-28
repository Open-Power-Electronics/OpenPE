'use client';

import { PanelRight } from 'lucide-react';

export default function RightSidebarToggle({
  visible,
  onToggle,
  className = '',
}: {
  visible: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`tool-button${className ? ` ${className}` : ''}`}
      aria-label="Toggle right sidebar"
      title="Toggle right sidebar"
      aria-pressed={visible}
      onClick={(event) => {
        const editor = event.currentTarget.closest(
          '.editor, .schematic-surface, .layout-editor, .pcb-model-preview',
        );
        onToggle();
        requestAnimationFrame(() => {
          const counterpart = Array.from(
            editor?.querySelectorAll<HTMLButtonElement>(
              'button[aria-label="Toggle right sidebar"]',
            ) ?? [],
          ).find((button) => button.getClientRects().length > 0);
          counterpart?.focus({ preventScroll: true });
        });
      }}
    >
      <PanelRight size={17} aria-hidden="true" />
    </button>
  );
}
