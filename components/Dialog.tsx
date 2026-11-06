'use client';
import { useLayoutEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, X } from 'lucide-react';
import type { InspectorSize } from './InspectorResize';
import DialogResize, { type DialogWindowFrame } from './DialogResize';

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
  open = true,
  anchorPlacement = 'below',
  anchorPoint,
  size: preferredSize,
  onResize,
  minWidth = 224,
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
  open?: boolean;
  anchorPlacement?: 'below' | 'inside' | 'above' | 'near';
  anchorPoint?: { x: number; y: number };
  minWidth?: number;
} & DialogSizeProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const backdropDown = useRef(false);
  const composing = useRef(false);
  const [maximized, setMaximized] = useState(false);
  const [placementRevision, setPlacementRevision] = useState(0);
  const [localSize, setLocalSize] = useState<InspectorSize>({});
  const windowOrigin = useRef<{ left: number; top: number } | null>(null);
  const resizeSession = useRef<{
    size: InspectorSize;
    origin: { left: number; top: number } | null;
    style: string;
  } | null>(null);
  const move = useRef<{
    id: number;
    header: HTMLElement;
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
    moved: boolean;
    origin: { left: number; top: number } | null;
    style: string;
  } | null>(null);
  const size = preferredSize ?? localSize;
  const margin = anchorRef ? 8 : 24;
  function topMargin() {
    const titlebar =
      ref.current &&
      parseFloat(getComputedStyle(ref.current).getPropertyValue('--desktop-titlebar-height'));
    return Math.max(margin, titlebar || 0);
  }
  function placeWindowOrigin(clamp = false) {
    const dialog = ref.current;
    const origin = windowOrigin.current;
    if (!dialog || !origin || !dialog.open || maximized) return;
    if (clamp) {
      const rect = dialog.getBoundingClientRect();
      origin.left = Math.max(
        margin,
        Math.min(origin.left, window.innerWidth - rect.width - margin),
      );
      origin.top = Math.max(
        topMargin(),
        Math.min(origin.top, window.innerHeight - rect.height - margin),
      );
    }
    Object.assign(dialog.style, {
      position: 'fixed',
      inset: 'auto',
      margin: '0',
      left: `${origin.left}px`,
      top: `${origin.top}px`,
      maxWidth: `${Math.max(0, window.innerWidth - origin.left - margin)}px`,
      maxHeight: `${Math.max(0, window.innerHeight - origin.top - margin)}px`,
    });
  }
  function resetSize() {
    if (maximized) return;
    const dialog = ref.current;
    if (dialog && windowOrigin.current) {
      windowOrigin.current = null;
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
      setPlacementRevision((revision) => revision + 1);
    }
    (onResize ?? setLocalSize)({});
  }
  function startResize() {
    if (!ref.current || move.current || maximized) return;
    resizeSession.current = {
      size: { ...size },
      origin: windowOrigin.current && { ...windowOrigin.current },
      style: ref.current.style.cssText,
    };
  }
  function changeResize(frame: DialogWindowFrame) {
    if (!resizeSession.current || maximized) return;
    windowOrigin.current = { left: frame.left, top: frame.top };
    placeWindowOrigin();
    (onResize ?? setLocalSize)({ width: frame.width, height: frame.height });
  }
  function finishResize(cancel: boolean) {
    const session = resizeSession.current;
    resizeSession.current = null;
    if (!session || !cancel) return;
    windowOrigin.current = session.origin;
    if (ref.current) ref.current.style.cssText = session.style;
    (onResize ?? setLocalSize)(session.size);
  }
  function finishMove(cancel: boolean) {
    const current = move.current;
    if (!current) return;
    move.current = null;
    if (cancel) {
      windowOrigin.current = current.origin;
      if (ref.current) ref.current.style.cssText = current.style;
    } else if (current.moved) {
      (onResize ?? setLocalSize)({ width: current.width, height: current.height });
    }
    if (current.header.hasPointerCapture(current.id))
      current.header.releasePointerCapture(current.id);
  }
  useLayoutEffect(() => {
    if (!open) return;
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    if (modal) dialog.showModal();
    else dialog.show();
    placeWindowOrigin(true);
    (
      dialog.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog.querySelector<HTMLElement>('input') ??
      dialog.querySelector<HTMLElement>('[aria-label="Close dialog"]') ??
      dialog.querySelector<HTMLElement>('button')
    )?.focus();
    return () => {
      const restoreFocus = modal || dialog.contains(document.activeElement);
      dialog.close();
      if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [modal, open]);
  useLayoutEffect(() => {
    const place = () => placeWindowOrigin(true);
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [margin, maximized]);
  useLayoutEffect(() => {
    if (open && !maximized) placeWindowOrigin(true);
  }, [open, maximized]);
  useLayoutEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        !move.current ||
        composing.current ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      finishMove(true);
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      finishMove(true);
      finishResize(true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (modal || !open) return;
    const dismiss = (event: PointerEvent) => {
      if (!busy && !ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [modal, open, busy, onClose]);
  useLayoutEffect(() => {
    if (!anchorRef || !open || maximized) return;
    const dialog = ref.current!;
    const place = () => {
      if (windowOrigin.current) {
        placeWindowOrigin(true);
        return;
      }
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      if (anchorPlacement === 'near') {
        dialog.style.maxWidth = `${window.innerWidth - 16}px`;
        dialog.style.maxHeight = `${window.innerHeight - topMargin() - 8}px`;
        const x = anchor.left + (anchorPoint?.x ?? anchor.width / 2);
        const y = anchor.top + (anchorPoint?.y ?? anchor.height / 2);
        const { width, height } = dialog.getBoundingClientRect();
        const top = y + 8 + height <= window.innerHeight - 8 ? y + 8 : y - height - 8;
        dialog.style.left = `${Math.max(8, Math.min(x + 8, window.innerWidth - width - 8))}px`;
        dialog.style.top = `${Math.max(topMargin(), Math.min(top, window.innerHeight - height - 8))}px`;
        return;
      }
      if (anchorPlacement === 'inside')
        dialog.style.maxWidth = `${Math.max(180, Math.min(anchor.width - 16, window.innerWidth - 16))}px`;
      const top = Math.max(
        topMargin(),
        Math.min(
          anchorPlacement === 'above'
            ? anchor.top - dialog.offsetHeight - 6
            : anchorPlacement === 'inside'
              ? anchor.top + 26
              : anchor.bottom + 6,
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
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [
    anchorRef,
    anchorPlacement,
    anchorPoint,
    size.width,
    size.height,
    open,
    maximized,
    placementRevision,
  ]);
  return createPortal(
    <dialog
      ref={ref}
      className={`surface-dialog surface-dialog-resizable ${compact ? 'surface-dialog-compact' : ''} ${wide ? 'surface-dialog-wide' : ''} ${anchorRef ? 'surface-dialog-anchored' : ''} ${!modal ? 'surface-dialog-nonmodal' : ''} ${className}`}
      style={
        maximized
          ? {
              position: 'fixed',
              inset: 'var(--desktop-titlebar-height, 0px) 0 0',
              margin: 0,
              width: '100vw',
              height: 'calc(100dvh - var(--desktop-titlebar-height, 0px))',
              maxWidth: 'none',
              maxHeight: 'none',
            }
          : { width: size.width, height: size.height }
      }
      data-maximized={maximized || undefined}
      data-resized-height={maximized || size.height !== undefined ? true : undefined}
      aria-label={label}
      aria-describedby={id}
      aria-modal={modal}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!busy && !composing.current) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
          if (e.key === 'Escape' || (e.target instanceof Element && e.target.closest('button')))
            e.preventDefault();
          return;
        }
        if (!modal && e.key === 'Escape' && !busy) {
          e.preventDefault();
          onClose();
        }
      }}
      onKeyUp={(event) => {
        if (
          (composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229) &&
          event.target instanceof Element &&
          event.target.closest('button')
        ) {
          event.preventDefault();
          event.stopPropagation();
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
      <header
        className="dialog-header"
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            maximized ||
            move.current ||
            resizeSession.current ||
            (event.target instanceof Element &&
              event.target.closest(
                'button, input, textarea, select, a, [role="button"], [contenteditable]',
              )) ||
            document.querySelector('[role="listbox"], [role="menu"]')
          )
            return;
          const topDialog = [...document.querySelectorAll('dialog[open]')].at(-1);
          if (topDialog && topDialog !== ref.current) return;
          const dialog = ref.current;
          if (!dialog) return;
          const rect = dialog.getBoundingClientRect();
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          move.current = {
            id: event.pointerId,
            header: event.currentTarget,
            x: event.clientX,
            y: event.clientY,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            moved: false,
            origin: windowOrigin.current && { ...windowOrigin.current },
            style: dialog.style.cssText,
          };
        }}
        onPointerMove={(event) => {
          const current = move.current;
          if (!current || current.id !== event.pointerId) return;
          if (!current.moved && event.clientX === current.x && event.clientY === current.y) return;
          current.moved = true;
          // Moving an auto-height popup must not relax its previous content
          // cap and turn a position gesture into a size change.
          ref.current!.style.width = `${current.width}px`;
          ref.current!.style.height = `${current.height}px`;
          windowOrigin.current = {
            left: Math.max(
              margin,
              Math.min(
                current.left + event.clientX - current.x,
                window.innerWidth - current.width - margin,
              ),
            ),
            top: Math.max(
              topMargin(),
              Math.min(
                current.top + event.clientY - current.y,
                window.innerHeight - current.height - margin,
              ),
            ),
          };
          placeWindowOrigin();
        }}
        onPointerUp={() => finishMove(false)}
        onPointerCancel={() => finishMove(true)}
        onLostPointerCapture={() => finishMove(true)}
      >
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
          type="button"
          className="icon-button"
          aria-label={maximized ? 'Restore dialog' : 'Maximize dialog'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => {
            finishMove(false);
            finishResize(false);
            setMaximized((value) => !value);
          }}
        >
          {maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
        <button
          type="button"
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
      {open && !maximized && (
        <DialogResize
          target={ref}
          label={title.toLowerCase()}
          minWidth={minWidth}
          onStart={startResize}
          onChange={changeResize}
          onEnd={finishResize}
          onReset={resetSize}
          isComposing={() => composing.current}
          bounds={() => ({
            left: margin,
            right: window.innerWidth - margin,
            top: topMargin(),
            bottom: window.innerHeight - margin,
          })}
        />
      )}
    </dialog>,
    document.body,
  );
}
