'use client';

import { useRef, type KeyboardEvent, type Ref } from 'react';
import { Circle, CircleCheck, CircleX, AlertTriangle } from 'lucide-react';

export default function RuleStatus({
  kind,
  report,
  state,
  expanded,
  disabled,
  panelId,
  buttonRef,
  onToggle,
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
  panelId?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onToggle: () => void;
}) {
  const composing = useRef(false);
  const current = state === 'ready' || state === 'failed' ? report : null;
  const errors = current?.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = current?.issues.filter((issue) => issue.severity === 'warning').length;
  const incomplete = current && (!current.complete || current.truncated);
  const clean = Boolean(current && !incomplete && errors === 0);
  const ErrorIcon = clean ? CircleCheck : incomplete && errors === 0 ? Circle : CircleX;
  const label = {
    unchecked: 'Not checked',
    stale: '',
    checking: 'Checking…',
    failed: 'Check failed',
    ready: '',
  }[state];
  const description = [
    kind.toUpperCase(),
    current ? `${errors} errors, ${warnings} warnings` : label,
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
        ref={buttonRef}
        type="button"
        className="rule-status"
        data-complete={current && current.complete && !current.truncated ? true : undefined}
        aria-label="Rule"
        title="Rule"
        aria-description={description}
        aria-haspopup="dialog"
        aria-controls={expanded ? panelId : undefined}
        aria-expanded={expanded}
        disabled={disabled}
        onClick={() => {
          if (!composing.current) onToggle();
        }}
        onKeyDown={(event) => {
          blockComposing(event);
          if (event.defaultPrevented || event.key !== 'Escape' || !expanded) return;
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
        onKeyUp={blockComposing}
      >
        <span
          className="rule-status-count rule-status-errors"
          data-rule-errors={errors ?? 'unknown'}
          aria-hidden="true"
        >
          <ErrorIcon size={14} />
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
