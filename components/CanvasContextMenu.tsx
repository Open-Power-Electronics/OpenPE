'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { createCanvasContextGesture } from '@/lib/canvas-context-gesture';
import { hasOpenOverlay } from './Dialog';

export type CanvasMenuAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void | Promise<void>;
  disabled?: boolean;
  description?: string;
  separated?: boolean;
  destructive?: boolean;
};

/** A stationary right click opens commands; right drags remain camera gestures. */
export default function CanvasContextMenu({
  target,
  active,
  identity,
  actions,
  onOpen,
  onError,
  label = 'Canvas actions',
  initialPosition,
  onDismiss,
}: {
  target: RefObject<Element | null>;
  active: boolean;
  identity: unknown;
  actions: CanvasMenuAction[];
  onOpen?: (target: EventTarget | null, position?: { x: number; y: number }) => void;
  onError: (message: string) => void;
  label?: string;
  /** An explicit one-shot popup instead of the ordinary right-click gesture. */
  initialPosition?: { x: number; y: number };
  onDismiss?: () => void;
}) {
  const [position, setPosition] = useState<{ x: number; y: number; identity: unknown } | null>(
    () => (initialPosition ? { ...initialPosition, identity } : null),
  );
  const popup = useRef<HTMLDivElement>(null);
  const current = useRef({ active, identity, actions, onOpen, onError, onDismiss });
  useLayoutEffect(() => {
    current.current = { active, identity, actions, onOpen, onError, onDismiss };
  });
  const visible =
    active && actions.length > 0 && position !== null && position.identity === identity;
  useLayoutEffect(() => {
    if (!visible && position) {
      setPosition(null);
      current.current.onDismiss?.();
    }
  }, [visible, position]);

  useEffect(() => {
    const element = target.current;
    if (!element || !active || initialPosition) return;
    const gesture = createCanvasContextGesture<EventTarget | null>();
    const pointer = (e: PointerEvent) => ({
      id: e.pointerId,
      button: e.button,
      x: e.clientX,
      y: e.clientY,
      identity: current.current.identity,
      target: e.target,
    });
    function open(x: number, y: number, node: EventTarget | null, pointer = false) {
      if (!current.current.active || hasOpenOverlay()) return;
      // Object picking must publish its selection/actions before menu identity
      // and initial keyboard focus are captured.
      flushSync(() => current.current.onOpen?.(node, pointer ? { x, y } : undefined));
      if (!current.current.active || !current.current.actions.length) return;
      setPosition({ x, y, identity: current.current.identity });
    }
    const down = (event: Event) => gesture.start(pointer(event as PointerEvent));
    const move = (event: Event) => {
      const e = event as PointerEvent;
      gesture.move(e.pointerId, e.clientX, e.clientY);
    };
    const up = (event: Event) => {
      const click = gesture.finish(pointer(event as PointerEvent));
      if (click) open(click.x, click.y, click.target, true);
    };
    const cancel = () => gesture.cancel();
    const context = (event: Event) => {
      event.preventDefault();
    };
    const key = (event: Event) => {
      const e = event as KeyboardEvent;
      if (
        e.isComposing ||
        e.keyCode === 229 ||
        e.repeat ||
        !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      const bounds = element!.getBoundingClientRect();
      open(
        bounds.left + Math.min(32, bounds.width / 2),
        bounds.top + Math.min(32, bounds.height / 2),
        element,
      );
    };
    const events = [
      ['pointerdown', down],
      ['pointermove', move],
      ['pointerup', up],
      ['pointercancel', cancel],
      ['contextmenu', context],
      ['keydown', key],
    ] as const;
    for (const [name, handler] of events)
      element.addEventListener(name, handler, { capture: true });
    return () => {
      for (const [name, handler] of events) element.removeEventListener(name, handler, true);
    };
  }, [target, active, initialPosition]);

  useLayoutEffect(() => {
    if (!visible || !popup.current || !position) return;
    const bounds = popup.current.getBoundingClientRect();
    popup.current.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8))}px`;
    popup.current.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8))}px`;
    popup.current
      .querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [visible, position]);

  useEffect(() => {
    if (!visible) return;
    const hide = () => {
      setPosition(null);
      current.current.onDismiss?.();
    };
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) hide();
    };
    const scroll = (event: Event) => {
      const scroller = event.target;
      if (
        scroller === document ||
        scroller === window ||
        (scroller instanceof Element && scroller.contains(target.current))
      )
        hide();
    };
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [visible, target]);

  function dismiss() {
    flushSync(() => {
      setPosition(null);
      current.current.onDismiss?.();
    });
    (target.current as HTMLElement | SVGElement | null)?.focus({ preventScroll: true });
  }
  if (!visible || !position) return null;
  return createPortal(
    <div
      ref={popup}
      role="menu"
      aria-label={label}
      className="select-popup canvas-context-menu"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyUp={(e) => {
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          dismiss();
          return;
        }
        const buttons = Array.from(
          popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        );
        if (!buttons.length || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buttons.length - 1
              : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }}
    >
      {actions.map(({ id, label, icon: Icon, disabled, description, separated, destructive }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          className="select-option"
          disabled={disabled}
          title={description || label}
          aria-description={description}
          data-separated={separated || undefined}
          data-destructive={destructive || undefined}
          onClick={() => {
            const action = current.current.actions.find((item) => item.id === id);
            if (
              !current.current.active ||
              position.identity !== current.current.identity ||
              !action ||
              action.disabled
            )
              return;
            dismiss();
            try {
              void Promise.resolve(action.run()).catch((error: unknown) =>
                current.current.onError(error instanceof Error ? error.message : String(error)),
              );
            } catch (error) {
              current.current.onError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          <Icon size={16} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
