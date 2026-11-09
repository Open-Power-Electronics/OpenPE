'use client';
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { PanelLeft } from 'lucide-react';
import type { Element } from 'hast';
import CopyButton from './CopyButton';

// Positions belong to the exact filtered, normalized Markdown given to the parser.
export const AgentTableSource = createContext('');

export default function AgentTable({ children, node }: { children: ReactNode; node?: Element }) {
  const [frozen, setFrozen] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const restorePosition = useRef<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    const position = restorePosition.current;
    restorePosition.current = null;
    if (position && element?.getClientRects().length) {
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
  }, [frozen]);
  const source = useContext(AgentTableSource);
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  const text = start !== undefined && end !== undefined ? source.slice(start, end) : '';
  const header = node?.children.find(
    (child) => child.type === 'element' && child.tagName === 'thead',
  );
  const row =
    header?.type === 'element'
      ? header.children.find((child) => child.type === 'element' && child.tagName === 'tr')
      : undefined;
  const canFreeze =
    row?.type === 'element' &&
    row.children.filter((child) => child.type === 'element' && child.tagName === 'th').length > 1;
  return (
    <div className="agent-table-block">
      <div
        ref={viewport}
        className="message-table"
        role="region"
        aria-label="Response table"
        tabIndex={0}
        data-freeze-first={(canFreeze && frozen) || undefined}
      >
        <table>{children}</table>
      </div>
      <div className="agent-table-actions">
        {canFreeze && (
          <button
            type="button"
            className="icon-button agent-table-freeze"
            aria-label="Freeze first column"
            title="Freeze first column"
            aria-pressed={frozen}
            onClick={() => {
              const element = viewport.current;
              if (!element?.getClientRects().length) return;
              restorePosition.current = { top: element.scrollTop, left: element.scrollLeft };
              setFrozen((value) => !value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
            }}
          >
            <PanelLeft size={14} aria-hidden="true" />
          </button>
        )}
        <CopyButton text={text} label="Copy table as Markdown" />
      </div>
    </div>
  );
}
