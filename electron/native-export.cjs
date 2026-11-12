const path = require('node:path');
const { assertContainedPath, canonicalDirectory } = require('../server/host-path.cjs');

async function checkDestination(file) {
  const message = 'Choose a regular export file without linked directories.';
  const rooted = await canonicalDirectory(path.dirname(file), { message });
  await assertContainedPath(rooted, file, { message, kind: 'file', allowMissing: true });
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
