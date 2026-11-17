import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  collectPanelMatches,
  isPanelFindShortcut,
  revealPanelRange,
  type FindScope,
} from './panel-find';
import { hasOpenOverlay } from './openOverlay';
import {
  queryModelPanel,
  locateModelPanel,
  modelFindChangedEvent,
  type ModelFindTarget,
} from './model-panel-find';

export default function PanelFind({
  root,
  scope,
  request,
  composition,
  onClose,
}: {
  root: Element;
  scope: FindScope;
  request: number;
  composition: RefObject<boolean>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [status, setStatus] = useState({ current: 0, count: 0, truncated: false });
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const matches = useRef<(Range | ModelFindTarget)[]>([]);
  const index = useRef(0);
  const owned = useRef<{ all: Highlight; current: Highlight } | null>(null);
  function clear() {
    if (!owned.current) return;
    if (CSS.highlights.get('openpe-panel-find-all') === owned.current.all)
      CSS.highlights.delete('openpe-panel-find-all');
    if (CSS.highlights.get('openpe-panel-find-current') === owned.current.current)
      CSS.highlights.delete('openpe-panel-find-current');
    owned.current = null;
  }
  function publish(truncated: boolean) {
    clear();
    const ranges = matches.current.filter((match): match is Range => match instanceof Range);
    const active = matches.current[index.current];
    if (ranges.length && active instanceof Range) {
      const all = new Highlight(...ranges);
      const current = new Highlight(active);
      current.priority = 1;
      owned.current = { all, current };
      CSS.highlights.set('openpe-panel-find-all', all);
      CSS.highlights.set('openpe-panel-find-current', current);
    }
    setStatus({
      current: matches.current.length ? index.current + 1 : 0,
      count: matches.current.length,
      truncated,
    });
  }
  function reveal() {
    const range = matches.current[index.current];
    if (range && !(range instanceof Range)) locateModelPanel(root, range);
    else if (range?.startContainer.isConnected && root.contains(range.startContainer))
      revealPanelRange(root, range, (bar.current?.getBoundingClientRect().bottom ?? 0) + 4);
  }
  function step(direction: 1 | -1) {
    if (composing.current || composition.current || !matches.current.length) return;
    index.current = (index.current + direction + matches.current.length) % matches.current.length;
    publish(status.truncated);
    reveal();
  }
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [request]);
  useEffect(() => {
    let frame = 0;
    const rebuild = (navigate = false) => {
      const previous = matches.current[index.current];
      const next = root.matches('.pcb-model-canvas')
        ? queryModelPanel(root, term)
        : (() => {
            const result = collectPanelMatches(root, term);
            return { matches: result.ranges, truncated: result.truncated };
          })();
      matches.current = next.matches;
      const retained = previous
        ? next.matches.findIndex((range) =>
            previous instanceof Range && range instanceof Range
              ? range.startContainer === previous.startContainer &&
                range.startOffset === previous.startOffset
              : !(previous instanceof Range) &&
                !(range instanceof Range) &&
                previous.kind === range.kind &&
                previous.id === range.id,
          )
        : -1;
      index.current = navigate
        ? 0
        : retained >= 0
          ? retained
          : Math.min(index.current, Math.max(0, next.matches.length - 1));
      publish(next.truncated);
      if (navigate) reveal();
    };
    rebuild(true);
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => rebuild());
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'hidden',
        'open',
        'class',
        'style',
        'aria-hidden',
        'aria-expanded',
        'data-expanded',
        'data-wrap',
        'data-freeze-first',
        'viewBox',
        'transform',
        'x',
        'y',
      ],
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    root.addEventListener(modelFindChangedEvent, schedule);
    return () => {
      observer.disconnect();
      resize.disconnect();
      root.removeEventListener(modelFindChangedEvent, schedule);
      cancelAnimationFrame(frame);
      clear();
      matches.current = [];
    };
  }, [root, term]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        composing.current ||
        composition.current ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.defaultPrevented ||
        hasOpenOverlay()
      )
        return;
      const inBar = event.target instanceof Node && !!bar.current?.contains(event.target);
      if (inBar && isPanelFindShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          input.current?.focus();
          input.current?.select();
        }
      } else if (
        (event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey) ||
        (event.target === input.current &&
          event.key === 'Enter' &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) step(event.shiftKey ? -1 : 1);
      } else if (inBar && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  return (
    <div
      ref={bar}
      className="panel-find"
      data-panel-find={scope}
      role="search"
      aria-label={`Find in ${scope === 'agent' ? 'Agent' : 'Preview'}`}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        setTerm(input.current?.value ?? '');
      }}
      onKeyDownCapture={(event) => {
        if (event.repeat && event.key === 'Enter') event.preventDefault();
        if (
          (composing.current ||
            composition.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229) &&
          event.target instanceof HTMLButtonElement
        )
          event.preventDefault();
      }}
    >
      <input
        ref={input}
        type="search"
        aria-label={`Search ${scope === 'agent' ? 'Agent' : 'Preview'}`}
        placeholder="Find"
        maxLength={512}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (!composing.current) setTerm(event.target.value);
        }}
      />
      <span role="status" aria-live="polite">
        {status.current}/{status.count}
        {status.truncated ? '+' : ''}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!status.count}
        onPointerDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => step(-1)}
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!status.count}
        onPointerDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => step(1)}
      >
        <ChevronDown size={16} />
      </button>
      <button
        type="button"
        aria-label="Close find"
        title="Close find (Escape)"
        onPointerDown={(event) => {
          if (composing.current || composition.current) event.preventDefault();
        }}
        onClick={() => {
          if (!composing.current && !composition.current) onClose();
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
