'use client';
import type { ReactNode } from 'react';
import Select from './Select';
import { useWorkspaceDraftStatus } from './WorkspacePresentation';

export type EditorModeActions = {
  onInteraction: () => void;
  onAnnotation: () => void;
  interactionDisabled?: boolean;
  annotationDisabled?: boolean;
};

export default function EditorStatusBar({
  mode,
  modeActions,
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
  modeActions?: EditorModeActions;
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
        {modeActions ? (
          <Select
            label="Editor mode"
            value={mode}
            placeholder={mode}
            icon={<span className="status-dot" aria-hidden="true" />}
            showChevron={false}
            active={active && !hidden}
            options={[
              {
                value: 'Interaction mode',
                label: 'Interaction mode',
                disabled: modeActions.interactionDisabled,
              },
              {
                value: 'Annotation mode',
                label: 'Annotation mode',
                disabled: modeActions.annotationDisabled,
              },
            ]}
            onChange={(value) => {
              if (value === 'Interaction mode') modeActions.onInteraction();
              else if (value === 'Annotation mode') modeActions.onAnnotation();
            }}
          />
        ) : (
          <>
            <span className="status-dot" aria-hidden="true" />
            <span className="status-mode">{mode}</span>
          </>
        )}
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
