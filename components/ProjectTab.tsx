'use client';

import { Folder, X } from 'lucide-react';

export default function ProjectTab({
  name,
  modified,
  panelId,
  onClose,
}: {
  name: string;
  modified: boolean;
  panelId: string;
  onClose: () => void;
}) {
  return (
    <div className="project-file-tabs" role="tablist" aria-label="Project">
      <div className="file-tab active" role="presentation">
        <button
          type="button"
          role="tab"
          className="file-tab-select"
          aria-selected="true"
          aria-controls={panelId}
          aria-label={`${name}${modified ? ', Unsaved changes' : ''}`}
          aria-description={name}
        >
          <Folder size={15} aria-hidden="true" />
          <span>{name}</span>
        </button>
        <span className="file-tab-action">
          {modified && <span className="dirty-dot" aria-hidden="true" />}
          <button
            type="button"
            className="file-tab-close"
            aria-label="Close project"
            title="Close"
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  );
}
