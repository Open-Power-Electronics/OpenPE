'use client';

import { useEffect, useRef, type RefObject } from 'react';

export type InspectorSize = { width?: number; height?: number };
type Axis = 'width' | 'height' | 'both';

export default function InspectorResize({
  target,
  size,
  onResize,
  label = 'properties',
  minWidth,
  bounds,
  verticalAnchor = 'top',
  horizontalAnchor = 'right',
  axes = ['width', 'height', 'both'],
}: {
  target: RefObject<HTMLElement | null>;
  size: InspectorSize;
  onResize: (size: InspectorSize) => void;
  label?: string;
  minWidth?: number;
  bounds?: () => { width: number; height: number };
  verticalAnchor?: 'top' | 'bottom';
  horizontalAnchor?: 'left' | 'right';
  axes?: readonly Axis[];
}) {
  const drag = useRef<{
    id: number;
    handle: HTMLButtonElement;
    x: number;
    y: number;
    width: number;
    height: number;
    original: InspectorSize;
  } | null>(null);

  function resize(width: number, height: number, axis: Axis) {
    const panel = target.current;
    const canvas = panel?.offsetParent;
    if (!panel || (!bounds && !(canvas instanceof HTMLElement))) return;
    const limit = bounds?.() ?? {
      width: (canvas as HTMLElement).clientWidth - 24,
      height: (canvas as HTMLElement).clientHeight - panel.offsetTop - 12,
    };
    const maxWidth = Math.max(0, limit.width);
    const maxHeight = Math.max(0, limit.height);
    const minimumWidth = minWidth ?? (panel.classList.contains('part-inspector') ? 280 : 224);
    onResize({
      ...size,
      ...(axis !== 'height' && { width: Math.min(maxWidth, Math.max(minimumWidth, width)) }),
      ...(axis !== 'width' && { height: Math.min(maxHeight, Math.max(160, height)) }),
    });
  }

  function blocked() {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    return (
      !!document.querySelector('[role="listbox"], [role="menu"]') ||
      !!(dialog && !dialog.contains(target.current))
    );
  }

  function finish(cancel: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (cancel) onResize(current.original);
    if (current.handle.hasPointerCapture(current.id))
      current.handle.releasePointerCapture(current.id);
  }

  // Capture Escape even when pointer resizing deliberately leaves an input focused.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current || event.isComposing || event.keyCode === 229)
        return;
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [onResize]);

  return (
    <>
      {axes.map((axis) => (
        <button
          key={axis}
          type="button"
          className={`inspector-resize inspector-resize-${axis}`}
          data-vertical-anchor={verticalAnchor}
          data-horizontal-anchor={horizontalAnchor}
          aria-label={axis === 'both' ? `Resize ${label}` : `Resize ${label} ${axis}`}
          title={axis === 'both' ? 'Resize' : undefined}
          onPointerDown={(event) => {
            if (event.button !== 0 || blocked() || drag.current) return;
            const rect = target.current?.getBoundingClientRect();
            if (!rect) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              id: event.pointerId,
              handle: event.currentTarget,
              x: event.clientX,
              y: event.clientY,
              width: rect.width,
              height: rect.height,
              original: size,
            };
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (current?.id !== event.pointerId) return;
            resize(
              current.width + (event.clientX - current.x) * (horizontalAnchor === 'left' ? 1 : -1),
              current.height + (event.clientY - current.y) * (verticalAnchor === 'bottom' ? -1 : 1),
              axis,
            );
          }}
          onPointerUp={() => finish(false)}
          onPointerCancel={() => finish(true)}
          onLostPointerCapture={() => finish(true)}
          onDoubleClick={() => onResize({})}
          onKeyDown={(event) => {
            if (blocked() || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
              return;
            const rect = target.current?.getBoundingClientRect();
            if (
              !rect ||
              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Home') onResize({});
            else
              resize(
                rect.width +
                  (event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0) *
                    (horizontalAnchor === 'left' ? 1 : -1),
                rect.height +
                  (event.key === 'ArrowDown' ? 16 : event.key === 'ArrowUp' ? -16 : 0) *
                    (verticalAnchor === 'bottom' ? -1 : 1),
                axis,
              );
          }}
        >
          {axis === 'both' && (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 4L10 11M3 8L6 11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      ))}
    </>
  );
}
