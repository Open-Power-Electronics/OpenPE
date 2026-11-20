'use client';
import {
  type CSSProperties,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ChevronRight, ListOrdered, WrapText } from 'lucide-react';
import type { Element } from 'hast';
import CopyButton from './CopyButton';
import Dialog from './Dialog';
import { isGoToCodeLineShortcut, revealCodeLine } from './agent-code-navigation';

const maxNumberedLines = 2000;

export default function AgentCodeBlock({
  children,
  node,
}: {
  children: ReactNode;
  node?: Element;
}) {
  const [wrap, setWrap] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const readerId = useId();
  const [lineDraft, setLineDraft] = useState<string | null>(null);
  const [locatedLine, setLocatedLine] = useState<number | null>(null);
  const pendingLine = useRef<number | null>(null);
  const lineOriginLeft = useRef<number | null>(null);
  const composingLine = useRef(false);
  const viewport = useRef<HTMLPreElement>(null);
  const positions = useRef<{
    wrapped?: { top: number; left: number };
    unwrapped?: { top: number; left: number };
  }>({});
  useLayoutEffect(() => {
    const area = viewport.current;
    const position = positions.current[wrap ? 'wrapped' : 'unwrapped'];
    if (!collapsed && position && area?.getClientRects().length) {
      area.scrollTop = position.top;
      area.scrollLeft = position.left;
    }
  }, [wrap, collapsed]);
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
  const text =
    code?.type === 'element'
      ? code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
      : '';
  const classes = code?.type === 'element' ? code.properties.className : undefined;
  const language = (Array.isArray(classes) ? classes : []).find(
    (name) => typeof name === 'string' && name.startsWith('language-'),
  );
  const caption = typeof language === 'string' ? language.slice(9, 41) : 'Code';
  const terminalBreak = text.endsWith('\n');
  const lines = text.split('\n', maxNumberedLines + 2);
  const completeSplit = lines.length <= maxNumberedLines + 1;
  if (completeSplit && terminalBreak) lines.pop();
  const numbered =
    completeSplit &&
    lines.length > 1 &&
    lines.length <= maxNumberedLines &&
    code?.type === 'element' &&
    code.children.every((child) => child.type === 'text');
  const lineNumber = lineDraft && /^\d+$/.test(lineDraft) ? Number(lineDraft) : 0;
  const validLine = lineNumber >= 1 && lineNumber <= lines.length;
  function openLineDialog() {
    const area = viewport.current;
    if (!area?.getClientRects().length) return;
    lineOriginLeft.current = area.scrollLeft;
    setLineDraft('');
  }
  function closeLineDialog() {
    composingLine.current = false;
    setLineDraft(null);
  }
  function goToLine() {
    if (!validLine || composingLine.current || !viewport.current?.getClientRects().length) return;
    pendingLine.current = lineNumber;
    closeLineDialog();
  }
  useLayoutEffect(() => {
    const area = viewport.current;
    if (!area) return;
    if (lineDraft !== null && !numbered) {
      closeLineDialog();
      return;
    }
    if (lineDraft !== null) return;
    const line = pendingLine.current;
    const left = lineOriginLeft.current;
    pendingLine.current = null;
    lineOriginLeft.current = null;
    if (!area.getClientRects().length) return;
    if (left !== null) area.scrollLeft = left;
    if (line === null) return;
    const row = area.querySelectorAll<HTMLElement>('.agent-code-line')[line - 1];
    if (!row) return;
    area.focus({ preventScroll: true });
    revealCodeLine(area, row);
    setLocatedLine(line);
  }, [lineDraft, numbered]);
  const lineDialogOpen = numbered && lineDraft !== null;
  useLayoutEffect(() => {
    const area = viewport.current;
    if (!lineDialogOpen || !area) return;
    const observer = new ResizeObserver(() => {
      if (!area.getClientRects().length) closeLineDialog();
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [lineDialogOpen]);
  return (
    <div className="agent-code-block" role="group" aria-label={`${caption} block`}>
      <div className="agent-code-header">
        <button
          type="button"
          className="agent-code-disclosure"
          aria-label={collapsed ? 'Expand code' : 'Collapse code'}
          aria-expanded={!collapsed}
          aria-controls={readerId}
          onClick={(event) => {
            const area = viewport.current;
            if (!area || !event.currentTarget.getClientRects().length) return;
            if (!collapsed) {
              positions.current[wrap ? 'wrapped' : 'unwrapped'] = {
                top: area.scrollTop,
                left: area.scrollLeft,
              };
              if (area.contains(document.activeElement))
                event.currentTarget.focus({ preventScroll: true });
            }
            setCollapsed((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          <ChevronRight size={14} aria-hidden="true" />
          <span className="agent-code-caption">{caption}</span>
          {collapsed && numbered && (
            <span className="agent-code-collapsed-count">{lines.length} lines</span>
          )}
        </button>
        <div className="agent-code-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Wrap code"
            title="Wrap code"
            aria-pressed={wrap}
            disabled={collapsed}
            onClick={() => {
              const area = viewport.current;
              if (!area?.getClientRects().length) return;
              positions.current[wrap ? 'wrapped' : 'unwrapped'] = {
                top: area.scrollTop,
                left: area.scrollLeft,
              };
              setWrap((value) => !value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
            }}
          >
            <WrapText size={14} aria-hidden="true" />
          </button>
          {numbered && (
            <button
              type="button"
              className="icon-button agent-code-go-to-line"
              aria-label="Go to line"
              aria-haspopup="dialog"
              disabled={collapsed}
              title="Go to line (Ctrl+G / ⌘G from code)"
              onClick={openLineDialog}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
              }}
            >
              <ListOrdered size={14} aria-hidden="true" />
            </button>
          )}
          <CopyButton text={text} label="Copy code" />
        </div>
      </div>
      <pre
        ref={viewport}
        id={readerId}
        hidden={collapsed}
        data-wrap={wrap || undefined}
        data-numbered={numbered || undefined}
        tabIndex={0}
        aria-label={typeof language === 'string' ? `${caption} code` : 'Code block'}
        aria-keyshortcuts={numbered ? 'Control+G Meta+G' : undefined}
        onBlur={() => setLocatedLine(null)}
        onKeyDown={(event) => {
          if (
            !numbered ||
            !isGoToCodeLineShortcut(event.nativeEvent) ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            !event.currentTarget.getClientRects().length
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) openLineDialog();
        }}
      >
        {numbered ? (
          <code
            className={Array.isArray(classes) ? classes.join(' ') : undefined}
            style={
              { '--agent-line-number-width': `${String(lines.length).length}ch` } as CSSProperties
            }
          >
            {lines.map((line, index) => (
              <span
                className="agent-code-line"
                key={index}
                data-located={locatedLine === index + 1 || undefined}
              >
                <span className="agent-code-line-number" aria-hidden="true" data-line={index + 1} />
                <span className="agent-code-line-source">
                  {line}
                  {index < lines.length - 1 || terminalBreak ? '\n' : ''}
                </span>
              </span>
            ))}
          </code>
        ) : (
          children
        )}
      </pre>
      {lineDialogOpen && (
        <Dialog
          title="Go to line"
          compact
          onClose={closeLineDialog}
          footer={
            <button
              type="button"
              className="dialog-button primary"
              disabled={!validLine}
              onClick={goToLine}
            >
              Jump
            </button>
          }
        >
          <label className="agent-code-line-field">
            Line number
            <input
              type="text"
              inputMode="numeric"
              maxLength={16}
              aria-description={`Enter a line from 1 to ${lines.length}.`}
              aria-invalid={Boolean(lineDraft && !validLine) || undefined}
              placeholder={`1–${lines.length}`}
              value={lineDraft}
              data-autofocus
              onChange={(event) => setLineDraft(event.currentTarget.value)}
              onCompositionStart={() => {
                composingLine.current = true;
              }}
              onCompositionEnd={() => {
                composingLine.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== 'Enter' ||
                  event.repeat ||
                  composingLine.current ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                event.preventDefault();
                goToLine();
              }}
            />
          </label>
          {lineDraft && !validLine && (
            <p className="dialog-error" role="status">
              Enter a line from 1 to {lines.length}.
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
