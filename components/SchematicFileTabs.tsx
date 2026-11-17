'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';

export default function SchematicFileTabs({
  files,
  activeId,
  panelId,
  onSelect,
  onClose,
}: {
  files: { id: string; name: string; modified: boolean }[];
  activeId: string;
  panelId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => boolean | Promise<boolean>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [focusRequest]);
  return (
    <div
      ref={root}
      className="schematic-file-tabs"
      role="tablist"
      aria-label="Schematic files"
      onKeyDown={(event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          event.target.getAttribute('role') !== 'tab' ||
          !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const tabs = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        );
        const index = tabs.indexOf(event.target as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
    >
      {files.map((file) => (
        <div
          key={file.id}
          role="presentation"
          className={`file-tab${activeId === file.id ? ' active' : ''}`}
        >
          <button
            type="button"
            role="tab"
            className="file-tab-select"
            aria-selected={activeId === file.id}
            tabIndex={activeId === file.id ? 0 : -1}
            aria-controls={panelId}
            aria-description={file.name}
            aria-label={`${file.name}${file.modified ? ', Unsaved changes' : ''}`}
            onClick={() => onSelect(file.id)}
          >
            <FileText size={15} aria-hidden="true" />
            <span>{file.name}</span>
          </button>
          <span className="file-tab-action">
            {file.modified && <span className="dirty-dot" aria-hidden="true" />}
            <button
              type="button"
              className="file-tab-close"
              tabIndex={activeId === file.id ? 0 : -1}
              aria-label={`Close ${file.name}`}
              title="Close"
              onClick={async () => {
                if (await onClose(file.id)) setFocusRequest((request) => request + 1);
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
