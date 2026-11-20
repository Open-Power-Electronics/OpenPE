import Logo from './Logo';
import type { LibrarySearchProgress } from '@/lib/library-search';

export function LoadingProgress({
  label,
  progress: { completed, total },
}: {
  label: string;
  progress: LibrarySearchProgress;
}) {
  return (
    <span className="loading-progress">
      <span className="loading-caption" aria-hidden="true">
        {completed} / {total} loaded
      </span>
      <span
        className="determinate-progress"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
      >
        <span style={{ width: `${(completed / total) * 100}%` }} />
      </span>
    </span>
  );
}

export default function WorkspaceLoading({
  label = 'Loading workspace',
  panel = false,
  progress,
}: {
  label?: string;
  panel?: boolean;
  progress?: LibrarySearchProgress | null;
}) {
  return (
    <div className={panel ? 'panel-loading' : 'loading-screen'} role="status" aria-label={label}>
      <span className="loading-content">
        <span className="loading-mark" aria-hidden="true">
          <Logo size={80} />
          <span className="loading-signal" />
        </span>
        {progress ? (
          <LoadingProgress label={label} progress={progress} />
        ) : (
          <span className="loading-caption" aria-hidden="true">
            Loading...
          </span>
        )}
      </span>
    </div>
  );
}
