const path = require('node:path');

/** Native destination selection is the sole file boundary for mechanical export. */
function createEnclosureExport({ parseProject, createStep, showSaveDialog, atomicWrite }) {
  let pending = false;
  return async (options, ensureCurrent = () => {}) => {
    if (pending) return null;
    pending = true;
    try {
      ensureCurrent();
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => key !== 'source') ||
        typeof options.source !== 'string' ||
        Buffer.byteLength(options.source) > 8_000_000
      )
        throw new Error('Send the validated project source for model STEP export.');
      const project = parseProject(options.source);
      const bytes = await createStep(project);
      ensureCurrent();
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length < 100 ||
        bytes.length > 30_000_000 ||
        !bytes.subarray(0, 100).toString('ascii').includes('ISO-10303-21;') ||
        !bytes.subarray(-100).toString('ascii').includes('END-ISO-10303-21;')
      )
        throw new Error('The model CAD engine did not produce a valid bounded STEP file.');
      const name =
        (String(project.name || 'model')
          .replace(/\.kicad_(?:pro|sch|pcb)$/i, '')
          .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
          .replace(/[. ]+$/, '')
          .slice(0, 160) || 'model') + '-model.step';
      const chosen = await showSaveDialog({
        title: 'Export model STEP',
        buttonLabel: 'Export',
        defaultPath: name,
        filters: [{ name: 'STEP solid model', extensions: ['step', 'stp'] }],
      });
      ensureCurrent();
      if (chosen.canceled || !chosen.filePath) return null;
      const file = path.extname(chosen.filePath) ? chosen.filePath : chosen.filePath + '.step';
      if (!/\.(?:step|stp)$/i.test(file)) throw new Error('Choose a .step or .stp filename.');
      await atomicWrite(file, bytes);
      return { name: path.basename(file) };
    } finally {
      pending = false;
    }
  };
}
module.exports = { createEnclosureExport };
