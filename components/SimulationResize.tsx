'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { hasOpenOverlay } from './Dialog';

/** Presentation only: each mounted workbench retains its own panel sizes. */
export default function SimulationResize({
  target,
  visible,
}: {
  target: RefObject<HTMLDivElement | null>;
  visible: boolean;
}) {
  const [preferred, setPreferred] = useState<number | null>(null);
  const [bounds, setBounds] = useState({ min: 0, max: 0, value: 0 });
  const drag = useRef<{
    id: number;
    handle: HTMLDivElement;
    origin: number;
    size: number;
    previous: number | null;
  } | null>(null);
  function finish(cancel: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (cancel) setPreferred(current.previous);
    if (current.handle.hasPointerCapture(current.id))
      current.handle.releasePointerCapture(current.id);
  }
  useLayoutEffect(() => {
    const panel = target.current;
    const parent = panel?.parentElement;
    if (!panel || !parent || !visible) {
      finish(true);
      return;
    }
    const update = () => {
      const available = parent.clientHeight;
      if (!available) return;
      const max = Math.max(0, available - 120);
      const min = Math.min(max, 180);
      const fallback = Math.min(340, available * 0.48);
      const value = Math.min(max, Math.max(min, preferred ?? fallback));
      panel.style.setProperty('--simulation-panel-size', `${value}px`);
      setBounds({ min, max, value });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [target, visible, preferred]);
  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      finish(false);
    };
  }, []);
  const resize = (value: number) => setPreferred(Math.min(bounds.max, Math.max(bounds.min, value)));
  const label = 'Resize waveform panel';
  return (
    <div
      className="simulation-resize simulation-resize-height"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={Math.round(bounds.min)}
      aria-valuemax={Math.round(bounds.max)}
      aria-valuenow={Math.round(bounds.value)}
      onPointerDown={(event) => {
        if (event.button !== 0 || hasOpenOverlay() || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          id: event.pointerId,
          handle: event.currentTarget,
          origin: event.clientY,
          size: bounds.value,
          previous: preferred,
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.id !== event.pointerId) return;
        resize(current.size + current.origin - event.clientY);
      }}
      onPointerUp={() => finish(false)}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => setPreferred(null)}
      onKeyDown={(event) => {
        if (hasOpenOverlay()) return;
        const increase = 'ArrowUp';
        const decrease = 'ArrowDown';
        if (![increase, decrease, 'Home'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Home') setPreferred(null);
        else resize(bounds.value + (event.key === increase ? 16 : -16));
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}
