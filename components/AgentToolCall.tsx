'use client';
import { memo, useState } from 'react';
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

function Preview({ label, preview }: { label: string; preview: ToolPreview }) {
  return (
    <section className="tool-preview">
      <div className="tool-preview-heading">
        <span>{label}</span>
        {preview.truncated && <span>Preview truncated</span>}
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
  onApply,
  onReject,
}: {
  activity: AgentToolActivity;
  reviewCommand?: AgentCommandReview;
  onApply?: () => void;
  onReject?: () => void;
}) {
  const { tool, name, status } = activity;
  const [fullArguments, setFullArguments] = useState(false);
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
      className="agent-tool-call proposal"
      data-tool-status={status}
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
          <span className="tool-state" role="status">
            <StateIcon
              size={13}
              className={status === 'running' || status === 'applying' ? 'spin' : ''}
              aria-hidden="true"
            />
            {labels[status]}
          </span>
          <ChevronRight size={14} className="tool-chevron" aria-hidden="true" />
        </summary>
        <div className="tool-details">
          <Preview label={`${name} arguments`} preview={activity.arguments} />
          {reviewCommand && activity.arguments.truncated && (
            <details
              className="tool-full-arguments"
              onToggle={(event) => setFullArguments(event.currentTarget.open)}
            >
              <summary>Full command</summary>
              {fullArguments && (
                <div className="tool-preview">
                  <pre tabIndex={0} aria-label={`${name} full command`}>
                    {JSON.stringify(
                      {
                        name: reviewCommand.name,
                        input: reviewCommand.input,
                        expectedRevision: reviewCommand.expectedRevision,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              )}
            </details>
          )}
          {activity.result && <Preview label={`${name} result`} preview={activity.result} />}
        </div>
      </details>
      {status === 'review' && onApply && onReject && (
        <div className="tool-actions">
          <button
            className="proposal-apply tool-reject"
            onClick={onReject}
            aria-label={`Reject ${name}`}
          >
            <X size={14} aria-hidden="true" />
            Reject
          </button>
          <button className="proposal-apply" onClick={onApply} aria-label={`Apply ${name}`}>
            <Check size={14} aria-hidden="true" />
            Apply
          </button>
        </div>
      )}
      {activity.error && (
        <div className="message-error" role="status">
          {activity.error}
        </div>
      )}
      {activity.deliveryError && (
        <div className="message-error" role="status">
          {activity.deliveryError}
        </div>
      )}
    </div>
  );
});
