const path = require('node:path');
const fs = require('node:fs/promises');

async function checkDestination(file) {
  let cursor = path.resolve(file);
  while (true) {
    const info = await fs.lstat(cursor).catch((error) => {
      if (error.code === 'ENOENT' && cursor === file) return null;
      throw error;
    });
    if (
      info?.isSymbolicLink() ||
      (cursor === file && info && !info.isFile()) ||
      (cursor !== file && !info?.isDirectory())
    )
      throw new Error('Choose a regular export file without linked directories.');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function createNativeExport({
  parseProject,
  exportProjectFile,
  projectExportFormats,
  showSaveDialog,
  atomicWrite,
  fileGrants,
}) {
  let pending = false;
  return async (options, isCurrent = () => {}) => {
    if (pending) return null;
    pending = true;
    try {
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => !['source', 'name', 'format'].includes(key)) ||
        typeof options.source !== 'string' ||
        typeof options.name !== 'string' ||
        options.name.length > 200
      )
        throw new Error('Invalid export request.');
      const definition = projectExportFormats.find((entry) => entry.id === options.format);
      if (!definition) throw new Error('Unsupported export format.');
      const project = parseProject(options.source);
      const output = exportProjectFile(project, options.format, options.name);
      isCurrent();
      const result = await showSaveDialog({
        title: 'Export ' + definition.label,
        buttonLabel: 'Export',
        defaultPath: output.name,
        filters: [{ name: definition.label, extensions: [definition.extension] }],
      });
      isCurrent();
      if (result.canceled || !result.filePath) return null;
      if (!path.isAbsolute(result.filePath)) throw new Error('Invalid export destination.');
      const file = path.resolve(
        path.extname(result.filePath)
          ? result.filePath
          : result.filePath + '.' + definition.extension,
      );
      if (path.extname(file).toLowerCase() !== '.' + definition.extension)
        throw new Error('Choose a .' + definition.extension + ' export file.');
      const check = async () => {
        isCurrent();
        if (fileGrants.owners(file).length)
          throw new Error('Export cannot overwrite an open project source.');
        await checkDestination(file);
        isCurrent();
      };
      await check();
      await atomicWrite(file, Buffer.from(output.bytes), check);
      return { name: path.basename(file), format: options.format };
    } finally {
      pending = false;
    }
  };
}

module.exports = { createNativeExport };
