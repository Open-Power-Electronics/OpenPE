'use client';

import { useCallback, useEffect, useRef, useState, type SVGProps } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';

type View = { x: number; y: number; width: number; height: number };

export function useComparisonView({
  active,
  before,
  after,
  initialView,
  emptyView,
  padding,
  focusOnPointerDown = false,
  stopArrowPropagation = false,
}: {
  active: boolean;
  before: object | undefined;
  after: object | undefined;
  initialView: View;
  emptyView: View;
  padding: number;
  focusOnPointerDown?: boolean;
  stopArrowPropagation?: boolean;
}) {
  const leftRef = useRef<SVGGElement>(null),
    rightRef = useRef<SVGGElement>(null);
  const [view, setView] = useState(initialView);
  const fittedView = useRef(initialView);
  const fittedPair = useRef<{ before?: object; after?: object } | null>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    scale: number;
    view: View;
    target: SVGSVGElement;
  } | null>(null);
  const cancelDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.id))
      current.target.releasePointerCapture(current.id);
  }, []);

  // History dialogs mount before becoming visible. Fit only after reveal and
  // retain the current camera when reopening the same comparison pair.
  useEffect(() => {
    cancelDrag();
    if (!active || (fittedPair.current?.before === before && fittedPair.current?.after === after))
      return;
    const boxes = [leftRef.current, rightRef.current]
      .filter((group) => group?.childElementCount)
      .map((group) => group!.getBBox());
    let next = emptyView;
    if (boxes.length) {
      const x = Math.min(...boxes.map((box) => box.x)) - padding;
      const y = Math.min(...boxes.map((box) => box.y)) - padding;
      next = {
        x,
        y,
        width: Math.max(20, Math.max(...boxes.map((box) => box.x + box.width)) - x + padding),
        height: Math.max(20, Math.max(...boxes.map((box) => box.y + box.height)) - y + padding),
      };
    }
    fittedView.current = next;
    fittedPair.current = { before, after };
    setView(next);
    return cancelDrag;
  }, [active, before, after, cancelDrag, emptyView, padding]);

  const zoom = useCallback(
    (factor: number) => {
      cancelDrag();
      setView((current) => {
        const ratio = (current.width / fittedView.current.width) * factor;
        if (ratio < 0.02 || ratio > 20) return current;
        return {
          x: current.x + (current.width * (1 - factor)) / 2,
          y: current.y + (current.height * (1 - factor)) / 2,
          width: current.width * factor,
          height: current.height * factor,
        };
      });
    },
    [cancelDrag],
  );
  const fit = useCallback(() => {
    cancelDrag();
    setView(fittedView.current);
  }, [cancelDrag]);

  useEffect(() => {
    if (!active) return;
    const surfaces = [leftRef.current, rightRef.current]
      .map((group) => group?.ownerSVGElement)
      .filter((svg): svg is SVGSVGElement => Boolean(svg));
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.deltaY) zoom(event.deltaY < 0 ? 0.8 : 1.25);
    };
    const observer = new ResizeObserver(cancelDrag);
    for (const svg of surfaces) {
      svg.addEventListener('wheel', wheel, { passive: false });
      observer.observe(svg);
    }
    return () => {
      observer.disconnect();
      for (const svg of surfaces) svg.removeEventListener('wheel', wheel);
      cancelDrag();
    };
  }, [active, before, after, zoom, cancelDrag]);

  const svgProps: SVGProps<SVGSVGElement> = {
    viewBox: `${view.x} ${view.y} ${view.width} ${view.height}`,
    onKeyDown(event) {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (stopArrowPropagation) event.stopPropagation();
      cancelDrag();
      setView((current) => ({
        ...current,
        x:
          current.x +
          ((event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0) * current.width) /
            10,
        y:
          current.y +
          ((event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0) * current.height) /
            10,
      }));
    },
    onPointerDown(event) {
      if (event.button !== 0) return;
      const matrix = event.currentTarget.getScreenCTM();
      if (!matrix) return;
      if (focusOnPointerDown) event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        view,
        scale: matrix.a,
        target: event.currentTarget,
      };
    },
    onPointerMove(event) {
      const current = drag.current;
      if (current && current.id === event.pointerId)
        setView({
          ...current.view,
          x: current.view.x - (event.clientX - current.x) / current.scale,
          y: current.view.y - (event.clientY - current.y) / current.scale,
        });
    },
    onPointerUp: cancelDrag,
    onPointerCancel: cancelDrag,
    onLostPointerCapture: cancelDrag,
  };
  return { leftRef, rightRef, svgProps, zoom, fit };
}

export function ComparisonViewActions({
  zoom,
  fit,
}: {
  zoom: (factor: number) => void;
  fit: () => void;
}) {
  return (
    <div className="compare-view-actions">
      <button
        className="tool-button"
        aria-label="Zoom out comparison"
        title="Zoom out"
        onClick={() => zoom(1.25)}
      >
        <Minus size={17} />
      </button>
      <button
        className="tool-button"
        aria-label="Zoom in comparison"
        title="Zoom in"
        onClick={() => zoom(0.8)}
      >
        <Plus size={17} />
      </button>
      <button className="tool-button" aria-label="Fit comparison" title="Fit view" onClick={fit}>
        <Maximize size={17} />
      </button>
    </div>
  );
}
