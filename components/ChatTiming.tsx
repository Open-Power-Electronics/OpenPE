'use client';
import { useEffect, useState } from 'react';
import type { ChatTimings } from '@/lib/chat-stream';

function elapsedTime(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder ? ` ${remainder}s` : ''}`;
}

export function ChatTiming({ timings: t }: { timings: ChatTimings }) {
  if (t.clientTotalMs === undefined || !Number.isFinite(t.clientTotalMs) || t.clientTotalMs < 0)
    return null;
  return (
    <div className="message-timing" aria-label="Elapsed time">
      {elapsedTime(t.clientTotalMs)}
    </div>
  );
}
export function ChatProgress({ status, startedAt }: { status: string; startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () => setElapsed(performance.now() - startedAt);
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <div className="chat-progress">
      <span className="chat-stage-text" role="status">
        {status}
      </span>
      <span className="chat-elapsed" aria-label="Elapsed time">
        {elapsedTime(elapsed)}
      </span>
    </div>
  );
}
