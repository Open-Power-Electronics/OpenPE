const { contextBridge, ipcRenderer } = require('electron');
const maxRecoveryCharacters = 96 * 1024 * 1024;
contextBridge.exposeInMainWorld('openpe', {
  titleBarOverlay: process.platform === 'win32',
  connection: () => ipcRenderer.invoke('openpe:connection'),
  writeWorkspaceRecovery: (content) => {
    if (content !== null && (typeof content !== 'string' || content.length > maxRecoveryCharacters))
      return Promise.reject(new Error('Invalid encoded recovery data.'));
    return ipcRenderer.invoke('openpe:workspace-recovery-write', content);
  },
  open: () => ipcRenderer.invoke('openpe:open'),
  acceptOpen: () => ipcRenderer.invoke('openpe:accept-open'),
  newFile: () => ipcRenderer.invoke('openpe:new'),
  openDefaultExample: (key) => ipcRenderer.invoke('openpe:open-default-example', key),
  releaseFile: (fileId) => ipcRenderer.invoke('openpe:release-file', fileId),
  revealFile: (fileId) => ipcRenderer.invoke('openpe:reveal-file', fileId),
  projectDirectory: (fileId) => ipcRenderer.invoke('openpe:project-directory', fileId),
  projectFilePreview: (options) => ipcRenderer.invoke('openpe:project-file-preview', options),
  projectFilePdf: (options) => ipcRenderer.invoke('openpe:project-file-pdf', options),
  projectFileWrite: (options) => ipcRenderer.invoke('openpe:project-file-write', options),
  setDirty: (value) => ipcRenderer.invoke('openpe:dirty', value),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('openpe:close-requested', listener);
    return () => ipcRenderer.removeListener('openpe:close-requested', listener);
  },
  resolveClose: (allow) => ipcRenderer.invoke('openpe:resolve-close', allow),
  save: (options) => ipcRenderer.invoke('openpe:save', options),
  historyList: (options) => ipcRenderer.invoke('openpe:history-list', options),
  historyRead: (options) => ipcRenderer.invoke('openpe:history-read', options),
  historyCreate: (options) => ipcRenderer.invoke('openpe:history-create', options),
  exportKiCad: (options) => ipcRenderer.invoke('openpe:export', options),
  exportImage: (options) => ipcRenderer.invoke('openpe:export-image', options),
  exportEnclosure: (options) => ipcRenderer.invoke('openpe:export-enclosure', options),
});
