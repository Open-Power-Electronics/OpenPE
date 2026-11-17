'use client';
import type { ReactNode } from 'react';
import { useWorkspaceDraftStatus } from './WorkspacePresentation';

export default function EditorStatusBar({
  mode,
  ruleStatus,
  coordinates,
  centerCoordinates = false,
  details,
  center,
  controls,
  actions,
  status,
  className = '',
  hidden = false,
  active = true,
}: {
  mode: string;
  ruleStatus?: ReactNode;
  coordinates?: ReactNode;
  centerCoordinates?: boolean;
  details?: ReactNode;
  center?: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  status?: string;
  className?: string;
  hidden?: boolean;
  active?: boolean;
}) {
  const draftStatus = useWorkspaceDraftStatus(active && !hidden && status === undefined);
  const displayedStatus = status ?? (draftStatus || 'Local draft');
  const coordinateReadout = coordinates && <span className="status-coordinate">{coordinates}</span>;
  const centered = center !== undefined || centerCoordinates;
  const middle = center ?? (centerCoordinates ? coordinateReadout : null);
  const leading = (
    <>
      {ruleStatus}
      {!centerCoordinates && coordinateReadout}
      {details && <span className="status-details">{details}</span>}
    </>
  );
  const trailing = (
    <>
      {controls}
      {displayedStatus && displayedStatus !== 'Draft saved' && (
        <span className="draft-status" aria-description={displayedStatus}>
          {displayedStatus}
        </span>
      )}
      {actions}
    </>
  );
  return (
    <footer
      className={`status-bar ${className}${centered ? ' status-bar-centered' : ''}`}
      hidden={hidden}
      aria-label="Editor status"
      aria-description={mode}
    >
      {centered ? (
        <>
          <div className="status-leading">{leading}</div>
          <span className="status-center">{middle}</span>
          <div className="status-trailing">{trailing}</div>
        </>
      ) : (
        <>
          {leading}
          <span className="editor-spacer" />
          {trailing}
        </>
      )}
    </footer>
  );
}
