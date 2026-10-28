'use client';
import { useLayoutEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import InspectorResize, { type InspectorSize } from './InspectorResize';

export type DialogSizeProps = {
  size?: InspectorSize;
  onResize?: (size: InspectorSize) => void;
};

export { hasOpenOverlay } from './openOverlay';

export default function Dialog({
  title,
  label = title,
  eyebrow,
  icon,
  children,
  footer,
  onClose,
  busy = false,
  compact = false,
  wide = false,
  className = '',
  anchorRef,
  modal = true,
  anchorPlacement = 'below',
  resizable = false,
  size: preferredSize,
  onResize,
  minWidth = 224,
  resizeCorner,
}: {
  title: string;
  label?: string;
  eyebrow?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  compact?: boolean;
  wide?: boolean;
  className?: string;
  anchorRef?: RefObject<HTMLElement | null>;
  modal?: boolean;
  anchorPlacement?: 'below' | 'inside' | 'above';
  resizable?: boolean;
  minWidth?: number;
  resizeCorner?: 'bottom-right';
} & DialogSizeProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const backdropDown = useRef(false);
  const [localSize, setLocalSize] = useState<InspectorSize>({});
  const resizeOrigin = useRef<{ left: number; top: number } | null>(null);
  const size = preferredSize ?? localSize;
  function placeResizeOrigin(clamp = false) {
    const dialog = ref.current;
    const origin = resizeOrigin.current;
    if (!dialog || !origin) return;
    if (clamp) {
      const rect = dialog.getBoundingClientRect();
      origin.left = Math.max(24, Math.min(origin.left, window.innerWidth - rect.width - 24));
      origin.top = Math.max(24, Math.min(origin.top, window.innerHeight - rect.height - 24));
    }
    Object.assign(dialog.style, {
      position: 'fixed',
      inset: 'auto',
      margin: '0',
      left: `${origin.left}px`,
      top: `${origin.top}px`,
      maxWidth: `${Math.max(0, window.innerWidth - origin.left - 24)}px`,
      maxHeight: `${Math.max(0, window.innerHeight - origin.top - 24)}px`,
    });
  }
  function resize(next: InspectorSize) {
    const dialog = ref.current;
    if (resizeCorner && dialog) {
      if (next.width === undefined && next.height === undefined) {
        resizeOrigin.current = null;
        for (const property of [
          'position',
          'inset',
          'margin',
          'left',
          'top',
          'max-width',
          'max-height',
        ])
          dialog.style.removeProperty(property);
      } else {
        const rect = dialog.getBoundingClientRect();
        resizeOrigin.current ??= { left: rect.left, top: rect.top };
        placeResizeOrigin();
      }
    }
    (onResize ?? setLocalSize)(next);
  }
  function resizeArea() {
    if (resizeCorner) {
      const rect = ref.current?.getBoundingClientRect();
      const left = resizeOrigin.current?.left ?? rect?.left ?? 24;
      const top = resizeOrigin.current?.top ?? rect?.top ?? 24;
      return { left, right: window.innerWidth - 24, top, bottom: window.innerHeight - 24 };
    }
    const anchor = anchorRef?.current?.getBoundingClientRect();
    const editor = anchorRef?.current?.closest('.editor')?.getBoundingClientRect();
    const left = Math.max(8, editor ? editor.left + 12 : 8);
    const right = Math.max(
      left,
      Math.min(window.innerWidth - 8, anchor?.right ?? window.innerWidth - 8),
    );
    const bottom = Math.min(
      window.innerHeight - 8,
      anchorPlacement === 'above' && anchor
        ? anchor.top - 6
        : editor
          ? editor.bottom - 12
          : window.innerHeight - 8,
    );
    const top =
      anchorPlacement === 'above'
        ? Math.max(8, editor ? editor.top + 12 : 8)
        : Math.max(8, Math.min((anchor?.bottom ?? 2) + 6, bottom - 112));
    return { left, right, top, bottom };
  }
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    if (modal) dialog.showModal();
    else dialog.show();
    (
      dialog.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog.querySelector<HTMLElement>('input') ??
      dialog.querySelector<HTMLElement>('button')
    )?.focus();
    return () => {
      const restoreFocus = modal || dialog.contains(document.activeElement);
      dialog.close();
      if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [modal]);
  useLayoutEffect(() => {
    if (!resizeCorner) return;
    const place = () => placeResizeOrigin(true);
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [resizeCorner]);
  useLayoutEffect(() => {
    if (modal) return;
    const dismiss = (event: PointerEvent) => {
      if (!busy && !ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [modal, busy, onClose]);
  useLayoutEffect(() => {
    if (!anchorRef) return;
    const dialog = ref.current!;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      if (resizable) {
        const { left, right, top, bottom } = resizeArea();
        dialog.style.maxWidth = `${Math.max(0, right - left)}px`;
        dialog.style.maxHeight = `${Math.max(0, bottom - top)}px`;
        dialog.style.top = `${anchorPlacement === 'above' ? Math.max(top, bottom - dialog.getBoundingClientRect().height) : top}px`;
        dialog.style.left = `${Math.max(left, right - dialog.getBoundingClientRect().width)}px`;
        return;
      }
      if (anchorPlacement === 'inside')
        dialog.style.maxWidth = `${Math.max(180, Math.min(anchor.width - 16, window.innerWidth - 16))}px`;
      const top = Math.max(
        8,
        Math.min(
          anchorPlacement === 'inside' ? anchor.top + 26 : anchor.bottom + 6,
          window.innerHeight - (anchorPlacement === 'inside' ? dialog.offsetHeight + 8 : 120),
        ),
      );
      dialog.style.maxHeight = `${window.innerHeight - top - 8}px`;
      dialog.style.top = `${top}px`;
      dialog.style.left = `${Math.max(8, Math.min(anchor.right - dialog.offsetWidth - (anchorPlacement === 'inside' ? 8 : 0), window.innerWidth - dialog.offsetWidth - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(dialog);
    if (anchorRef.current) observer.observe(anchorRef.current);
    const editor = anchorRef.current?.closest('.editor');
    if (resizable && editor) observer.observe(editor);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef, anchorPlacement, resizable, size.width, size.height]);
  return createPortal(
    <dialog
      ref={ref}
      className={`surface-dialog ${compact ? 'surface-dialog-compact' : ''} ${wide ? 'surface-dialog-wide' : ''} ${anchorRef ? 'surface-dialog-anchored' : ''} ${!modal ? 'surface-dialog-nonmodal' : ''} ${resizable ? 'surface-dialog-resizable' : ''} ${className}`}
      style={resizable ? { width: size.width, height: size.height } : undefined}
      data-resized-height={resizable && size.height !== undefined ? true : undefined}
      aria-label={label}
      aria-describedby={id}
      aria-modal={modal}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (!modal && e.key === 'Escape' && !busy) {
          e.preventDefault();
          onClose();
        }
      }}
      onPointerDown={(e) => {
        backdropDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropDown.current && e.target === e.currentTarget && !busy) onClose();
        backdropDown.current = false;
      }}
    >
      <header className="dialog-header">
        {icon && (
          <span className="dialog-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <div>
          {eyebrow && <p className="dialog-eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          title="Close"
          onClick={onClose}
          disabled={busy}
        >
          <X size={18} />
        </button>
      </header>
      <div className="dialog-content" id={id}>
        {children}
      </div>
      {footer && <footer className="dialog-footer">{footer}</footer>}
      {resizable && (
        <InspectorResize
          target={ref}
          size={size}
          onResize={resize}
          label={title.toLowerCase()}
          axes={resizeCorner ? ['both'] : undefined}
          horizontalAnchor={resizeCorner ? 'left' : 'right'}
          verticalAnchor={anchorPlacement === 'above' ? 'bottom' : 'top'}
          minWidth={minWidth}
          bounds={() => {
            const { left, right, top, bottom } = resizeArea();
            return { width: right - left, height: bottom - top };
          }}
        />
      )}
    </dialog>,
    document.body,
  );
}
