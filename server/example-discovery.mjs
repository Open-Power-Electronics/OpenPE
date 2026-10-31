import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';

const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const privateFolder = /^(?:\.|node_modules$|spice$|thermal$|history\.git$)|-backups$/i;

async function entries(directory) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    normalize(await realpath(directory)) !== normalize(path.resolve(directory))
  )
    throw new Error('Example discovery requires a regular, unlinked directory.');
  const result = [];
  for await (const entry of await opendir(directory)) {
    if (result.length >= 1024) throw new Error('An example directory exceeds 1024 entries.');
    result.push(entry);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Host-owned discovery only. Keys identify files; they are never file paths or grants. */
export async function discoverExamples(root, nativeName) {
  const top = await entries(root);
  const projects = [],
    warnings = [];
  const inspect = (items, directory) => {
    const native = items.filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /\.kicad_(?:pro|sch|pcb)$/i.test(entry.name) &&
        nativeName(directory ? `${directory}/${entry.name}` : entry.name),
    );
    const projectsFiles = native.filter((entry) => /\.kicad_pro$/i.test(entry.name));
    // The ordinary reader owns independent sheets and their primary board. With
    // no .pro, expose each standalone entry through that same reader.
    const candidates = projectsFiles.length
      ? projectsFiles
      : native.filter(
          (entry) =>
            /\.kicad_sch$/i.test(entry.name) ||
            !native.some((item) => /\.kicad_sch$/i.test(item.name)),
        );
    for (const file of candidates) {
      if (projects.length >= 256) throw new Error('Example discovery exceeds 256 projects.');
      const relative = directory ? `${directory}/${file.name}` : file.name;
      const digest = createHash('sha256').update(normalize(relative)).digest('hex');
      projects.push({ key: `example:local-${digest}`, directory, filename: file.name });
    }
  };
  inspect(top, '');
  let directories = 0;
  for (const entry of top) {
    if (entry.isSymbolicLink()) {
      warnings.push(`Skipped linked example entry: ${entry.name}`);
      continue;
    }
    if (
      !entry.isDirectory() ||
      privateFolder.test(entry.name) ||
      !nativeName(`${entry.name}/project.kicad_pro`)
    )
      continue;
    if (++directories > 128) throw new Error('Example discovery exceeds 128 project directories.');
    try {
      inspect(await entries(path.join(root, entry.name)), entry.name);
    } catch (error) {
      warnings.push(`Could not inspect ${entry.name}: ${error.message}`);
    }
  }
  return { projects, warnings };
}
