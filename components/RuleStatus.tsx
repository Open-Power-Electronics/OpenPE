'use client';

import { useRef, type KeyboardEvent } from 'react';
import { CircleCheck, CircleX, AlertTriangle } from 'lucide-react';

export default function RuleStatus({
  kind,
  report,
  state,
  expanded,
  disabled,
  onOpen,
}: {
  kind: 'erc' | 'drc' | 'model';
  report: {
    issues: readonly { severity: 'error' | 'warning' }[];
    complete: boolean;
    truncated?: boolean;
  } | null;
  state: 'unchecked' | 'stale' | 'checking' | 'failed' | 'ready';
  expanded: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const composing = useRef(false);
  const current = state === 'ready' || state === 'failed' ? report : null;
  const errors = current?.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = current?.issues.filter((issue) => issue.severity === 'warning').length;
  const incomplete = current && (!current.complete || current.truncated);
  const clean = Boolean(current && !incomplete && errors === 0);
  const label = {
    unchecked: 'Not checked',
    stale: 'Outdated',
    checking: 'Checking…',
    failed: 'Check failed',
    ready: incomplete ? 'Incomplete' : '',
  }[state];
  const description = [
    kind.toUpperCase(),
    current ? `${errors} errors, ${warnings} warnings` : label,
    incomplete ? 'Incomplete checks' : '',
  ]
    .filter(Boolean)
    .join('. ');
  function blockComposing(event: KeyboardEvent<HTMLButtonElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  return (
    <span
      className="rule-status-controls"
      role="group"
      aria-label="Rule status"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
    >
      <button
        type="button"
        className="rule-status"
        data-complete={current && current.complete && !current.truncated ? true : undefined}
        aria-label="Rule"
        title="Rule"
        aria-description={description}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        disabled={disabled}
        onClick={() => {
          if (!composing.current) onOpen();
        }}
        onKeyDown={blockComposing}
        onKeyUp={blockComposing}
      >
        <span
          className="rule-status-count rule-status-errors"
          data-rule-errors={errors ?? 'unknown'}
          aria-hidden="true"
        >
          {clean ? <CircleCheck size={14} /> : <CircleX size={14} />}
          {errors ?? '—'}
        </span>
        <span
          className="rule-status-count rule-status-warnings"
          data-rule-warnings={warnings ?? 'unknown'}
          aria-hidden="true"
        >
          <AlertTriangle size={14} />
          {warnings ?? '—'}
        </span>
        {label && (
          <span className="rule-status-state" aria-hidden="true">
            {label}
          </span>
        )}
      </button>
    </span>
  );
}
