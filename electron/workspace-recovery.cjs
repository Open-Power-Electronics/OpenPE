// This fixed recovery channel grants no renderer-selected destination or route.
// Main supplies its existing exact-window/main-frame authorization and the
// service's shared HTTP/IPC recovery writer.
function registerWorkspaceRecovery({ ipcMain, authorize, write }) {
  ipcMain.handle('openpe:workspace-recovery-write', (event, content) => {
    authorize(event);
    return write(content);
  });
}

module.exports = { registerWorkspaceRecovery };
