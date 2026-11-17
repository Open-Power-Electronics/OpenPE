const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isUtf8 } = require('node:buffer');
const { nativeName } = require('./native-project.cjs');
const { assertContainedPath, canonicalDirectory } = require('../server/host-path.cjs');
const {
  MAX_MODEL_BYTES,
  spiceModelDeclarations,
} = require('../plugins/spice-simulation/electron/spice-model-declarations.cjs');

const maxEntries = 4096;
const maxDepth = 12;
const previewBytes = 1024 * 1024;
const pdfPreviewBytes = 32 * 1024 * 1024;
const privateEntry = (name) =>
  name.startsWith('.') ||
  /^(?:history\.git|node_modules|cache|simulation-cache)$/i.test(name) ||
  /(?:-backups|\.(?:pem|key|pfx|p12))$/i.test(name);
const normalize = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
const sameFile = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

function createProjectDirectoryReader(grants) {
  const listings = new Map();
  const writing = new Set();
  const location = (fileId) => grants.location(fileId);
  async function regular(directory) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Project folders must be regular directories without links.');
  }
  async function list(fileId) {
    const file = location(fileId);
    // Prune revoked/replaced grants without retaining filesystem authorities.
    for (const [id, previous] of listings) {
      try {
        if (location(id) === previous.file) continue;
      } catch {}
      listings.delete(id);
    }
    if (!file) {
      listings.delete(fileId);
      return { entries: [], truncated: false };
    }
    const root = path.dirname(file);
    const state = { file, paths: new Map() };
    listings.set(fileId, state);
    await regular(root);
    const entries = [];
    let inspected = 0,
      truncated = false;
    async function walk(directory, relative = '', depth = 0) {
      if (listings.get(fileId) !== state || location(fileId) !== file)
        throw new Error('The project location changed. Refresh project files.');
      const children = [];
      for await (const child of await fs.opendir(directory)) {
        if (children.length >= maxEntries - inspected) {
          truncated = true;
          break;
        }
        children.push(child);
      }
      children.sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
      for (const child of children) {
        if (listings.get(fileId) !== state || location(fileId) !== file)
          throw new Error('The project location changed. Refresh project files.');
        if (++inspected > maxEntries) {
          truncated = true;
          break;
        }
        if (privateEntry(child.name)) continue;
        const name = relative ? `${relative}/${child.name}` : child.name;
        if (name.length > 1024) {
          truncated = true;
          continue;
        }
        const absolute = path.join(directory, child.name);
        const stat = await fs.lstat(absolute).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!stat || stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          await regular(absolute);
          entries.push({ name, kind: 'directory' });
          if (depth < maxDepth) await walk(absolute, name, depth + 1);
          else truncated = true;
        } else if (stat.isFile()) {
          if (
            grants.owners(absolute).some((owner) => owner !== fileId) &&
            /\.kicad_(?:pro|sch|pcb)$/i.test(name)
          )
            continue;
          const id = randomUUID();
          state.paths.set(id, { name, stat });
          entries.push({ name, kind: 'file', id, bytes: stat.size });
        }
        if (inspected > maxEntries) break;
      }
    }
    await walk(root);
    if (location(fileId) !== file || listings.get(fileId) !== state)
      throw new Error('The project location changed. Refresh project files.');
    return { entries, truncated };
  }
  async function readBytes(
    fileId,
    id,
    limit = previewBytes,
    complete = false,
    limitError = 'PDF preview supports files up to 32 MiB.',
  ) {
    const state = listings.get(fileId);
    const entry = typeof id === 'string' && state?.paths.get(id);
    if (!entry || location(fileId) !== state.file)
      throw new Error('This file observation expired. Refresh project files.');
    const root = path.dirname(state.file);
    await regular(root);
    let directory = root;
    for (const part of entry.name.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      await regular(directory);
    }
    const target = path.join(root, ...entry.name.split('/'));
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || !sameFile(before, entry.stat))
      throw new Error('The file changed. Refresh project files and select it again.');
    if (complete && before.size > limit) throw new Error(limitError);
    const rooted = await canonicalDirectory(root, {
      message: 'Project folders must be regular directories without links.',
    });
    await assertContainedPath(rooted, target, {
      message: 'Linked project files cannot be previewed.',
      kind: 'file',
    });
    const handle = await fs.open(target, 'r');
    let bytes;
    try {
      if (!sameFile(await handle.stat(), before))
        throw new Error('The file changed. Refresh project files.');
      const buffer = Buffer.alloc(Math.min(limit, before.size));
      let count = 0;
      while (count < buffer.length) {
        const chunk = await handle.read(buffer, count, buffer.length - count, null);
        if (!chunk.bytesRead) break;
        count += chunk.bytesRead;
      }
      bytes = buffer.subarray(0, count);
      const after = await fs.lstat(target);
      if (
        !sameFile(await handle.stat(), before) ||
        !sameFile(after, before) ||
        after.isSymbolicLink()
      )
        throw new Error('The file changed. Refresh project files.');
    } finally {
      await handle.close();
    }
    if (location(fileId) !== state.file || listings.get(fileId) !== state)
      throw new Error('This file observation expired. Refresh project files.');
    if (complete && bytes.length !== before.size)
      throw new Error('The file changed. Refresh project files.');
    return { bytes, before, state, entry };
  }
  async function read(fileId, id) {
    let { bytes, before, state, entry } = await readBytes(fileId, id);
    // A bounded prefix can end inside a UTF-8 code point.
    if (before.size > bytes.length)
      for (let trim = 0; trim <= 3 && trim <= bytes.length; trim++) {
        if (isUtf8(bytes.subarray(0, bytes.length - trim))) {
          bytes = bytes.subarray(0, bytes.length - trim);
          break;
        }
      }
    const utf8 = isUtf8(bytes);
    const latin1Text =
      !utf8 &&
      /\.(?:lib|cir|spice|dcm|txt|log|md|csv|tsv|out|sif|geo)$/i.test(entry.name) &&
      !bytes.some((byte) => byte < 32 && ![9, 10, 12, 13].includes(byte));
    const pdfFile = /\.pdf$/i.test(entry.name);
    const pdfHeader = pdfFile && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
    const pdf = pdfHeader && before.size <= pdfPreviewBytes;
    const binary = pdfFile || bytes.includes(0) || (!utf8 && !latin1Text);
    return {
      source: pdfHeader
        ? `PDF document\nSize: ${before.size} bytes\n${pdf ? '' : 'Preview supports PDF files up to 32 MiB.\n'}`
        : binary
          ? `Binary file\nSize: ${before.size} bytes\n`
          : bytes.toString(latin1Text ? 'latin1' : 'utf8'),
      ...(latin1Text ? { encoding: 'latin1' } : {}),
      ...(pdf ? { pdf: true } : {}),
      bytes: before.size,
      binary,
      truncated: !binary && before.size > bytes.length,
      readOnly: pdfFile || nativeName(entry.name) || grants.get(fileId) !== state.file,
    };
  }
  async function pdf(fileId, id) {
    const state = listings.get(fileId);
    const entry = typeof id === 'string' && state?.paths.get(id);
    if (!entry || location(fileId) !== state.file)
      throw new Error('This file observation expired. Refresh project files.');
    if (!/\.pdf$/i.test(entry.name)) throw new Error('Select a PDF project file.');
    const { bytes } = await readBytes(fileId, id, pdfPreviewBytes, true);
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new Error('This project file does not contain a PDF document.');
    return { base64: bytes.toString('base64'), bytes: bytes.length };
  }
  async function write(options, authorize = () => {}) {
    authorize();
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => !['fileId', 'id', 'source', 'expectedSource', 'encoding'].includes(key),
      ) ||
      typeof options.fileId !== 'string' ||
      typeof options.id !== 'string' ||
      typeof options.source !== 'string' ||
      typeof options.expectedSource !== 'string' ||
      (options.encoding !== undefined && options.encoding !== 'latin1')
    )
      throw new Error('Invalid project text file edit.');
    const { fileId, id, source, expectedSource, encoding } = options;
    if (source.length > previewBytes || expectedSource.length > previewBytes)
      throw new Error('Project text edits require valid text up to 1 MiB.');
    const bytes = Buffer.from(source, encoding ?? 'utf8');
    if (
      source.includes('\0') ||
      expectedSource.includes('\0') ||
      bytes.length > previewBytes ||
      Buffer.byteLength(expectedSource, encoding ?? 'utf8') > previewBytes ||
      bytes.toString(encoding ?? 'utf8') !== source
    )
      throw new Error('Project text edits require valid text up to 1 MiB.');
    const state = listings.get(fileId);
    const entry = state?.paths.get(id);
    const current = () => {
      authorize();
      if (
        !entry ||
        listings.get(fileId) !== state ||
        location(fileId) !== state.file ||
        grants.get(fileId) !== state.file
      )
        throw new Error(
          'This file edit expired. Save or reopen the project and refresh project files.',
        );
    };
    current();
    if (nativeName(entry.name))
      throw new Error('Edit native project files through the validated Source editor.');
    const target = path.join(path.dirname(state.file), ...entry.name.split('/'));
    const key = normalize(target);
    if (writing.has(key)) throw new Error('This project text file is already being saved.');
    writing.add(key);
    const checkOriginal = async () => {
      current();
      const preview = await read(fileId, id);
      current();
      if (preview.readOnly || preview.binary || preview.truncated)
        throw new Error('Only fully loaded project text files can be edited.');
      if (preview.source !== expectedSource || preview.encoding !== encoding)
        throw new Error('The file changed. Refresh project files before saving this draft.');
      return preview;
    };
    let temporary;
    try {
      const previous = await checkOriginal();
      if (source === expectedSource) return previous;
      temporary = path.join(path.dirname(target), `.openpe-source-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      await checkOriginal();
      current();
      await fs.rename(temporary, target);
      temporary = undefined;
      current();
      entry.stat = await fs.lstat(target);
      return await read(fileId, id);
    } finally {
      writing.delete(key);
      if (temporary)
        await fs.unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
  }
  return {
    list,
    read,
    pdf,
    write,
    spice: async (fileId, id) => {
      const { bytes, entry } = await readBytes(
        fileId,
        id,
        MAX_MODEL_BYTES,
        true,
        'Choose a nonempty SPICE library up to 2 MiB.',
      );
      if (!/\.(?:lib|mod|cir|sp|spice)$/i.test(entry.name))
        throw new Error('Select a SPICE model library.');
      return spiceModelDeclarations(bytes);
    },
    release: (id) => listings.delete(id),
    clear: () => listings.clear(),
  };
}

function registerProjectDirectory({ ipcMain, authorize, grants }) {
  const reader = createProjectDirectoryReader(grants);
  ipcMain.handle('openpe:project-directory', async (event, fileId) => {
    authorize(event);
    const file = grants.location(fileId);
    const result = await reader.list(fileId);
    authorize(event);
    if (grants.location(fileId) !== file)
      throw new Error('The project location changed. Refresh project files.');
    return result;
  });
  ipcMain.handle('openpe:project-file-preview', async (event, options) => {
    authorize(event);
    if (!options || Object.keys(options).some((key) => !['fileId', 'id'].includes(key)))
      throw new Error('Invalid project file observation.');
    const file = grants.location(options.fileId);
    const result = await reader.read(options.fileId, options.id);
    authorize(event);
    if (grants.location(options.fileId) !== file)
      throw new Error('The project location changed. Refresh project files.');
    return result;
  });
  ipcMain.handle('openpe:project-file-write', async (event, options) => {
    authorize(event);
    const result = await reader.write(options, () => authorize(event));
    authorize(event);
    return result;
  });
  ipcMain.handle('openpe:project-file-pdf', async (event, options) => {
    authorize(event);
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      typeof options.fileId !== 'string' ||
      typeof options.id !== 'string' ||
      Object.keys(options).some((key) => !['fileId', 'id'].includes(key))
    )
      throw new Error('Invalid project PDF observation.');
    const file = grants.location(options.fileId);
    const result = await reader.pdf(options.fileId, options.id);
    authorize(event);
    if (grants.location(options.fileId) !== file)
      throw new Error('The project location changed. Refresh project files.');
    return result;
  });
  return reader;
}
module.exports = { createProjectDirectoryReader, registerProjectDirectory };
