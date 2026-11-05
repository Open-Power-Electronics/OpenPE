'use client';

import { useEffect, useRef, type RefObject } from 'react';

export type DialogWindowFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const directions = [
  ['n', 'top'],
  ['ne', 'top right'],
  ['e', 'right'],
  ['se', 'bottom right'],
  ['s', 'bottom'],
  ['sw', 'bottom left'],
  ['w', 'left'],
  ['nw', 'top left'],
] as const;
type Direction = (typeof directions)[number][0];
type Bounds = { left: number; top: number; right: number; bottom: number };

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

function resizedFrame(
  start: DialogWindowFrame,
  direction: Direction,
  deltaX: number,
  deltaY: number,
  bounds: Bounds,
  minimumWidth: number,
): DialogWindowFrame {
  const availableWidth = Math.max(0, bounds.right - bounds.left);
  const availableHeight = Math.max(0, bounds.bottom - bounds.top);
  const minWidth = Math.min(availableWidth, Math.max(0, minimumWidth));
  const minHeight = Math.min(availableHeight, 160);
  // A viewport change can make the starting frame too large. Bound it first;
  // otherwise the edge opposite the gesture remains fixed throughout resizing.
  const width = clamp(start.width, 0, availableWidth);
  const height = clamp(start.height, 0, availableHeight);
  let left = clamp(start.left, bounds.left, bounds.right - width);
  let top = clamp(start.top, bounds.top, bounds.bottom - height);
  let right = left + width;
  let bottom = top + height;
  if (direction.includes('w'))
    left = clamp(left + deltaX, bounds.left, right - Math.min(minWidth, right - bounds.left));
  if (direction.includes('e'))
    right = clamp(right + deltaX, left + Math.min(minWidth, bounds.right - left), bounds.right);
  if (direction.includes('n'))
    top = clamp(top + deltaY, bounds.top, bottom - Math.min(minHeight, bottom - bounds.top));
  if (direction.includes('s'))
    bottom = clamp(bottom + deltaY, top + Math.min(minHeight, bounds.bottom - top), bounds.bottom);
  return { left, top, width: right - left, height: bottom - top };
}

export default function DialogResize({
  target,
  label,
  minWidth,
  bounds,
  onStart,
  onChange,
  onEnd,
  onReset,
  isComposing,
}: {
  target: RefObject<HTMLElement | null>;
  label: string;
  minWidth: number;
  bounds: () => Bounds;
  onStart: () => void;
  onChange: (frame: DialogWindowFrame) => void;
  onEnd: (cancel: boolean) => void;
  onReset: () => void;
  isComposing: () => boolean;
}) {
  const callbacks = useRef({ bounds, minWidth, onStart, onChange, onEnd, onReset, isComposing });
  callbacks.current = { bounds, minWidth, onStart, onChange, onEnd, onReset, isComposing };
  const drag = useRef<{
    id: number;
    handle: HTMLButtonElement;
    direction: Direction;
    x: number;
    y: number;
    frame: DialogWindowFrame;
  } | null>(null);

  function blocked() {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    return (
      Boolean(document.querySelector('[role="listbox"], [role="menu"]')) ||
      Boolean(dialog && !dialog.contains(target.current))
    );
  }

  function finish(cancel: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    callbacks.current.onEnd(cancel);
    if (current.handle.hasPointerCapture(current.id))
      current.handle.releasePointerCapture(current.id);
  }

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        !drag.current ||
        callbacks.current.isComposing() ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      finish(true);
    };
  }, []);

  return (
    <>
      {directions.map(([direction, directionLabel]) => (
        <button
          key={direction}
          type="button"
          className="dialog-resize-edge"
          data-direction={direction}
          aria-label={`Resize ${label} ${directionLabel}`}
          title="Resize"
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current || blocked()) return;
            const rect = target.current?.getBoundingClientRect();
            if (!rect) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              id: event.pointerId,
              handle: event.currentTarget,
              direction,
              x: event.clientX,
              y: event.clientY,
              frame: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            };
            callbacks.current.onStart();
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            if (blocked()) {
              finish(true);
              return;
            }
            callbacks.current.onChange(
              resizedFrame(
                current.frame,
                current.direction,
                event.clientX - current.x,
                event.clientY - current.y,
                callbacks.current.bounds(),
                callbacks.current.minWidth,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (drag.current?.id === event.pointerId) finish(false);
          }}
          onPointerCancel={(event) => {
            if (drag.current?.id === event.pointerId) finish(true);
          }}
          onLostPointerCapture={(event) => {
            if (drag.current?.id === event.pointerId) finish(true);
          }}
          onDoubleClick={() => {
            if (!blocked() && !drag.current) callbacks.current.onReset();
          }}
          onKeyDown={(event) => {
            if (
              blocked() ||
              drag.current ||
              callbacks.current.isComposing() ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === 'Home') {
              event.preventDefault();
              event.stopPropagation();
              callbacks.current.onReset();
              return;
            }
            const horizontal = direction.includes('w') || direction.includes('e');
            const vertical = direction.includes('n') || direction.includes('s');
            const deltaX = horizontal
              ? event.key === 'ArrowRight'
                ? 16
                : event.key === 'ArrowLeft'
                  ? -16
                  : 0
              : 0;
            const deltaY = vertical
              ? event.key === 'ArrowDown'
                ? 16
                : event.key === 'ArrowUp'
                  ? -16
                  : 0
              : 0;
            if (!deltaX && !deltaY) return;
            const rect = target.current?.getBoundingClientRect();
            if (!rect) return;
            event.preventDefault();
            event.stopPropagation();
            const next = resizedFrame(
              { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
              direction,
              deltaX,
              deltaY,
              callbacks.current.bounds(),
              callbacks.current.minWidth,
            );
            callbacks.current.onStart();
            callbacks.current.onChange(next);
            callbacks.current.onEnd(false);
          }}
        />
      ))}
    </>
  );
}
