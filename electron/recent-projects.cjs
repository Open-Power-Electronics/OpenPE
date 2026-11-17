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
  constructor(dataDir, atomicWrite, defaultProject) {
    this.directory = dataDir;
    this.file = path.join(dataDir, 'recent-projects.json');
    this.pinsFile = path.join(dataDir, 'recent-pins.json');
    this.defaultProject = defaultProject;
    this.atomicWrite = atomicWrite;
    this.queue = Promise.resolve();
    this.warning = '';
  }

  ordered(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async check(file = this.file) {
    const directory = await fs.lstat(this.directory);
    // The data directory may live under an ancestor symlink. A link at the directory itself is rejected.
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('Recent projects require an unlinked application data directory.');
    try {
      const info = await fs.lstat(file);
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

  async readPins() {
    await this.check(this.pinsFile);
    let content;
    try {
      content = await fs.readFile(this.pinsFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, files: [], defaultPinned: true };
      throw error;
    }
    const data = JSON.parse(content);
    if (
      !data ||
      Object.keys(data).sort().join(',') !== 'defaultPinned,files,version' ||
      data.version !== 1 ||
      typeof data.defaultPinned !== 'boolean' ||
      !Array.isArray(data.files) ||
      data.files.length + Number(data.defaultPinned) > limit ||
      !data.files.every(validFile) ||
      new Set(data.files.map(normalize)).size !== data.files.length ||
      (this.defaultProject &&
        data.files.some((file) => normalize(file) === normalize(this.defaultProject.file)))
    )
      throw new Error('Invalid recent pins file.');
    return data;
  }

  entries(files, pins) {
    const defaultProject = this.defaultProject;
    const pinned = [...pins.files];
    const ordinary = (files ?? []).filter(
      (file) => !pinned.some((item) => normalize(item) === normalize(file)),
    );
    const entries = [...pinned, ...ordinary]
      .filter(
        (file) =>
          !defaultProject ||
          !pins.defaultPinned ||
          normalize(file) !== normalize(defaultProject.file),
      )
      .map((file) => ({
        id: key(file),
        title: path.basename(file),
        description: file,
        pinned: pinned.some((item) => normalize(item) === normalize(file)),
      }));
    if (defaultProject && pins.defaultPinned)
      entries.unshift({
        id: defaultProject.id,
        title: defaultProject.title,
        description: defaultProject.file,
        pinned: true,
      });
    return entries.slice(0, limit);
  }

  updatedHistory(files, pins, file) {
    const candidates = [
      path.resolve(file),
      ...files.filter((item) => normalize(item) !== normalize(file)),
    ];
    let remaining = limit - pins.files.length;
    return candidates.filter(
      (item) =>
        pins.files.some((pinned) => normalize(pinned) === normalize(item)) || remaining-- > 0,
    );
  }

  setPinned(id, pinned) {
    return this.ordered(async () => {
      if (typeof pinned !== 'boolean') throw new Error('Invalid Recent pin state.');
      const files = await this.read();
      const pins = await this.readPins();
      if (this.defaultProject && id === `default:${this.defaultProject.id}`) {
        pins.defaultPinned = pinned;
      } else {
        const entry = this.entries(files, pins).find((entry) => entry.id === id);
        if (!entry || !id.startsWith('recent:'))
          throw new Error('The recent project is no longer listed. Refresh Recent.');
        const file = entry.description;
        if (this.defaultProject && normalize(file) === normalize(this.defaultProject.file)) {
          pins.defaultPinned = pinned;
        } else {
          pins.files = pins.files.filter((item) => normalize(item) !== normalize(file));
          if (pinned) pins.files.push(file);
          else if (entry.pinned) {
            const next = this.updatedHistory(files ?? [], pins, file);
            await this.atomicWrite(this.file, JSON.stringify({ version: 1, files: next }), () =>
              this.check(),
            );
          }
        }
      }
      if (pins.files.length + Number(pins.defaultPinned) > limit)
        throw new Error('Recent supports at most 32 pinned projects.');
      await this.atomicWrite(this.pinsFile, JSON.stringify(pins), () => this.check(this.pinsFile));
      this.warning = '';
    });
  }

  // A history failure must not turn a completed native open/save into a failure.
  remember(file) {
    return this.ordered(async () => {
      try {
        if (!validFile(file)) throw new Error('Invalid recent project location.');
        const files = (await this.read()) ?? [];
        const pins = await this.readPins();
        const next = this.updatedHistory(files, pins, file);
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
      const pins = await this.readPins();
      return {
        initialized: files !== null,
        entries: this.entries(files, pins),
        warnings: this.warning ? [this.warning] : [],
      };
    });
  }

  remove(id) {
    return this.ordered(async () => {
      const files = await this.read();
      const pins = await this.readPins();
      if (
        (this.defaultProject && id === `default:${this.defaultProject.id}` && pins.defaultPinned) ||
        this.entries(files, pins).some((entry) => entry.id === id && entry.pinned)
      )
        throw new Error('Unpin the project before removing it from Recent.');
      if (typeof id !== 'string' || !files?.some((file) => key(file) === id)) {
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
      const entry = this.entries(await this.read(), await this.readPins()).find(
        (item) => item.id === id,
      );
      if (!entry) throw new Error('The recent project is no longer listed. Refresh Recent.');
      return entry.description;
    });
  }
}

module.exports = { RecentProjects };
