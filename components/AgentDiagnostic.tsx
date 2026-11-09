'use client';
import { memo } from 'react';
import CopyButton from './CopyButton';

export default memo(function AgentDiagnostic({ text, label }: { text: string; label: string }) {
  return (
    <div className="agent-diagnostic">
      <div className="agent-diagnostic-header">
        <span>{label}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <div
        className="message-error agent-diagnostic-text"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        <span role="status">{text}</span>
      </div>
    </div>
  );
});
