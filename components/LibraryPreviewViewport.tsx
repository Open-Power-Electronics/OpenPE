'use client';

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import LibraryPreviewFit from './LibraryPreviewFit';

type ScreenPoint = { x: number; y: number };
const fittedCamera = { x: 0, y: 0, zoom: 1 };
const midpoint = (first: ScreenPoint, second: ScreenPoint) => ({
  x: (first.x + second.x) / 2,
  y: (first.y + second.y) / 2,
});
const distance = (first: ScreenPoint, second: ScreenPoint) =>
  Math.hypot(first.x - second.x, first.y - second.y);

export function measurePreviewBounds(drawing: SVGGElement, measurementBox: string) {
  const svg = drawing.ownerSVGElement;
  if (!svg?.getClientRects().length) return;
  const previous = svg.getAttribute('viewBox');
  svg.setAttribute('viewBox', measurementBox);
  try {
    return drawing.getBBox();
  } finally {
    if (previous === null) svg.removeAttribute('viewBox');
    else svg.setAttribute('viewBox', previous);
  }
}

export default function LibraryPreviewViewport({
  kind,
  fitBox,
  children,
}: {
  kind: 'symbol' | 'footprint';
  fitBox: string;
  children: ReactNode;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, ScreenPoint>());
  const [camera, setCamera] = useState(fittedCamera);
  const [left, top, width, height] = fitBox.split(' ').map(Number);
  const viewBox =
    camera === fittedCamera
      ? fitBox
      : [
          left + width * (0.5 + camera.x - 0.5 / camera.zoom),
          top + height * (0.5 + camera.y - 0.5 / camera.zoom),
          width / camera.zoom,
          height / camera.zoom,
        ].join(' ');
  const label = kind === 'symbol' ? 'Symbol preview' : 'Footprint preview';

  function move(from: ScreenPoint, to: ScreenPoint, factor = 1) {
    const bounds = svg.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height || !Number.isFinite(factor) || factor <= 0) return;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const scale = Math.min(bounds.width / width, bounds.height / height);
    const fitWidth = width * scale;
    const fitHeight = height * scale;
    setCamera((current) => {
      const zoom = Math.max(0.25, Math.min(16, current.zoom * factor));
      const x = current.x + ((from.x - center.x) / current.zoom - (to.x - center.x) / zoom) / fitWidth;
      const y = current.y + ((from.y - center.y) / current.zoom - (to.y - center.y) / zoom) / fitHeight;
      return x === current.x && y === current.y && zoom === current.zoom ? current : { x, y, zoom };
    });
  }

  const zoomWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault();
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? svg.current?.clientHeight || 1 : 1;
    const delta = Math.max(-320, Math.min(320, event.deltaY * unit));
    const point = { x: event.clientX, y: event.clientY };
    if (delta) move(point, point, Math.exp(-delta * 0.002));
  });
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => zoomWheel(event);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  return (
    <div className={`library-planar-preview${kind === 'symbol' ? ' component-preview' : ''}`}>
      <svg
        ref={svg}
        className={kind === 'footprint' ? 'footprint-preview' : undefined}
        viewBox={viewBox}
        role="img"
        aria-label={label}
        aria-description="Drag or use arrow keys to pan. Scroll, pinch or use plus and minus to zoom. Press 0 to fit."
        tabIndex={0}
        onPointerDown={(event) => {
          const active = pointers.current;
          if (event.button !== 0 || active.size >= (event.pointerType === 'touch' ? 2 : 1)) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          active.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => {
          const active = pointers.current;
          const previous = active.get(event.pointerId);
          if (!previous) return;
          const point = { x: event.clientX, y: event.clientY };
          const other = [...active].find(([id]) => id !== event.pointerId)?.[1];
          active.set(event.pointerId, point);
          if (other) {
            const oldDistance = Math.max(1, distance(previous, other));
            const newDistance = Math.max(1, distance(point, other));
            move(midpoint(previous, other), midpoint(point, other), newDistance / oldDistance);
          } else move(previous, point);
        }}
        onPointerUp={(event) => pointers.current.delete(event.pointerId)}
        onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
        onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          const { key } = event;
          const zoom = key === '+' || key === '=' ? 1.25 : key === '-' ? 0.8 : 1;
          if (
            key !== '0' &&
            zoom === 1 &&
            !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (key === '0') {
            setCamera(fittedCamera);
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          move(
            center,
            {
              x: center.x + (key === 'ArrowLeft' ? 32 : key === 'ArrowRight' ? -32 : 0),
              y: center.y + (key === 'ArrowUp' ? 32 : key === 'ArrowDown' ? -32 : 0),
            },
            zoom,
          );
        }}
      >
        {children}
      </svg>
      <LibraryPreviewFit kind={kind} onFit={() => setCamera(fittedCamera)} />
    </div>
  );
}
