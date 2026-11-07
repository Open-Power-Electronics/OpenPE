import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectFromNativeFiles, serializeProject } from './project-format.mjs';
import nativeProject from '../electron/native-project.cjs';
import homeManifest from '../resources/example-catalog/home-manifest.json' with { type: 'json' };
import { discoverExamples } from './example-discovery.mjs';

const { readNativeProject } = nativeProject;
const catalog = [...homeManifest.recent, ...homeManifest.examples];
const defaultExampleId = (key) => {
  const hash = createHash('sha256').update(`openpe-example-v1:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

// Catalog keys resolve only original host-owned example folders. The directory
// grant exposes the same native and supporting files used by ordinary projects.
export class ExampleProjects {
  constructor(
    examplesRoot,
    grants,
    history,
    projectRoot = path.resolve(examplesRoot, '..', 'project'),
  ) {
    if (typeof examplesRoot !== 'string' || !path.isAbsolute(examplesRoot))
      throw new Error('The original example root must be an absolute host directory.');
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot))
      throw new Error('The project root must be an absolute host directory.');
    this.roots = { examples: path.resolve(examplesRoot), project: path.resolve(projectRoot) };
    this.grants = grants;
    this.history = history;
    this.busy = new Map();
    this.catalog = new Map(
      catalog.map((entry) => [
        `example:${entry.id}`,
        {
          id: defaultExampleId(`example:${entry.id}`),
          filename: `${entry.file}.kicad_pro`,
          directory: entry.directory,
          root: entry.root,
        },
      ]),
    );
    this.fixedCatalog = new Map(this.catalog);
  }

  list() {
    if (this.listing) return this.listing;
    this.listing = this.#discover().finally(() => {
      this.listing = undefined;
    });
    return this.listing;
  }

  async #discover() {
    const projects = [],
      warnings = [];
    for (const [root, directory] of Object.entries(this.roots)) {
      try {
        const found = await discoverExamples(
          directory,
          nativeProject.nativeName,
          root === 'project' ? 'project/' : '',
        );
        projects.push(...found.projects.map((project) => ({ ...project, root })));
        warnings.push(...found.warnings);
      } catch (error) {
        if (root === 'examples') throw error;
        warnings.push(`Could not inspect project resources: ${error.message}`);
      }
    }
    if (projects.length > 256) throw new Error('Example discovery exceeds 256 projects.');
    const next = new Map(this.fixedCatalog);
    const entries = projects.map((project) => {
      const fixed = catalog.find(
        (entry) =>
          project.root === entry.root &&
          project.directory === entry.directory &&
          project.filename === `${entry.file}.kicad_pro`,
      );
      const key = fixed ? `example:${fixed.id}` : project.key;
      next.set(key, { ...project, id: defaultExampleId(key) });
      return {
        id: key.slice('example:'.length),
        title: fixed?.title ?? project.filename.replace(/\.kicad_(?:pro|sch|pcb)$/i, ''),
        description: fixed?.description ?? 'Native KiCad project',
        section: project.root,
      };
    });
    this.catalog = next;
    return { entries, warnings };
  }

  async prepare() {
    await this.list();
    const entries = [...this.catalog];
    const warnings = new Array(entries.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, entries.length) }, async () => {
        while (next < entries.length) {
          const index = next++;
          const [key, entry] = entries[index];
          const existing = this.grants.find(
            path.join(this.roots[entry.root], entry.directory, entry.filename),
          );
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
    if (
      typeof key !== 'string' ||
      (!this.fixedCatalog.has(key) && !/^example:local-[a-f0-9]{64}$/.test(key))
    )
      throw new Error('Unknown default example.');
    const pending = this.busy.get(key);
    if (pending) return pending;
    const opening = (async () => {
      if (!this.fixedCatalog.has(key)) await this.list();
      const entry = this.catalog.get(key);
      if (!entry) throw new Error('The example is unavailable. Refresh the examples directory.');
      return this.#openProject(entry);
    })().finally(() => this.busy.delete(key));
    this.busy.set(key, opening);
    return opening;
  }

  async #openProject(entry) {
    const file = path.join(this.roots[entry.root], entry.directory, entry.filename);
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
