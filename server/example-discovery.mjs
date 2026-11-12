import path from 'node:path';
import { createHash } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import { assertContainedPath, canonicalDirectory } from './host-path.cjs';

const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const privateFolder =
  /^(?:\.|(?:node_modules|spice|thermal|history\.git|cache|simulation-cache)$)|-backups$/i;

async function entries(directory, rooted) {
  await assertContainedPath(rooted, directory, {
    message: 'Example discovery requires a regular, unlinked directory.',
    kind: 'directory',
  });
  const result = [];
  for await (const entry of await opendir(directory)) {
    if (result.length >= 1024) throw new Error('An example directory exceeds 1024 entries.');
    result.push(entry);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Host-owned discovery only. Keys identify files; they are never file paths or grants. */
export async function discoverExamples(root, nativeName, keyPrefix = '', excludedDirectories = []) {
  const rooted = await canonicalDirectory(root, {
    message: 'Example discovery requires a regular, unlinked directory.',
  });
  const top = await entries(root, rooted);
  const excluded = new Set(excludedDirectories.map(normalize));
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
    const projectFiles = native.filter((entry) => /\.kicad_pro$/i.test(entry.name));
    // The ordinary reader owns independent sheets and their primary board. With
    // no .pro, expose each standalone entry through that same reader.
    const schematicFiles = native.filter((entry) => /\.kicad_sch$/i.test(entry.name));
    const candidates = projectFiles.length
      ? projectFiles
      : schematicFiles.length
        ? schematicFiles
        : native;
    for (const file of candidates) {
      if (projects.length >= 256) throw new Error('Example discovery exceeds 256 projects.');
      const relative = directory ? `${directory}/${file.name}` : file.name;
      const digest = createHash('sha256')
        .update(keyPrefix + normalize(relative))
        .digest('hex');
      projects.push({ key: `example:local-${digest}`, directory, filename: file.name });
    }
  };
  inspect(top, '');
  let directories = 0;
  for (const entry of top) {
    const directory = entry.name;
    if (excluded.has(normalize(directory))) continue;
    if (entry.isSymbolicLink()) {
      warnings.push(`Skipped linked example entry: ${directory}`);
      continue;
    }
    if (
      !entry.isDirectory() ||
      privateFolder.test(directory) ||
      !nativeName(`${directory}/project.kicad_pro`)
    )
      continue;
    if (++directories > 128) throw new Error('Example discovery exceeds 128 project directories.');
    let children;
    try {
      children = await entries(path.join(root, directory), rooted);
    } catch (error) {
      warnings.push(`Could not inspect ${directory}: ${error.message}`);
      continue;
    }
    inspect(children, directory);
  }
  return { projects, warnings };
}
