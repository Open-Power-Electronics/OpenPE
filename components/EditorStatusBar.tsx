'use client';
import type { ReactNode } from 'react';
import { useWorkspaceDraftStatus } from './WorkspacePresentation';

export default function EditorStatusBar({
  mode,
  coordinates,
  details,
  controls,
  actions,
  status,
  className = '',
  hidden = false,
  active = true,
}: {
  mode: string;
  coordinates?: ReactNode;
  details?: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  status?: string;
  className?: string;
  hidden?: boolean;
  active?: boolean;
}) {
  const draftStatus = useWorkspaceDraftStatus(active && !hidden && status === undefined);
  const displayedStatus = status ?? (draftStatus || 'Local draft');
  return (
    <footer className={`status-bar ${className}`} hidden={hidden} aria-label="Editor status">
      <span className="tool-status" aria-description={mode}>
        <span className="status-dot" aria-hidden="true" />
        <span className="status-mode">{mode}</span>
      </span>
      {coordinates && <span className="status-coordinate">{coordinates}</span>}
      {details && <span className="status-details">{details}</span>}
      <span className="editor-spacer" />
      {controls}
      {displayedStatus && displayedStatus !== 'Draft saved' && (
        <span className="draft-status" aria-description={displayedStatus}>
          {displayedStatus}
        </span>
      )}
      {actions}
    </footer>
  );
}
