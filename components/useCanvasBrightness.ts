import { useLayoutEffect, useState, type RefObject } from 'react';

/** Follow the actual drawing surface, including custom appearance backgrounds. */
export default function useCanvasBrightness(host: RefObject<HTMLElement | null>) {
  const [dark, setDark] = useState(false);
  useLayoutEffect(() => {
    const update = () => {
      const rgb = host.current && getComputedStyle(host.current).backgroundColor.match(/[\d.]+/g);
      if (rgb && rgb.length >= 3)
        setDark(
          (Number(rgb[0]) * 0.2126 + Number(rgb[1]) * 0.7152 + Number(rgb[2]) * 0.0722) / 255 < 0.5,
        );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme'],
    });
    if (host.current)
      observer.observe(host.current, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => observer.disconnect();
  }, [host]);
  return dark;
}
