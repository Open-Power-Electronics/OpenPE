const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { preflightNativeProject, writeNativeProject } = require('./native-project.cjs');

function createNativeSave({
  parseProject,
  projectNativeFiles,
  fileGrants,
  exampleRoots = [],
  showSaveDialog,
  prepareModelSources,
  prepareProjectFiles,
  atomicWrite,
}) {
  return async ({ source, name, saveAs, fileId }) => {
    if (typeof source !== 'string') throw new Error('Invalid project.');
    const savedProject = parseProject(source);
    const sourceFile = fileGrants.get(fileId);
    let file = sourceFile && /\.kicad_pro$/i.test(sourceFile) ? sourceFile : null;
    if (!file || saveAs) {
      const result = await showSaveDialog({
        title: 'Save KiCad project',
        buttonLabel: 'Save project',
        defaultPath: `${String(name || savedProject.name || 'project')
          .replace(/\.kicad_(?:pro|sch|pcb)$/i, '')
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.kicad_pro`,
        filters: [{ name: 'KiCad Project', extensions: ['kicad_pro'] }],
      });
      if (result.canceled || !result.filePath) return null;
      file = result.filePath;
      if (!file.toLowerCase().endsWith('.kicad_pro')) file += '.kicad_pro';
      // Existing grants may save their own example. Pickers cannot target any
      // application-owned example folder, including another example's assets.
      if (
        exampleRoots.some((root) => {
          const relative = path.relative(root, file);
          return (
            relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
          );
        })
      )
        throw new Error('Choose a save location outside the bundled example folders.');
    }
    const owner = fileGrants.find(file);
    if (owner && owner !== fileId)
      throw new Error('This file is open in another project. Choose a different filename.');
    const bundle = projectNativeFiles(savedProject, path.basename(file));
    await preflightNativeProject(file, bundle);
    const originalFileCount = bundle.files.length;
    await prepareModelSources?.(savedProject, bundle, file, sourceFile);
    if (bundle.files.length !== originalFileCount) await preflightNativeProject(file, bundle);
    for (const model of savedProject.simulationModels ?? []) {
      const source = bundle.files.find(
        (item) => item.name.toLowerCase() === model.file.toLowerCase(),
      );
      if (
        source &&
        createHash('sha256')
          .update(Buffer.from(source.source, source.encoding ?? 'utf8'))
          .digest('hex') !== model.sha256
      )
        throw new Error(
          `The source for pinned simulation model ${model.id} does not match its verified SHA-256. Restore the original model bytes before saving.`,
        );
    }
    const nativeFiles = bundle.files.map((item) => path.resolve(path.dirname(file), item.name));
    const targets = bundle.files.map((item, index) => ({
      target: nativeFiles[index],
      source: Buffer.from(item.source, item.encoding ?? 'utf8'),
    }));
    const checkOwners = async (only) => {
      if (fileGrants.get(fileId) !== sourceFile)
        throw new Error('The project destination changed. Try saving again.');
      for (const { target, source } of only ? [only] : targets) {
        const shared = fileGrants.owners(target).some((owner) => owner !== fileId);
        if (!shared) continue;
        if (/\.kicad_(?:pro|sch|pcb)$/i.test(target))
          throw new Error(
            'A KiCad project file is open in another project. Choose a different folder.',
          );
        const info = await fs.lstat(target).catch(() => null);
        if (
          !info?.isFile() ||
          info.isSymbolicLink() ||
          info.size !== source.length ||
          !(await fs.readFile(target)).equals(source)
        )
          throw new Error(
            'A shared KiCad source file is open in another project. Close that project before changing the shared file.',
          );
      }
      if (fileGrants.get(fileId) !== sourceFile)
        throw new Error('The project destination changed. Try saving again.');
    };
    await checkOwners();
    await prepareProjectFiles(savedProject, file, sourceFile);
    await checkOwners();
    await writeNativeProject(file, bundle, atomicWrite, checkOwners);
    fileGrants.assign(fileId, file);
    fileGrants.setProjectFiles(fileId, nativeFiles);
    return {
      name: path.basename(file),
      path: file,
      localExample: fileGrants.isLocalExample(fileId),
    };
  };
}

module.exports = { createNativeSave };
