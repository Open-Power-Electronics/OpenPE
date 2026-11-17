'use client';
import { useEffect, useState } from 'react';
import { LoaderCircle, MessageCircleQuestion } from 'lucide-react';
import type { ChatTimings } from '@/lib/chat-stream';

function elapsedTime(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder ? ` ${remainder}s` : ''}`;
}

export function ChatTiming({ timings: t }: { timings?: ChatTimings }) {
  if (t?.clientTotalMs === undefined || !Number.isFinite(t.clientTotalMs) || t.clientTotalMs < 0)
    return null;
  return (
    <span className="message-timing" aria-label="Elapsed time">
      {elapsedTime(t.clientTotalMs)}
    </span>
  );
}
export function ChatLiveTiming({
  startedAt,
  active = true,
}: {
  startedAt: number;
  active?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const update = () => setElapsed(performance.now() - startedAt);
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [startedAt, active]);
  return (
    <span className="message-timing" aria-label="Elapsed time">
      {elapsedTime(elapsed)}
    </span>
  );
}
export function ChatProgress({
  status,
  questionState,
}: {
  status: string;
  questionState?: 'waiting' | 'sending';
}) {
  return (
    <div className="chat-progress">
      {questionState === 'waiting' ? (
        <MessageCircleQuestion size={13} aria-hidden="true" />
      ) : (
        <LoaderCircle size={13} className="spin" aria-hidden="true" />
      )}
      <span className="chat-stage-text" role="status">
        {questionState === 'waiting'
          ? 'Waiting for your answer…'
          : questionState === 'sending'
            ? 'Sending answers…'
            : status}
      </span>
    </div>
  );
}
