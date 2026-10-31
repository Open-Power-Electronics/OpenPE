import { FilePenLine } from 'lucide-react';
import type { AgentFileChanges as FileChanges } from '@/lib/agent-file-changes';

const labels = { added: 'Added', modified: 'Modified', removed: 'Removed' };

export default function AgentFileChanges({ changes }: { changes: FileChanges }) {
  if (!changes.files.length && !changes.truncated && !changes.unavailable) return null;
  return (
    <div className="agent-file-changes" role="group" aria-label="File changes">
      {changes.files.map((file) => (
        <div className="agent-file-change" key={file.name}>
          <FilePenLine size={14} aria-hidden="true" />
          <span className="agent-file-name">{file.name}</span>
          <span className="agent-file-status">{labels[file.status]}</span>
        </div>
      ))}
      {changes.truncated && <div className="agent-file-note">More files changed</div>}
      {changes.unavailable && <div className="agent-file-note">File changes unavailable</div>}
    </div>
  );
}
