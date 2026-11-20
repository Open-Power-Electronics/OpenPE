import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import PanelFind from './PanelFind';
import { findScopeAtPoint, isPanelFindShortcut, type FindScope } from './panel-find';
import { hasOpenOverlay } from './openOverlay';

export type PanelFindHandle = { open: (scope?: FindScope) => void };
type FindState = {
  scope: FindScope;
  pane: HTMLElement;
  anchor: HTMLElement;
  root: Element;
  origin: HTMLElement | SVGElement | null;
  request: number;
};

export default memo(function PanelFindController({
  workspace,
  control,
  active,
  scopeKey,
}: {
  workspace: RefObject<HTMLElement | null>;
  control: RefObject<PanelFindHandle | null>;
  active: boolean;
  scopeKey: string;
}) {
  const [find, setFind] = useState<FindState | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const composing = useRef(false);
  const sequence = useRef(0);
  function pane(scope: FindScope) {
    const element = workspace.current?.querySelector<HTMLElement>(
      scope === 'agent' ? '.chat-panel:not([hidden])' : '.editor',
    );
    return element?.getClientRects().length ? element : null;
  }
  function open(explicit?: FindScope) {
    if (!active || composing.current || hasOpenOverlay()) return;
    const agent = pane('agent');
    const preview = pane('preview');
    const focused = document.activeElement;
    const fallback = focused && agent?.contains(focused) ? 'agent' : 'preview';
    const scope =
      explicit ??
      findScopeAtPoint(
        pointer.current,
        agent?.getBoundingClientRect() ?? null,
        preview?.getBoundingClientRect() ?? null,
        fallback,
      );
    if (!scope) return;
    const element = scope === 'agent' ? agent : preview;
    if (!element) return;
    const surface = element.querySelector<HTMLElement>('.file-editor-surface:not([hidden])');
    const canvas = surface?.querySelector<SVGSVGElement>(
      'svg[data-testid="schematic-canvas"], svg[data-testid="layout-canvas"]',
    );
    const root =
      scope === 'agent'
        ? element.querySelector<HTMLElement>('.chat-scroll')
        : (canvas ??
          surface?.querySelector<HTMLElement>(
            '.pcb-model-canvas, .source-editor-code:not([hidden])',
          ));
    const anchor = scope === 'agent' ? element : (canvas?.parentElement ?? root);
    if (!root || !(anchor instanceof HTMLElement) || !root.getClientRects().length) return;
    setFind((current) => ({
      scope,
      pane: element,
      anchor,
      root,
      request: ++sequence.current,
      origin:
        current?.pane === element
          ? current.origin
          : (focused instanceof HTMLElement || focused instanceof SVGElement) &&
              !focused.closest('[data-panel-find]')
            ? focused
            : ([
                ...element.querySelectorAll<HTMLElement | SVGElement>(
                  'textarea, [tabindex="0"], .cm-content',
                ),
              ].find((node) => node.getClientRects().length) ?? null),
    }));
  }
  useLayoutEffect(() => {
    control.current = { open };
    return () => {
      control.current = null;
    };
  });
  useLayoutEffect(() => {
    setFind(null);
    composing.current = false;
  }, [active, scopeKey]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!active) return;
      pointer.current =
        event.target instanceof Element && event.target.closest('.desktop-titlebar, .application-menu')
          ? null
          : { x: event.clientX, y: event.clientY };
    };
    const start = () => {
      if (active) composing.current = true;
    };
    const end = () => {
      composing.current = false;
    };
    const key = (event: KeyboardEvent) => {
      if (
        !active ||
        composing.current ||
        event.defaultPrevented ||
        !isPanelFindShortcut(event) ||
        hasOpenOverlay()
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) open();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('compositionstart', start, true);
    window.addEventListener('compositionend', end, true);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('compositionstart', start, true);
      window.removeEventListener('compositionend', end, true);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', key, true);
    };
  });
  if (!active || !find || !find.root.isConnected || !find.anchor.isConnected) return null;
  return createPortal(
    <PanelFind
      key={find.scope}
      root={find.root}
      scope={find.scope}
      request={find.request}
      composition={composing}
      onClose={() => {
        setFind(null);
        if (find.origin?.isConnected) find.origin.focus({ preventScroll: true });
      }}
    />,
    find.anchor,
  );
});
