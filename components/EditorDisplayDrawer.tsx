'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

export default function EditorDisplayDrawer({
  label,
  disabled = false,
  disabledReason,
  children,
  open,
  onOpenChange,
  defaultOpen = false,
  className = '',
  headerActions,
}: {
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  className?: string;
  headerActions?: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const expanded = !disabled && (open ?? localOpen);
  function changeOpen(next: boolean) {
    setLocalOpen(next);
    onOpenChange?.(next);
  }
  function close() {
    changeOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <section
      className={`editor-display-drawer${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
      data-expanded={expanded}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
      onClickCapture={(event) => {
        if (
          composing.current &&
          event.target instanceof Element &&
          event.target.closest('[data-edit-action]')
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (
          (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) &&
          event.target instanceof Element &&
          event.target.closest('[data-edit-action]')
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        const isComposing =
          composing.current || event.nativeEvent.isComposing || event.keyCode === 229;
        const saveShortcut =
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 's' &&
          !event.defaultPrevented &&
          !isComposing;
        if (!saveShortcut) event.stopPropagation();
        if (event.key !== 'Escape' || event.defaultPrevented || isComposing || !expanded) return;
        event.preventDefault();
        close();
      }}
    >
      <div className="editor-display-drawer-header editor-dock-header">
        <button
          ref={trigger}
          type="button"
          className="editor-display-disclosure"
          aria-expanded={expanded}
          aria-controls={id}
          disabled={disabled}
          aria-description={disabled ? disabledReason : undefined}
          onClick={() => changeOpen(!expanded)}
        >
          <ChevronRight size={14} aria-hidden />
          <span>{label}</span>
        </button>
        {headerActions}
      </div>
      <div id={id} className="editor-display-drawer-body" hidden={!expanded}>
        {typeof children === 'function' ? children(close) : children}
      </div>
    </section>
  );
}
