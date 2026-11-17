import { portableExampleModelSource } from '../lib/example-model-paths';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homeExampleNativePath, type HomeExampleId } from '../lib/home-examples';
import {
  projectNativeFiles,
  projectFromNativeFiles,
  parseProject,
  serializeProject,
  validateProject,
  type Project,
} from '../lib/project';
import footprintAssets from '../resources/example-catalog/footprints/manifest.json';
import { prepareExampleFootprints, cleanupExampleLayout } from '../server/example-footprints.mjs';
import { atomicWrite } from '../server/atomic-write.mjs';

export async function writeExampleFile(file: string, source: string | Buffer) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const previous = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!previous?.equals(bytes)) await atomicWrite(file, bytes);
}

// Custom package text belongs to the same native/Source snapshot as the board.
// Logical library IDs stay stable while project-local filenames share its stem.
export async function prepareHomeExampleCustomFootprints(project: Project, id: HomeExampleId) {
  const assigned = new Set(project.pcb?.footprints.map((footprint) => footprint.libraryId));
  const custom = footprintAssets.footprints.filter((entry) => entry.file && assigned.has(entry.id));
  if (!custom.length) return project;
  const prepared = parseProject(serializeProject(project));
  const filename = path.basename(homeExampleNativePath(id));
  const stem = filename.replace(/\.kicad_pro$/, '');
  const native = projectNativeFiles(prepared, filename);
  for (const entry of custom) {
    const bytes = await readFile(path.join('resources/example-catalog/footprints', entry.file!));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error(`Example custom footprint checksum mismatch: ${entry.id}`);
    native.files.push({
      name: `footprints/${stem}.pretty/${path.basename(entry.file!)}`,
      source: portableExampleModelSource(bytes.toString('utf8')),
    });
  }
  const libraries = [...new Set(custom.map((entry) => entry.id.split(':')[0]))].sort();
  native.files.push({
    name: 'fp-lib-table',
    source:
      '(fp_lib_table\n  (version 7)\n' +
      libraries
        .map(
          (library) =>
            `  (lib (name ${JSON.stringify(library)})(type "KiCad")(uri "\${KIPRJMOD}/footprints/${stem}.pretty")(options "")(descr "Project custom packages"))\n`,
        )
        .join('') +
      ')\n',
  });
  prepared.nativeFiles = native;
  validateProject(prepared);
  projectFromNativeFiles(native);
  return prepared;
}

// Build-only publication; both converters use the catalog's directory and stem.
export async function writeHomeExampleNativeFiles(project: Project, id: HomeExampleId) {
  const destination = path.resolve(homeExampleNativePath(id));
  const directory = path.dirname(destination);
  const native = projectNativeFiles(project, path.basename(destination));
  for (const file of native.files) {
    const target = path.join(directory, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeExampleFile(target, Buffer.from(file.source, file.encoding ?? 'utf8'));
  }
  await prepareExampleFootprints(project, destination);
  await cleanupExampleLayout(project, destination, native);
}
