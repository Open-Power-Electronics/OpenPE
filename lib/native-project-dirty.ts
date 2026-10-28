import { projectNativeFiles, type KiCadProjectFiles } from './kicad-project';
import { parseProject, serializeProject, type Project } from './project';

/** Dirty state follows the native bytes at the current destination, independent
 * of retained import baselines or Save as materialization in private snapshots. */
export function nativeProjectDirty(
  project: Project | null,
  baselineSource: string | null,
  filename: string,
): boolean {
  return createNativeProjectDirtyChecker()(project, baselineSource, filename);
}

/** One checker per workbench. Only its current saved baseline is retained;
 * pointer, selection and repeated edits do not parse the same native files again.
 * Live projects still pass through the owned-project serialization boundary. */
export function createNativeProjectDirtyChecker(): typeof nativeProjectDirty {
  let saved: { source: string; filename: string; files: KiCadProjectFiles } | undefined;
  return (project, baselineSource, filename) => {
    if (saved && (saved.source !== baselineSource || saved.filename !== filename))
      saved = undefined;
    if (!project) saved = undefined;
    if (!project) return false;
    if (baselineSource === null) {
      saved = undefined;
      return true;
    }
    if (serializeProject(project) === baselineSource) {
      if (!saved) {
        try {
          saved = {
            source: baselineSource,
            filename,
            files: projectNativeFiles(project, filename),
          };
        } catch {
          // Exact canonical equality already establishes a clean project. An
          // invalid destination cannot establish a reusable native baseline.
        }
      }
      return false;
    }
    try {
      const current = projectNativeFiles(project, filename);
      if (saved?.source !== baselineSource || saved.filename !== filename)
        saved = {
          source: baselineSource,
          filename,
          files: projectNativeFiles(parseProject(baselineSource), filename),
        };
      const baseline = saved.files;
      if (current.entry !== baseline.entry || current.files.length !== baseline.files.length)
        return true;
      const byName = (a: { name: string }, b: { name: string }) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      const files = [...current.files].sort(byName);
      const savedFiles = [...baseline.files].sort(byName);
      return files.some(
        (file, index) =>
          file.name !== savedFiles[index].name ||
          file.source !== savedFiles[index].source ||
          file.encoding !== savedFiles[index].encoding,
      );
    } catch {
      // An unreadable baseline cannot establish that live work is safely saved.
      return true;
    }
  };
}
