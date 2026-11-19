function registerComponentModelPicker({ ipcMain, dialog, getWindow, authorize, grants, models }) {
  let picking = false;
  ipcMain.handle('openpe:choose-component-model', async (event, fileId) => {
    authorize(event);
    const location = grants.location(fileId);
    const current = () => {
      authorize(event);
      if (grants.location(fileId) !== location) throw new Error('The project location changed.');
    };
    if (picking) throw new Error('A component model picker is already open.');
    picking = true;
    try {
      const selected = await dialog.showOpenDialog(getWindow(), {
        title: 'Choose component STEP model',
        buttonLabel: 'Select model',
        properties: ['openFile'],
        filters: [{ name: 'STEP model', extensions: ['step', 'stp'] }],
      });
      current();
      if (selected.canceled) return null;
      if (selected.filePaths?.length !== 1) throw new Error('Select one STEP file.');
      const result = await models.importFile(selected.filePaths[0], new AbortController().signal);
      current();
      return result;
    } finally {
      picking = false;
    }
  });
}
module.exports = { registerComponentModelPicker };
