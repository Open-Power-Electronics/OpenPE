/** Native file choice and permission approval precede the application-owned copy. */
function registerPluginInstaller({ ipcMain, dialog, authorize, getWindow, service }) {
  ipcMain.handle('openpe:install-plugin', async (event) => {
    authorize(event);
    const choice = await dialog.showOpenDialog(getWindow(), {
      title: 'Install OpenPE plugin',
      properties: ['openFile'],
      filters: [{ name: 'OpenPE plugin', extensions: ['openpe-plugin'] }],
    });
    if (choice.canceled || choice.filePaths.length !== 1) return null;
    const pkg = await service.previewPluginPackage(choice.filePaths[0]);
    const manifest = pkg.manifest;
    const permission = manifest.permissions.includes('project.read')
      ? 'Read the current project when you or an Agent run its commands.'
      : 'Compute using only the inputs supplied to its commands.';
    const confirmation = await dialog.showMessageBox(getWindow(), {
      type: 'question',
      title: 'Install plugin',
      message: `Install ${manifest.name}?`,
      detail: `${manifest.author}\nVersion ${manifest.version}\n\n${manifest.description}\n\nPermissions: ${permission}\n\nPlugin commands become available to you and your Agents.`,
      buttons: ['Cancel', 'Install'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return null;
    // Install the exact bytes whose permissions were reviewed, never reread the source.
    return service.installPluginPackage(pkg);
  });
}
module.exports = { registerPluginInstaller };
