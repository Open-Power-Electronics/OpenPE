'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type DockNameTarget = { title: string; x: number; y: number };

export default function DockNamePopup({
  target,
  enabled,
}: {
  target: DockNameTarget | null;
  enabled: boolean;
}) {
  const [shown, setShown] = useState<DockNameTarget | null>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const content = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    let delay: ReturnType<typeof setTimeout> | undefined;
    let removal: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    if (!enabled) {
      setShown(null);
      setVisible(false);
    } else if (target) {
      const reveal = () => {
        setShown(target);
        frame = requestAnimationFrame(() => setVisible(true));
      };
      // Adjacent entries share the existing surface; only the first reveal waits.
      if (shown) reveal();
      else delay = setTimeout(reveal, 80);
    } else if (shown) {
      delay = setTimeout(() => {
        setVisible(false);
        removal = setTimeout(() => setShown(null), 280);
      }, 70);
    }
    return () => {
      clearTimeout(delay);
      clearTimeout(removal);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [target, enabled]);

  useLayoutEffect(() => {
    const label = content.current;
    if (!label || !enabled || !shown) return;
    const measure = () => {
      const next = { width: label.offsetWidth + 26, height: label.offsetHeight + 18 };
      setSize((previous) =>
        previous &&
        Math.abs(previous.width - next.width) < 0.5 &&
        Math.abs(previous.height - next.height) < 0.5
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, [shown?.title, enabled]);

  if (!enabled || !shown) return null;
  return createPortal(
    <div
      role="tooltip"
      aria-hidden={!visible}
      className="dock-name-popup"
      data-visible={visible}
      style={{ left: shown.x, top: shown.y, width: size?.width, height: size?.height }}
    >
      <span ref={content} className="dock-name-popup-label">
        {shown.title}
      </span>
    </div>,
    document.body,
  );
}
