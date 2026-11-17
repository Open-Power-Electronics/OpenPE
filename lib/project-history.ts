import type { KiCadProjectFile, KiCadProjectFiles } from './kicad-project';

export type HistoryEntry = { id: string; date: string; message: string };
export type HistoryPage = {
  version: string;
  commits: HistoryEntry[];
  more: boolean;
  needsSave?: boolean;
};
export type HistoryFileChange = {
  name: string;
  kind: 'added' | 'removed' | 'changed';
  before?: KiCadProjectFile;
  after?: KiCadProjectFile;
};

/** Presentation compares the complete current native exports, including retained
 * supporting bytes and encodings. Snapshot internals never become file rows. */
export function compareProjectFiles(
  before: KiCadProjectFiles,
  after: KiCadProjectFiles,
): HistoryFileChange[] {
  const left = new Map(before.files.map((file) => [file.name, file]));
  const right = new Map(after.files.map((file) => [file.name, file]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => {
      const a = left.get(name),
        b = right.get(name);
      if (a && b && a.source === b.source && a.encoding === b.encoding) return [];
      return [
        {
          name,
          kind: !a ? 'added' : !b ? 'removed' : 'changed',
          ...(a ? { before: { ...a } } : {}),
          ...(b ? { after: { ...b } } : {}),
        } satisfies HistoryFileChange,
      ];
    });
}
