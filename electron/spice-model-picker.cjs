const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_MODEL_BYTES, spiceModelDeclarations } = require('./spice-model-declarations.cjs');

const extensions = ['lib', 'mod', 'cir', 'sp', 'spice'];
const normalize = (file) =>
  process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

function modelPickerDefaultPath(currentLibrary, location) {
  if (currentLibrary === undefined) return location ? path.dirname(location) : undefined;
  if (
    typeof currentLibrary !== 'string' ||
    !currentLibrary.length ||
    currentLibrary.length > 4096 ||
    /[\0\r\n]/.test(currentLibrary) ||
    !extensions.includes(path.extname(currentLibrary).slice(1).toLowerCase()) ||
    /^(?:\\\\|\/\/)/.test(currentLibrary)
  )
    throw new Error('Invalid current SPICE model path.');
  if (path.isAbsolute(currentLibrary)) {
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(currentLibrary))
      throw new Error('Invalid current SPICE model path.');
    return path.resolve(currentLibrary);
  }
  const segments = currentLibrary.split(/[\\/]/);
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'),
    )
  )
    throw new Error('Invalid current SPICE model path.');
  return location ? path.resolve(path.dirname(location), ...segments) : undefined;
}

const sameFile = (before, after) =>
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every(
    (key) => before[key] === after[key],
  );

async function readSpiceModelFile(file, fileSystem = fs) {
  const before = await fileSystem.lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    normalize(await fileSystem.realpath(file)) !== normalize(file)
  )
    throw new Error('Choose a regular SPICE model file without links.');
  if (!before.size || before.size > BigInt(MAX_MODEL_BYTES))
    throw new Error('Choose a nonempty SPICE library up to 2 MiB.');
  const handle = await fileSystem.open(file, 'r');
  try {
    if (!sameFile(before, await handle.stat({ bigint: true })))
      throw new Error('The model file changed. Choose it again.');
    const first = Buffer.alloc(MAX_MODEL_BYTES + 1);
    let length = 0;
    while (length < first.length) {
      const { bytesRead } = await handle.read(first, length, first.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_MODEL_BYTES || BigInt(length) !== before.size)
      throw new Error('The model file changed or exceeds 2 MiB. Choose it again.');
    const verify = Buffer.alloc(length);
    let checked = 0;
    while (checked < length) {
      const { bytesRead } = await handle.read(verify, checked, length - checked, checked);
      if (!bytesRead) break;
      checked += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fileSystem.lstat(file, { bigint: true });
    if (
      checked !== length ||
      !first.subarray(0, length).equals(verify) ||
      !sameFile(before, after) ||
      !sameFile(before, pathAfter) ||
      pathAfter.isSymbolicLink() ||
      normalize(await fileSystem.realpath(file)) !== normalize(file)
    )
      throw new Error('The model file changed. Choose it again.');
    return spiceModelDeclarations(first.subarray(0, length));
  } finally {
    await handle.close();
  }
}

// The native selection authorizes bounded declaration inspection only. No model
// bodies, includes or controls are returned, copied, followed or executed.
function registerSpiceModelPicker({ ipcMain, authorize, grants, dialog, getWindow }) {
  let picking = false;
  ipcMain.handle('openpe:choose-spice-model', async (event, fileId, currentLibrary) => {
    authorize(event);
    const location = grants.location(fileId);
    // A lexical dialog hint grants no access. Only the later native selection
    // authorizes file inspection, even when this hint names an existing model.
    const defaultPath = modelPickerDefaultPath(currentLibrary, location);
    const current = () => {
      authorize(event);
      if (grants.location(fileId) !== location)
        throw new Error('The project location changed. Choose the model again.');
    };
    if (picking) throw new Error('A SPICE model picker is already open.');
    picking = true;
    try {
      const result = await dialog.showOpenDialog(getWindow(), {
        title: 'Choose SPICE model',
        buttonLabel: 'Select model',
        ...(defaultPath ? { defaultPath } : {}),
        filters: [{ name: 'SPICE model', extensions }],
        properties: ['openFile'],
      });
      current();
      if (result.canceled) return null;
      if (!Array.isArray(result.filePaths) || result.filePaths.length !== 1)
        throw new Error('Select one SPICE model file.');
      const file = result.filePaths[0];
      if (
        typeof file !== 'string' ||
        !path.isAbsolute(file) ||
        file.length > 4096 ||
        /[\0\r\n]/.test(file) ||
        !extensions.includes(path.extname(file).slice(1).toLowerCase())
      )
        throw new Error('Select a .lib, .mod, .cir, .sp or .spice model file.');
      const declarations = await readSpiceModelFile(file);
      current();
      // Retain current project model identities when selecting their own
      // circuits file; all other user-selected locations remain absolute.
      const projectCircuits = location && path.join(path.dirname(location), 'circuits');
      return {
        ...declarations,
        path:
          projectCircuits && normalize(path.dirname(file)) === normalize(projectCircuits)
            ? `circuits/${path.basename(file)}`
            : path.resolve(file),
      };
    } finally {
      picking = false;
    }
  });
}

module.exports = { registerSpiceModelPicker, readSpiceModelFile };
