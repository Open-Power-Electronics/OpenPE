'use client';
import { memo, useMemo } from 'react';
import { CornerUpLeft, Pencil } from 'lucide-react';
import { responseText } from '@/lib/chat-stream';
import CopyButton from './CopyButton';

export default memo(function AgentMessageActions({
  text,
  role,
  reuseMessageId,
  streaming = false,
  onReuse,
  reuseDisabled = false,
}: {
  text: string;
  role: 'user' | 'assistant';
  reuseMessageId?: string;
  streaming?: boolean;
  onReuse?: (messageId: string) => void;
  reuseDisabled?: boolean;
}) {
  const content = useMemo(() => (role === 'assistant' ? responseText(text) : text), [role, text]);
  if (!content.trim() && !(onReuse && reuseMessageId)) return null;
  const editPrompt = role === 'assistant';
  return (
    <div className="message-actions" data-streaming={streaming || undefined}>
      {content.trim() && (
        <CopyButton
          text={content}
          label={
            streaming
              ? 'Copy response so far'
              : role === 'assistant'
                ? 'Copy response'
                : 'Copy message'
          }
          snapshot={streaming}
        />
      )}
      {onReuse && reuseMessageId && (
        <button
          type="button"
          className="icon-button agent-message-reuse"
          data-edit-prompt={editPrompt || undefined}
          aria-label={editPrompt ? undefined : 'Reuse message'}
          title={editPrompt ? undefined : 'Reuse message'}
          aria-description={
            reuseDisabled
              ? 'Reuse requires an empty draft with no attachments and no pending input delivery.'
              : editPrompt
                ? 'Restore the original prompt and its attachments to the composer for editing.'
                : 'Restore this message and its attachments to the composer for editing.'
          }
          disabled={reuseDisabled}
          onClick={() => onReuse(reuseMessageId)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          {editPrompt ? (
            <>
              <Pencil size={14} aria-hidden="true" />
              Edit original prompt
            </>
          ) : (
            <CornerUpLeft size={14} aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
});
