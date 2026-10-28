const path = require('node:path');

function createNativeExport({
  parseProject,
  exportKiCad,
  projectFilename,
  showSaveDialog,
  atomicWrite,
  preparePCBFiles = async () => {},
}) {
  let pending = false;
  return async ({ source, name, kind, schematicId }) => {
    if (pending) return null;
    pending = true;
    try {
      if (
        typeof source !== 'string' ||
        (kind !== undefined && !['schematic', 'pcb'].includes(kind))
      )
        throw new Error('Invalid export request.');
      if (schematicId !== undefined && typeof schematicId !== 'string')
        throw new Error('Invalid schematic file.');
      const project = parseProject(source);
      const defaultKind = kind || 'schematic';
      const defaultContent = exportKiCad(project, defaultKind, schematicId);
      const extension = defaultKind === 'pcb' ? 'kicad_pcb' : 'kicad_sch';
      const formats = [
        { name: 'Schematic', extensions: ['kicad_sch'] },
        ...(project.pcb ? [{ name: 'PCB', extensions: ['kicad_pcb'] }] : []),
      ].filter((format) => !kind || format.extensions[0] === extension);
      const result = await showSaveDialog({
        title: 'Export',
        buttonLabel: 'Export',
        defaultPath: projectFilename(
          String(name || 'project').replace(/[<>:"/\\|?*]/g, '_'),
        ).replace(/\.kicad_pro$/i, '.' + extension),
        filters: formats,
      });
      if (result.canceled || !result.filePath) return null;
      const file = path.extname(result.filePath)
        ? result.filePath
        : result.filePath + '.' + extension;
      const chosenExtension = path.extname(file).slice(1).toLowerCase();
      if (!formats.some((format) => format.extensions[0] === chosenExtension))
        throw new Error(
          'Choose a supported export file type: ' +
            formats.map((format) => '.' + format.extensions[0]).join(' or ') +
            '.',
        );
      const selectedKind = chosenExtension === 'kicad_pcb' ? 'pcb' : 'schematic';
      const content =
        selectedKind === defaultKind
          ? defaultContent
          : exportKiCad(project, selectedKind, schematicId);
      if (selectedKind === 'pcb') await preparePCBFiles(project, file);
      await atomicWrite(file, content);
      return { name: path.basename(file), path: file, kind: selectedKind };
    } finally {
      pending = false;
    }
  };
}

module.exports = { createNativeExport };
