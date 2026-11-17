'use client';
import { lazy, memo, Suspense } from 'react';
import { responseText } from '@/lib/chat-stream';

const AgentMarkdown = lazy(() => import('./AgentMarkdown'));

// Keep mounted Markdown and code scroll state while hidden; revealing uses the latest text.
export default memo(
  function AgentResponse({ text, active }: { text: string; active: boolean }) {
    const plain = <div className="message-text agent-markdown">{responseText(text)}</div>;
    if (!active) return plain;
    return (
      <Suspense fallback={plain}>
        <AgentMarkdown text={text} />
      </Suspense>
    );
  },
  (_previous, next) => !next.active,
);
