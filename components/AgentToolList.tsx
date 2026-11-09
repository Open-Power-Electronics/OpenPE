'use client';
import { Children, isValidElement, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import AgentToolIssues, { revealNewestToolIssue, type ToolIssues } from './AgentToolIssues';

export default function AgentToolList({
  children,
  latestCallId,
  running = false,
  issues,
}: {
  children: ReactNode;
  latestCallId?: string;
  running?: boolean;
  issues?: ToolIssues;
}) {
  const items = Children.toArray(children);
  const last = items.at(-1);
  const historyKey = `${latestCallId ?? ''}:${isValidElement(last) ? last.key : ''}:${items.length}`;
  if (!items.length) return null;
  return (
    <div
      className="agent-tool-list"
      aria-label="OpenPE tool activity"
      data-tool-count={items.length}
      data-tool-issues={issues?.count}
    >
      <ToolHistory resetKey={historyKey} count={items.length} running={running} issues={issues}>
        {items}
      </ToolHistory>
    </div>
  );
}

function ToolHistory({
  resetKey,
  count,
  running,
  issues,
  children,
}: {
  resetKey: string;
  count: number;
  running: boolean;
  issues?: ToolIssues;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const history = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    const element = history.current;
    if (element?.contains(document.activeElement)) {
      element.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
    }
    // Fold new calls before paint without replacing the keyboard target.
    if (element) element.open = false;
    setOpen(false);
  }, [resetKey]);
  return (
    <details
      ref={history}
      className="agent-tool-history"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        const expanded = event.currentTarget.open;
        setOpen(expanded);
        if (expanded) setVisited(true);
      }}
    >
      <summary
        onClick={(event) => {
          if (!event.defaultPrevented) setVisited(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        <ChevronRight size={14} className="agent-tool-history-chevron" aria-hidden="true" />
        <span>
          {count} tool {count === 1 ? 'call' : 'calls'}
        </span>
        {(running || issues) && (
          <span className="agent-tool-history-status">
            {running && (
              <span className="agent-tool-running" role="status" aria-label="Running tool calls">
                <LoaderCircle size={13} className="spin" aria-hidden="true" />
              </span>
            )}
            {issues && <AgentToolIssues issues={issues} />}
          </span>
        )}
      </summary>
      {visited && (
        <ToolHistoryBody active={open} resetKey={resetKey}>
          {children}
        </ToolHistoryBody>
      )}
    </details>
  );
}

function ToolHistoryBody({
  children,
  active,
  resetKey,
}: {
  children: ReactNode;
  active: boolean;
  resetKey: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const previousResetKey = useRef(resetKey);
  const revealOnExpansion = useRef(true);

  useLayoutEffect(() => {
    if (previousResetKey.current !== resetKey) {
      previousResetKey.current = resetKey;
      revealOnExpansion.current = true;
      return;
    }
    const element = list.current;
    if (!active || !revealOnExpansion.current || !element?.getClientRects().length) return;
    revealOnExpansion.current = false;
    if (
      !revealNewestToolIssue(
        element,
        ':scope > :is([data-tool-status="failed"], [data-tool-delivery-error]) > details > summary',
      )
    )
      element.scrollTop = element.scrollHeight;
  }, [children, active, resetKey]);

  return (
    <div
      ref={list}
      className="agent-tool-history-body"
      role="region"
      aria-label="Tool call history"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
