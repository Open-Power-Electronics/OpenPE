import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectFromNativeFiles, serializeProject } from './project-format.mjs';
import nativeProject from '../electron/native-project.cjs';
import homeManifest from '../resources/example-catalog/home-manifest.json' with { type: 'json' };

const { readNativeProject } = nativeProject;
const catalog = [...homeManifest.recent, ...homeManifest.examples];
const defaultExampleId = (key) => {
  const hash = createHash('sha256').update(`openpe-example-v1:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

// Catalog keys resolve only original host-owned example folders. The directory
// grant exposes the same native and supporting files used by ordinary projects.
export class ExampleProjects {
  constructor(examplesRoot, grants, history) {
    if (typeof examplesRoot !== 'string' || !path.isAbsolute(examplesRoot))
      throw new Error('The original example root must be an absolute host directory.');
    this.root = path.resolve(examplesRoot);
    this.grants = grants;
    this.history = history;
    this.busy = new Map();
    this.catalog = new Map(
      catalog.map((entry) => [
        `example:${entry.id}`,
        {
          id: defaultExampleId(`example:${entry.id}`),
          filename: `${entry.file}.kicad_pro`,
          directory: entry.file,
        },
      ]),
    );
  }

  async prepare() {
    const entries = [...this.catalog];
    const warnings = new Array(entries.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, entries.length) }, async () => {
        while (next < entries.length) {
          const index = next++;
          const [key, entry] = entries[index];
          const existing = this.grants.find(path.join(this.root, entry.directory, entry.filename));
          try {
            const result = await this.openDefault(key);
            if (!existing) this.grants.release(result.fileId);
            if (result.warning) warnings[index] = result.warning;
          } catch (error) {
            warnings[index] = `Could not prepare ${key}: ${error.message}`;
          }
        }
      }),
    );
    return [...new Set(warnings.filter(Boolean))];
  }

  openDefault(key) {
    if (typeof key !== 'string' || !this.catalog.has(key))
      throw new Error('Unknown default example.');
    const entry = this.catalog.get(key);
    const pending = this.busy.get(key);
    if (pending) return pending;
    const opening = this.#openProject(entry).finally(() => this.busy.delete(key));
    this.busy.set(key, opening);
    return opening;
  }

  async #openProject(entry) {
    const file = path.join(this.root, entry.directory, entry.filename);
    const existingGrant = this.grants.find(file);
    let fileId;
    try {
      fileId = this.grants.create(file);
      const bundle = await readNativeProject(file);
      const source = serializeProject(projectFromNativeFiles(bundle));
      if (this.grants.get(fileId) !== file)
        throw new Error('The example location changed. Reopen the example.');
      this.grants.setProjectFiles(
        fileId,
        bundle.files.map((item) => path.resolve(path.dirname(file), item.name)),
      );
      this.grants.markLocalExample(fileId);
      let warning;
      try {
        await this.history.ensureExampleInitial(fileId, source, false);
      } catch (error) {
        warning = `The example is open, but Git history is unavailable. ${error.message}`;
      }
      if (this.grants.get(fileId) !== file)
        throw new Error('The example location changed. Reopen the example.');
      return { id: entry.id, source, fileId, filename: entry.filename, warning };
    } catch (error) {
      if (fileId && !existingGrant) this.grants.release(fileId);
      throw error;
    }
  }
}
