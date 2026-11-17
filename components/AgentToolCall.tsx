'use client';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Eye,
  LoaderCircle,
  Search,
  Terminal,
  X,
} from 'lucide-react';
import type { AgentToolActivity, ToolPreview, ToolStatus } from '@/lib/agent-tool-activity';
import type { AgentCommandReview } from '@/lib/chat-stream';
import CopyButton from './CopyButton';
import AgentDiagnostic from './AgentDiagnostic';

const labels: Record<ToolStatus, string> = {
  running: 'Running…',
  completed: 'Completed',
  review: 'Needs review',
  applying: 'Applying…',
  applied: 'Applied',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function Preview({
  label,
  heading,
  copyLabel,
  preview,
}: {
  label: string;
  heading: string;
  copyLabel: string;
  preview: ToolPreview;
}) {
  return (
    <section className="tool-preview" role="group" aria-label={`${label} details`}>
      <div className="tool-preview-heading">
        <div className="tool-preview-title">
          <span>{heading}</span>
          {preview.truncated && <span>Preview truncated</span>}
        </div>
        <CopyButton text={preview.text} label={copyLabel} />
      </div>
      <pre tabIndex={0} aria-label={label}>
        {preview.text}
      </pre>
    </section>
  );
}

export default memo(function AgentToolCall({
  activity,
  reviewCommand,
  reviewDescription,
  onApply,
  onReject,
  onRetireFocus,
}: {
  activity: AgentToolActivity;
  reviewCommand?: AgentCommandReview;
  reviewDescription?: string;
  onApply?: () => void;
  onReject?: () => void;
  onRetireFocus?: (messageId: string) => void;
}) {
  const { tool, name, status } = activity;
  const [fullArguments, setFullArguments] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => () => {
      if (card.current?.contains(document.activeElement)) onRetireFocus?.(activity.messageId);
    },
    [onRetireFocus, activity.messageId],
  );
  const Icon = tool === 'openpe_query' ? Search : tool === 'openpe_observe' ? Eye : Terminal;
  const StateIcon =
    status === 'running' || status === 'applying'
      ? LoaderCircle
      : status === 'failed'
        ? CircleAlert
        : status === 'cancelled' || status === 'rejected'
          ? CircleSlash
          : status === 'review'
            ? CircleAlert
            : CircleCheck;
  return (
    <div
      ref={card}
      className="agent-tool-call proposal"
      data-tool-status={status}
      data-tool-delivery-error={activity.deliveryError ? true : undefined}
      data-review-id={reviewCommand?.id}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          event.preventDefault();
      }}
    >
      <details>
        <summary aria-label={`${tool} ${name}: ${labels[status]}`}>
          <Icon size={15} aria-hidden="true" />
          <span className="tool-identity">
            <strong>{name}</strong>
          </span>
          <span className="tool-state" role="status" aria-label={labels[status]}>
            <StateIcon
              size={13}
              className={status === 'running' || status === 'applying' ? 'spin' : ''}
              aria-hidden="true"
            />
            {status !== 'completed' && status !== 'applied' && labels[status]}
          </span>
          <ChevronRight size={14} className="tool-chevron" aria-hidden="true" />
        </summary>
        <div className="tool-details">
          <Preview
            label={`${name} arguments`}
            heading="Arguments"
            copyLabel="Copy arguments preview"
            preview={activity.arguments}
          />
          {reviewCommand && activity.arguments.truncated && (
            <details
              className="tool-full-arguments"
              onToggle={(event) => setFullArguments(event.currentTarget.open)}
            >
              <summary
                onClick={(event) => {
                  if (!event.defaultPrevented) setFullArguments(true);
                }}
              >
                Full command
              </summary>
              {fullArguments && (
                <Preview
                  label={`${name} full command`}
                  heading="Captured command"
                  copyLabel="Copy full command"
                  preview={{
                    text: JSON.stringify(
                      {
                        name: reviewCommand.name,
                        input: reviewCommand.input,
                      },
                      null,
                      2,
                    ),
                    truncated: false,
                  }}
                />
              )}
            </details>
          )}
          {activity.result && (
            <Preview
              label={`${name} result`}
              heading="Result"
              copyLabel="Copy result preview"
              preview={activity.result}
            />
          )}
        </div>
      </details>
      {(status === 'review' || status === 'applying') && reviewDescription && (
        <p className="tool-review-description">{reviewDescription}</p>
      )}
      {(status === 'applying' || (status === 'review' && onApply && onReject)) && (
        <div className="tool-actions">
          <button
            className="proposal-apply tool-reject"
            aria-disabled={status === 'applying' || undefined}
            onClick={() => {
              if (status === 'review') onReject?.();
            }}
            aria-label={`Reject ${name}`}
          >
            <X size={14} aria-hidden="true" />
            Reject
          </button>
          <button
            className="proposal-apply"
            aria-disabled={status === 'applying' || undefined}
            onClick={() => {
              if (status === 'review') onApply?.();
            }}
            aria-label={`Apply ${name}`}
          >
            <Check size={14} aria-hidden="true" />
            {status === 'applying' ? 'Applying…' : 'Apply'}
          </button>
        </div>
      )}
      {activity.error && <AgentDiagnostic label="Tool error" text={activity.error} />}
      {activity.deliveryError && (
        <AgentDiagnostic label="Result delivery error" text={activity.deliveryError} />
      )}
    </div>
  );
});
