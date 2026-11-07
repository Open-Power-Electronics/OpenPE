const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const limit = 32;
const normalize = (file) =>
  process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const validFile = (file) =>
  typeof file === 'string' &&
  file.length <= 4096 &&
  !/[\x00-\x1f]/.test(file) &&
  path.isAbsolute(file) &&
  /\.kicad_(?:pro|sch|pcb)$/i.test(file);
const key = (file) => `recent:${createHash('sha256').update(normalize(file)).digest('hex')}`;

// Paths come only from successful native opens/saves, never renderer arguments.
// This private index stores no grants, document contents or workspace recovery.
class RecentProjects {
  constructor(dataDir, atomicWrite) {
    this.directory = dataDir;
    this.file = path.join(dataDir, 'recent-projects.json');
    this.atomicWrite = atomicWrite;
    this.queue = Promise.resolve();
    this.warning = '';
  }

  ordered(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async check() {
    const directory = await fs.lstat(this.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      normalize(await fs.realpath(this.directory)) !== normalize(this.directory)
    )
      throw new Error('Recent projects require an unlinked application data directory.');
    try {
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
        throw new Error('Invalid recent projects file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async read() {
    await this.check();
    let content;
    try {
      content = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const data = JSON.parse(content);
    if (
      !data ||
      Object.keys(data).sort().join(',') !== 'files,version' ||
      data.version !== 1 ||
      !Array.isArray(data.files) ||
      data.files.length > limit ||
      !data.files.every(validFile) ||
      new Set(data.files.map(normalize)).size !== data.files.length
    )
      throw new Error('Invalid recent projects file.');
    return data.files;
  }

  // A history failure must not turn a completed native open/save into a failure.
  remember(file) {
    return this.ordered(async () => {
      try {
        if (!validFile(file)) throw new Error('Invalid recent project location.');
        const files = (await this.read()) ?? [];
        const next = [
          path.resolve(file),
          ...files.filter((item) => normalize(item) !== normalize(file)),
        ].slice(0, limit);
        await this.atomicWrite(this.file, JSON.stringify({ version: 1, files: next }), () =>
          this.check(),
        );
        this.warning = '';
      } catch (error) {
        this.warning = `Could not update Recent: ${error.message}`;
      }
    });
  }

  list() {
    return this.ordered(async () => {
      const files = await this.read();
      return {
        initialized: files !== null,
        entries: (files ?? []).map((file) => ({
          id: key(file),
          title: path.basename(file),
          description: file,
        })),
        warnings: this.warning ? [this.warning] : [],
      };
    });
  }

  remove(id) {
    return this.ordered(async () => {
      const files = await this.read();
      if (id === 'default:emc-flyback-demo') {
        if (files !== null) throw new Error('Recent changed. Refresh the list.');
      } else if (typeof id !== 'string' || !files?.some((file) => key(file) === id)) {
        throw new Error('The recent project is no longer listed. Refresh Recent.');
      }
      const next = (files ?? []).filter((file) => key(file) !== id);
      await this.atomicWrite(this.file, JSON.stringify({ version: 1, files: next }), () =>
        this.check(),
      );
      this.warning = '';
    });
  }

  resolve(id) {
    return this.ordered(async () => {
      if (typeof id !== 'string' || !/^recent:[a-f0-9]{64}$/.test(id))
        throw new Error('Unknown recent project.');
      const file = ((await this.read()) ?? []).find((item) => key(item) === id);
      if (!file) throw new Error('The recent project is no longer listed. Refresh Recent.');
      return file;
    });
  }
}

module.exports = { RecentProjects };
