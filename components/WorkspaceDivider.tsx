'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { hasOpenOverlay } from './Dialog';

const defaultRatio = 0.35;
const resizingAttribute = 'data-workspace-resizing';
const resizingOwners = new WeakMap<HTMLElement, { owners: Set<object>; previous: string | null }>();

function resizeCursor(body: HTMLElement, owner: object) {
  let state = resizingOwners.get(body);
  if (!state) {
    state = { owners: new Set(), previous: body.getAttribute(resizingAttribute) };
    resizingOwners.set(body, state);
    body.setAttribute(resizingAttribute, 'true');
  }
  state.owners.add(owner);
  return () => {
    state.owners.delete(owner);
    if (state.owners.size) return;
    if (state.previous === null) body.removeAttribute(resizingAttribute);
    else body.setAttribute(resizingAttribute, state.previous);
    resizingOwners.delete(body);
  };
}

export default function WorkspaceDivider({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cursorOwner = useRef({});
  const ratio = useRef(defaultRatio);
  const drag = useRef<{ id: number; start: number; width: number; ratio: number } | null>(null);
  const [range, setRange] = useState({ min: 0, max: 100, value: defaultRatio * 100 });
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    if (dragging) return resizeCursor(document.body, cursorOwner.current);
  }, [dragging]);
  useLayoutEffect(() => {
    if (!active) finish(true);
  }, [active]);
  useLayoutEffect(() => {
    const divider = ref.current;
    return () => {
      const current = drag.current;
      drag.current = null;
      if (current && divider?.hasPointerCapture(current.id))
        divider.releasePointerCapture(current.id);
    };
  }, []);

  function measure() {
    const divider = ref.current;
    const parent = divider?.parentElement;
    const chat = parent?.querySelector<HTMLElement>('.chat-panel:not([hidden])');
    const rail = parent?.querySelector<HTMLElement>('.nav-rail');
    // Collapsed panels have no measurable width; retain their last resize ratio.
    if (!divider || !parent || !chat || !divider.offsetWidth) return null;
    const available = parent.clientWidth - (rail?.offsetWidth ?? 0) - divider.offsetWidth - 12;
    if (available <= 0) return null;
    return { parent, chat, available, min: 328, max: Math.max(328, available - 560) };
  }

  function update(width?: number) {
    const bounds = measure();
    if (!bounds) return;
    const { parent, available, min, max } = bounds;
    const next = Math.max(min, Math.min(max, width ?? ratio.current * available));
    if (width !== undefined) ratio.current = next / available;
    parent.style.setProperty('--chat-width', `${next}px`);
    setRange({
      min: Math.round((min / available) * 100),
      max: Math.round((max / available) * 100),
      value: Math.round((next / available) * 100),
    });
  }

  useLayoutEffect(() => {
    const divider = ref.current;
    const parent = divider?.parentElement;
    if (!divider || !parent) return;
    const observer = new ResizeObserver(() => update());
    observer.observe(parent);
    observer.observe(divider);
    update();
    return () => {
      observer.disconnect();
      parent.style.removeProperty('--chat-width');
    };
  }, []);

  function finish(cancel: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (cancel) {
      ratio.current = current.ratio;
      update();
    }
    if (ref.current?.hasPointerCapture(current.id)) ref.current.releasePointerCapture(current.id);
    setDragging(false);
  }

  return (
    <div
      ref={ref}
      className={`workspace-divider${dragging ? ' dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label="Resize conversation and schematic"
      aria-orientation="vertical"
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={range.value}
      aria-valuetext={`Conversation ${range.value}%`}
      onPointerDown={(event) => {
        if (!active || event.button !== 0 || hasOpenOverlay()) return;
        const bounds = measure();
        if (!bounds) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          id: event.pointerId,
          start: event.clientX,
          width: bounds.chat.offsetWidth,
          ratio: ratio.current,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (active && current?.id === event.pointerId)
          update(current.width + event.clientX - current.start);
      }}
      onPointerUp={() => finish(false)}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => {
        ratio.current = defaultRatio;
        update();
      }}
      onKeyDown={(event) => {
        if (
          !active ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          hasOpenOverlay()
        )
          return;
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
          return;
        }
        const bounds = measure();
        if (!bounds || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        update(
          event.key === 'Home'
            ? bounds.min
            : event.key === 'End'
              ? bounds.max
              : bounds.chat.offsetWidth + (event.key === 'ArrowLeft' ? -16 : 16),
        );
      }}
    />
  );
}
