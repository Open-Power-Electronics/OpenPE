import type { KiCadProjectFiles } from './kicad-project';

export type AgentFileChange = { name: string; status: 'added' | 'modified' | 'removed' };
export type AgentFileChanges = {
  files: AgentFileChange[];
  truncated: boolean;
  unavailable?: boolean;
};

/** Compare actual native text, never infer files from a capability's name or arguments. */
export function changedAgentFiles(before: KiCadProjectFiles, after: KiCadProjectFiles) {
  const previous = new Map(before.files.map((file) => [file.name, file]));
  const changes: AgentFileChange[] = [];
  for (const file of after.files) {
    const old = previous.get(file.name);
    if (!old) changes.push({ name: file.name, status: 'added' });
    else if (old.source !== file.source || old.encoding !== file.encoding)
      changes.push({ name: file.name, status: 'modified' });
    previous.delete(file.name);
  }
  for (const name of previous.keys()) changes.push({ name, status: 'removed' });
  return changes;
}

/** Retain only names/status, independently of native buffers and tool previews. */
export function mergeAgentFileChanges(
  summary: AgentFileChanges,
  changes: AgentFileChange[],
): AgentFileChanges {
  const files = new Map(summary.files.map((file) => [file.name, file.status]));
  for (const { name, status } of changes) {
    const old = files.get(name);
    if (old === 'added' && status === 'removed') files.delete(name);
    else
      files.set(
        name,
        old === 'added' ? 'added' : old === 'removed' && status === 'added' ? 'modified' : status,
      );
  }
  return {
    ...summary,
    truncated: summary.truncated || files.size > 256,
    files: [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 256)
      .map(([name, status]) => ({ name, status })),
  };
}
