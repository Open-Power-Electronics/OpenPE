'use client';
import type { AgentAnnotation } from '@/lib/agent-annotations';
import Dialog from './Dialog';
import AnnotationAttachments from './AnnotationAttachments';
import CopyButton from './CopyButton';

export default function AgentQueuedMessagePreview({
  text,
  annotations,
  queued,
  onClose,
}: {
  text: string;
  annotations: AgentAnnotation[];
  queued: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="Queued message"
      className="agent-queue-preview"
      onClose={onClose}
      footer={
        <>
          {text && <CopyButton text={text} label="Copy queued message" />}
          <button
            type="button"
            className="dialog-button"
            onClick={onClose}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
            }}
          >
            Done
          </button>
        </>
      }
    >
      {!queued && (
        <p className="muted" role="status">
          No longer queued
        </p>
      )}
      {text && (
        <div
          className="agent-queue-preview-text"
          role="region"
          aria-label="Queued message text"
          tabIndex={0}
          data-autofocus
        >
          {text}
        </div>
      )}
      {annotations.length > 0 && <AnnotationAttachments annotations={annotations} />}
    </Dialog>
  );
}
