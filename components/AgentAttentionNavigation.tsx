'use client';
import { useId } from 'react';
import { ListChecks, MessageCircleQuestion } from 'lucide-react';
import useRetiringConversationControl from './useRetiringConversationControl';

export default function AgentAttentionNavigation({
  kind,
  count,
  active,
  onNavigate,
  onFocusInput,
}: {
  kind: 'review' | 'question';
  count: number;
  active: boolean;
  onNavigate: () => void;
  onFocusInput: () => void;
}) {
  const description = useId();
  const retainButton = useRetiringConversationControl(active, onFocusInput);
  if (!active || !count) return null;
  const review = kind === 'review';
  const Icon = review ? ListChecks : MessageCircleQuestion;
  return (
    <div
      className="agent-attention-navigation"
      role="group"
      aria-label={review ? 'Pending action reviews' : 'Pending questions'}
    >
      <Icon size={16} aria-hidden="true" />
      <span id={description}>
        {count}{' '}
        {review
          ? count === 1
            ? 'action needs review'
            : 'actions need review'
          : count === 1
            ? 'question pending'
            : 'questions pending'}
      </span>
      <button
        ref={retainButton}
        type="button"
        aria-label={review ? 'Review pending actions' : 'Go to pending questions'}
        aria-describedby={description}
        onClick={onNavigate}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        {review ? 'Review' : 'View'}
      </button>
    </div>
  );
}
