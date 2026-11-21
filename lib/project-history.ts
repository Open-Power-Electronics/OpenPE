import {
  projectNativeFiles,
  projectWithNativeFiles,
  type KiCadProjectFile,
  type KiCadProjectFiles,
} from './kicad-project';
import type { Project } from './project';

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

export function sameHistoryFile(a: KiCadProjectFile | undefined, b: KiCadProjectFile | undefined) {
  return a?.source === b?.source && a?.encoding === b?.encoding;
}

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
      if (sameHistoryFile(a, b)) return [];
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

export function restoreHistoryFile(project: Project, version: Project, name: string): Project {
  const source = projectNativeFiles(version).files.find((file) => file.name === name);
  if (!source) throw new Error('The file is not present in the selected version.');
  const current = projectNativeFiles(project);
  const previous = current.files.find((file) => file.name === name);
  if (sameHistoryFile(previous, source)) return project;
  const candidate = projectWithNativeFiles(project, {
    ...current,
    files: previous
      ? current.files.map((file) => (file === previous ? source : file))
      : [...current.files, source],
  });
  const changes = compareProjectFiles(current, projectNativeFiles(candidate));
  if (
    changes.length !== 1 ||
    changes[0].name !== name ||
    !sameHistoryFile(changes[0].after, source)
  )
    throw new Error('Restoring this file would affect other project files.');
  return candidate;
}
