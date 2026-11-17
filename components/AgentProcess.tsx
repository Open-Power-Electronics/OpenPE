'use client';
import {
  type ReactNode,
  type Ref,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ChatOutcome, ChatTimings } from '@/lib/chat-stream';
import AgentToolIssues, { revealNewestToolIssue, type ToolIssues } from './AgentToolIssues';
import { ChatLiveTiming, ChatTiming } from './ChatTiming';

type AgentProcessProps = {
  running: boolean;
  visible?: boolean;
  heading: ReactNode;
  hasWork: boolean;
  startedAt?: number;
  timings?: ChatTimings;
  outcome?: ChatOutcome;
  issues?: ToolIssues;
  children: ReactNode;
};

export default function AgentProcess({
  running,
  visible = true,
  heading,
  hasWork,
  startedAt,
  outcome,
  ...props
}: AgentProcessProps) {
  const live = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLElement>(null);
  const outcomeId = useId();
  const outcomeLabel =
    !running && (outcome === 'cancelled' ? 'Stopped' : outcome === 'failed' ? 'Failed' : undefined);
  const header = (
    <>
      {heading}
      {outcomeLabel && (
        <span id={outcomeId} className="agent-response-outcome" data-outcome={outcome}>
          {outcomeLabel}
        </span>
      )}
    </>
  );
  const restoreFocus = useRef(false);
  const retainLiveFocus = useCallback((element: HTMLDivElement | null) => {
    if (!element) restoreFocus.current = !!live.current?.contains(document.activeElement);
    live.current = element;
  }, []);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (
      !running &&
      hasWork &&
      visible &&
      document.activeElement === document.body &&
      summary.current?.getClientRects().length
    )
      summary.current.focus({ preventScroll: true });
  }, [running, hasWork, visible]);
  if (running || !hasWork)
    return (
      <div ref={retainLiveFocus} className="agent-process" data-running={running || undefined}>
        <div className="message-author">
          {header}
          {running ? (
            startedAt !== undefined && <ChatLiveTiming startedAt={startedAt} active={visible} />
          ) : (
            <ChatTiming timings={props.timings} />
          )}
        </div>
        {hasWork && <div className="agent-process-body">{props.children}</div>}
      </div>
    );
  // Mount a fresh disclosure on completion instead of resetting live UI in an effect.
  return (
    <CompletedProcess
      heading={header}
      timings={props.timings}
      issues={props.issues}
      outcomeDescription={outcomeLabel ? outcomeId : undefined}
      summaryRef={summary}
    >
      {props.children}
    </CompletedProcess>
  );
}

function CompletedProcess({
  heading,
  timings,
  issues,
  outcomeDescription,
  children,
  summaryRef,
}: Pick<AgentProcessProps, 'heading' | 'timings' | 'issues' | 'children'> & {
  summaryRef: Ref<HTMLElement>;
  outcomeDescription?: string;
}) {
  const [visited, setVisited] = useState(false);
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const revealOnExpansion = useRef(true);
  const issueDescription = useId();
  useLayoutEffect(() => {
    const element = body.current;
    if (!open || !revealOnExpansion.current || !element) return;
    revealOnExpansion.current = false;
    if (element.getClientRects().length)
      revealNewestToolIssue(element, ':scope > [data-tool-issues] > details > summary');
  }, [open]);
  return (
    <details
      className="agent-process"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        const expanded = event.currentTarget.open;
        setOpen(expanded);
        if (expanded) setVisited(true);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
      }}
    >
      <summary
        ref={summaryRef}
        className="message-author"
        aria-label="Work details"
        aria-describedby={
          [outcomeDescription, issues ? issueDescription : undefined].filter(Boolean).join(' ') ||
          undefined
        }
        onClick={(event) => {
          if (!event.defaultPrevented) setVisited(true);
        }}
      >
        {heading}
        {issues && <AgentToolIssues issues={issues} id={issueDescription} />}
        <ChatTiming timings={timings} />
      </summary>
      {visited && (
        <div
          ref={body}
          className="agent-process-body"
          role="region"
          aria-label="Work details content"
          tabIndex={0}
        >
          {children}
        </div>
      )}
    </details>
  );
}
