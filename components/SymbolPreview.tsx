'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { SExpr } from '@/lib/sexpr';
import type { Part } from '@/lib/circuit';
import { isOwnedProjectNode } from '@/lib/immutable-project';
import SymbolGraphic, { symbolVoltageSource } from './SymbolGraphic';

// These are measured SVG bounds, never geometric/text-width approximations.
// Only detached library nodes qualify, and each retains a small number of exact
// unit/source/font contexts. Caller freezing never establishes ownership.
const viewBoxes = new WeakMap<SExpr, Map<string, string>>();
const scopedViewBoxes = new WeakMap<SExpr, Map<string, string>>();
const measurementViewBox = '-8 -8 16 16';
const fontEpochs = new WeakMap<FontFaceSet, { value: number }>();
type StylesheetState = {
  value: number;
  observer: MutationObserver;
  listeners: Set<() => void>;
};
const stylesheetEpochs = new WeakMap<Document, StylesheetState>();
const fontProperties = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-variant',
  'font-feature-settings',
  'font-variation-settings',
  'font-kerning',
  'font-optical-sizing',
  'font-size-adjust',
  'font-synthesis',
  'font-language-override',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-rendering',
  'direction',
  'writing-mode',
  'text-orientation',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
];

function fontEpoch(fonts: FontFaceSet) {
  let epoch = fontEpochs.get(fonts);
  if (!epoch) {
    epoch = { value: 0 };
    fontEpochs.set(fonts, epoch);
    const current = epoch;
    const invalidate = () => current.value++;
    for (const event of ['loading', 'loadingdone', 'loadingerror'])
      fonts.addEventListener(event, invalidate);
  }
  return epoch;
}

function stylesheetChange(records: MutationRecord[]) {
  const isStyle = (node: Node) =>
    node instanceof Element &&
    (node.matches('style,link[rel="stylesheet"]') ||
      !!node.querySelector('style,link[rel="stylesheet"]'));
  return records.some(
    (record) =>
      record.target.parentElement?.tagName === 'STYLE' ||
      (record.target instanceof Element && record.target.matches('style,link')) ||
      [...record.addedNodes, ...record.removedNodes].some(isStyle),
  );
}

function stylesheetEpoch(document: Document) {
  let state = stylesheetEpochs.get(document);
  if (!state) {
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((listener) => listener());
    const observer = new MutationObserver((records) => {
      if (stylesheetChange(records)) {
        current.value++;
        notify();
      }
    });
    const current: StylesheetState = { value: 0, observer, listeners };
    state = current;
    stylesheetEpochs.set(document, current);
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    document.head.addEventListener(
      'load',
      (event) => {
        if (event.target instanceof HTMLLinkElement) {
          current.value++;
          notify();
        }
      },
      true,
    );
  }
  // A synchronous React commit can precede observer delivery after a style edit.
  if (stylesheetChange(state.observer.takeRecords())) {
    state.value++;
    const listeners = state.listeners;
    queueMicrotask(() => listeners.forEach((listener) => listener()));
  }
  return state;
}

function remember(
  cache: WeakMap<SExpr, Map<string, string>>,
  library: SExpr,
  key: string,
  fitted: string,
) {
  let variants = cache.get(library);
  if (!variants) cache.set(library, (variants = new Map()));
  if (variants.size >= 16) variants.delete(variants.keys().next().value!);
  variants.set(key, fitted);
}

/** Read declared context without asking Blink to flush style or layout. Preview
 * viewport rules are fixed in the application CSS; stylesheet, ancestor,
 * window-size and font changes invalidate this faster exact-context lookup. */
function previewScope(svg: SVGSVGElement, fontVersion: number, styleVersion: number) {
  const ancestors = [];
  for (let node: Element | null = svg; node; node = node.parentElement)
    ancestors.push([
      node.tagName,
      [...node.attributes]
        .filter((attribute) => node !== svg || attribute.name !== 'viewBox')
        .map((attribute) => [attribute.name, attribute.value]),
    ]);
  return [
    fontVersion,
    styleVersion,
    window.innerWidth,
    window.innerHeight,
    window.devicePixelRatio,
    ancestors,
  ];
}

/** Fit the actual library drawing without changing schematic geometry. */
export default function SymbolPreview({
  library,
  unit = 1,
  part,
}: {
  library: SExpr;
  unit?: number;
  part?: Part;
}) {
  const drawing = useRef<SVGGElement>(null);
  const [viewBox, setViewBox] = useState('-8 -8 16 16');
  const voltageSource = symbolVoltageSource(library, part);

  useLayoutEffect(() => {
    const group = drawing.current;
    const svg = group?.ownerSVGElement;
    if (!group || !svg) return;
    const fonts = svg.ownerDocument.fonts;
    const epoch = fontEpoch(fonts);
    const owned = isOwnedProjectNode(library);
    const measure = () => {
      const styles = stylesheetEpoch(svg.ownerDocument);
      const scope = JSON.stringify([
        unit,
        voltageSource,
        ...previewScope(svg, epoch.value, styles.value),
      ]);
      const scoped =
        owned && fonts.status !== 'loading' ? scopedViewBoxes.get(library)?.get(scope) : null;
      if (scoped) {
        setViewBox(scoped);
        return;
      }
      const style = getComputedStyle(group);
      const viewportStyle = getComputedStyle(svg);
      const key = JSON.stringify([
        unit,
        voltageSource,
        epoch.value,
        viewportStyle.width,
        viewportStyle.height,
        group.closest('[lang]')?.getAttribute('lang'),
        ...fontProperties.map((property) => style.getPropertyValue(property)),
        [...group.querySelectorAll('text')].map((text) => {
          const textStyle = getComputedStyle(text);
          return fontProperties.map((property) => textStyle.getPropertyValue(property));
        }),
      ]);
      const cached = owned && fonts.status !== 'loading' ? viewBoxes.get(library)?.get(key) : null;
      if (cached) {
        remember(scopedViewBoxes, library, scope, cached);
        setViewBox(cached);
        return;
      }
      // Hidden dialogs can report empty bounds; wait until they become visible.
      if (!svg.getClientRects().length) return;
      // Chromium can hint SVG text differently at each viewBox scale. Measure
      // in one fixed viewport, restoring the live fit before the browser paints.
      const previousViewBox = svg.getAttribute('viewBox');
      svg.setAttribute('viewBox', measurementViewBox);
      let bounds: DOMRect;
      try {
        bounds = group.getBBox();
      } finally {
        if (previousViewBox === null) svg.removeAttribute('viewBox');
        else svg.setAttribute('viewBox', previousViewBox);
      }
      if (!bounds.width && !bounds.height) return;
      // Keep point-like symbols readable without enlarging them into oversized rings.
      const size = Math.max(bounds.width, bounds.height, 4) * 1.25;
      const fitted = `${bounds.x + bounds.width / 2 - size / 2} ${bounds.y + bounds.height / 2 - size / 2} ${size} ${size}`;
      if (owned && fonts.status !== 'loading') {
        remember(viewBoxes, library, key, fitted);
        remember(scopedViewBoxes, library, scope, fitted);
      }
      setViewBox(fitted);
    };
    measure();
    // Resize may reveal a hidden dialog, but an unchanged drawing/font/size context
    // reuses its exact bounds instead of forcing another synchronous SVG layout.
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    const inheritedStyle = new MutationObserver(measure);
    for (let parent: Element | null = svg; parent; parent = parent.parentElement)
      inheritedStyle.observe(parent, {
        attributes: true,
        ...(parent === svg ? { attributeFilter: ['style', 'class', 'width', 'height'] } : {}),
      });
    const styles = stylesheetEpoch(svg.ownerDocument);
    styles.listeners.add(measure);
    window.addEventListener('resize', measure);
    fonts.addEventListener('loadingdone', measure);
    fonts.addEventListener('loadingerror', measure);
    return () => {
      observer.disconnect();
      inheritedStyle.disconnect();
      styles.listeners.delete(measure);
      window.removeEventListener('resize', measure);
      fonts.removeEventListener('loadingdone', measure);
      fonts.removeEventListener('loadingerror', measure);
    };
  }, [library, unit, voltageSource]);

  return (
    <span className="component-preview" aria-hidden="true">
      <svg viewBox={viewBox} focusable="false">
        <g ref={drawing}>
          <SymbolGraphic library={library} unit={unit} part={part} />
        </g>
      </svg>
    </span>
  );
}
