'use client';
import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';

export default memo(function CopyButton({
  text,
  label,
  className = '',
  snapshot = false,
}: {
  text: string;
  label: string;
  className?: string;
  snapshot?: boolean;
}) {
  const [feedback, setFeedback] = useState<{
    text: string;
    state: 'copied' | 'error';
    snapshot: boolean;
  } | null>(null);
  const [copying, setCopying] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const currentFeedback =
    feedback && (feedback.snapshot || feedback.text === text) ? feedback : null;
  const state = copying ? 'copying' : (currentFeedback?.state ?? 'idle');
  async function copy() {
    if (pending.current || !text) return;
    pending.current = true;
    clearTimeout(timer.current);
    setCopying(true);
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setFeedback({ text, state: 'copied', snapshot });
      timer.current = setTimeout(() => setFeedback(null), 2000);
    } catch {
      if (mounted.current) setFeedback({ text, state: 'error', snapshot });
    } finally {
      pending.current = false;
      if (mounted.current) setCopying(false);
    }
  }
  const Icon = state === 'copied' ? Check : state === 'copying' ? LoaderCircle : Copy;
  return (
    <div className={`copy-action ${className}`} data-state={state}>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        disabled={!text}
        aria-disabled={copying || undefined}
        aria-busy={copying || undefined}
        onClick={() => void copy()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        <Icon size={14} className={copying ? 'spin' : undefined} aria-hidden="true" />
      </button>
      <span role="status">
        {state === 'copying'
          ? 'Copying…'
          : state === 'copied'
            ? currentFeedback?.snapshot
              ? 'Copied snapshot'
              : 'Copied'
            : state === 'error'
              ? 'Could not copy. Try again.'
              : ''}
      </span>
    </div>
  );
});
