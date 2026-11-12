const { randomUUID } = require('node:crypto');
const { canonicalGrantPath } = require('../server/host-path.cjs');
const normalize = canonicalGrantPath;

// Opaque IDs refer only to paths granted by native dialogs in this process.
class FileGrants {
  #files = new Map();
  #imports = new Map();
  #localExamples = new Map();
  #projectFiles = new Map();
  create(file = null) {
    if (file) {
      const existing = this.find(file);
      if (existing) return existing;
    }
    if (this.#files.size >= 12)
      throw new Error('Close a project before opening another (maximum 12).');
    const id = randomUUID();
    this.#files.set(id, file);
    return id;
  }
  find(file) {
    return [...this.#files].find(([, value]) => value && normalize(value) === normalize(file))?.[0];
  }
  findOpen(file) {
    return (
      this.find(file) ??
      [...this.#imports].find(([, value]) => normalize(value) === normalize(file))?.[0] ??
      this.findProjectFile(file)
    );
  }
  findProjectFile(file) {
    const normalized = normalize(file);
    return [...this.#projectFiles].find(([, files]) => files.has(normalized))?.[0];
  }
  owners(file) {
    const normalized = normalize(file);
    const owners = new Set();
    for (const [id, value] of this.#files)
      if (value && normalize(value) === normalized) owners.add(id);
    for (const [id, value] of this.#imports) if (normalize(value) === normalized) owners.add(id);
    for (const [id, files] of this.#projectFiles) if (files.has(normalized)) owners.add(id);
    return [...owners];
  }
  setProjectFiles(id, files) {
    this.get(id);
    if (
      !Array.isArray(files) ||
      files.length > 128 ||
      files.some((file) => typeof file !== 'string')
    )
      throw new Error('Invalid KiCad project file access.');
    for (const file of files) {
      if (/\.kicad_(?:pro|sch|pcb)$/i.test(file) && this.owners(file).some((owner) => owner !== id))
        throw new Error(
          'A KiCad source file belongs to another open project. Close that project first.',
        );
    }
    this.#projectFiles.set(id, new Set(files.map(normalize)));
  }
  createImport(file) {
    const existing = this.findOpen(file);
    if (existing) return existing;
    const id = this.create();
    // An import can be reselected, but its source is never a save destination.
    this.#imports.set(id, file);
    return id;
  }
  get(id) {
    if (typeof id !== 'string' || !this.#files.has(id))
      throw new Error('This project has no file access grant. Reopen it.');
    return this.#files.get(id);
  }
  location(id) {
    // Revealing an imported source never grants permission to overwrite it.
    return this.get(id) ?? this.#imports.get(id) ?? null;
  }
  markLocalExample(id) {
    const file = this.get(id);
    if (!file) throw new Error('The example has no saved location.');
    this.#localExamples.set(id, file);
  }
  isLocalExample(id) {
    const file = this.get(id);
    const original = this.#localExamples.get(id);
    return !!file && !!original && normalize(file) === normalize(original);
  }
  assign(id, file) {
    this.get(id);
    if (this.owners(file).some((owner) => owner !== id))
      throw new Error('This file is open in another project. Choose a different filename.');
    this.#files.set(id, file);
    this.#projectFiles.delete(id);
  }
  release(id) {
    if (typeof id !== 'string') throw new Error('Invalid file access grant.');
    // Cleanup may be retried or arrive after navigation revoked the grant.
    // Unlike get/assign, releasing an absent ID cannot grant filesystem access.
    this.#files.delete(id);
    this.#imports.delete(id);
    this.#localExamples.delete(id);
    this.#projectFiles.delete(id);
  }
  clear() {
    this.#files.clear();
    this.#imports.clear();
    this.#localExamples.clear();
    this.#projectFiles.clear();
  }
}
module.exports = { FileGrants };
