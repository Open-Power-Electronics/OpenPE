export type ProjectFileDraft = {
  source: string;
  expectedSource: string;
  encoding?: 'latin1';
};

/** Rebase edits made while an earlier version was being written. */
export function acceptProjectFileSave(
  current: ProjectFileDraft | undefined,
  saved: ProjectFileDraft,
): ProjectFileDraft | undefined {
  if (!current || current.expectedSource !== saved.expectedSource) return current;
  return current.source === saved.source ? undefined : { ...current, expectedSource: saved.source };
}
