const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeImage, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { FileGrants } = require('./file-grants.cjs');
const { createNativeSave } = require('./native-save.cjs');
const { createNativeExport } = require('./native-export.cjs');
const { createImageExport } = require('./image-export.cjs');
const { createEnclosureExport } = require('./enclosure-export.cjs');
const { readNativeProject } = require('./native-project.cjs');
const { registerWorkspaceRecovery } = require('./workspace-recovery.cjs');
const { registerProjectDirectory } = require('./project-directory.cjs');
const fileGrants = new FileGrants();
let win,
  service,
  history,
  dirty = false,
  closePending = false,
  closeApproved = false;
const inTest = process.env.OPENPE_TEST === '1';
// Set the application data root before Electron applies the product display name.
app.setPath('userData', process.env.OPENPE_DATA_DIR || path.join(app.getPath('appData'), 'OpenPE'));
app.setName('OpenPE');
function trusted(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame)
    throw new Error('Unauthorized window.');
}
// Service modules load while Electron initializes. The ready handler awaits
// this promise, so an import failure still fails desktop startup.
const serviceModules = Promise.all([
  import('../server/index.mjs'),
  import('../server/atomic-write.mjs'),
  import('../server/project-model-files.mjs'),
  import('../server/example-models.mjs'),
  import('../server/project-spice-files.mjs'),
  import('../server/project-thermal-files.mjs'),
  import('../server/project-history.mjs'),
  import('../server/example-projects.mjs'),
  import('../server/example-footprints.mjs'),
  import('../server/project-format.mjs'),
  import('../server/enclosure-step.mjs'),
]);
app.whenReady().then(async () => {
  const [
    { startServer },
    { atomicWrite },
    { readProjectModelFile, writeProjectModelFile, prepareProjectModelFiles },
    { createSimulationModelStore },
    { createProjectSpiceStore },
    { createProjectThermalStore },
    { ProjectHistory },
    { ExampleProjects },
    { prepareExampleFootprints },
    {
      parseProject,
      serializeProject,
      exportKiCad,
      modelCadFromProject,
      exportModelCadScad,
      projectFilename,
      projectFromNativeFiles,
      projectNativeFiles,
    },
    { createEnclosureStep },
  ] = await serviceModules;
  const modelFetcher = (url, options) =>
    net.fetch(url, { ...options, credentials: 'omit', cache: 'no-store' });
  const modelStore = createSimulationModelStore(app.getPath('userData'), modelFetcher);
  history = new ProjectHistory(app.getPath('userData'), fileGrants);
  const exampleProjects = new ExampleProjects(
    app.isPackaged
      ? path.join(process.resourcesPath, 'examples-native')
      : path.join(__dirname, '../examples'),
    fileGrants,
    history,
  );
  let examplePreparation;
  // Example opens join one bounded preparation before granting a file.
  // Home performs no example Git/model checks.
  const prepareExamples = () =>
    (examplePreparation ??= exampleProjects
      .prepare()
      .catch((error) => [`Could not prepare bundled examples. ${error.message}`]));
  service = await startServer({
    dataDir: app.getPath('userData'),
    staticDir: path.join(__dirname, '../out'),
    devOrigin: process.env.OPENPE_DEV_URL,
    libraryRoot: app.isPackaged ? path.join(process.resourcesPath, 'kicad', '10.0.0') : undefined,
    simulationRoot: app.isPackaged
      ? path.join(process.resourcesPath, 'ngspice', '47', 'Spice64')
      : undefined,
    thermalRoot: app.isPackaged ? process.resourcesPath : undefined,
    // Model downloads follow the desktop's system proxy instead of Node's direct HTTP stack.
    simulationModelFetcher: modelFetcher,
    simulationModelFiles: {
      read: (fileId, model) => readProjectModelFile(fileGrants.get(fileId), model),
      write: (fileId, model, bytes) => writeProjectModelFile(fileGrants.get(fileId), model, bytes),
    },
    simulationResultFiles: {
      forProject: (fileId) =>
        fileGrants.get(fileId) ? createProjectSpiceStore(() => fileGrants.get(fileId)) : null,
    },
    thermalResultFiles: {
      forProject: (fileId) =>
        fileGrants.get(fileId) ? createProjectThermalStore(() => fileGrants.get(fileId)) : null,
    },
  });
  win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 740,
    title: 'OpenPE · Electrical Engineering Studio',
    icon: path.join(__dirname, '../out/brand/openpe-window.ico'),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#202020', symbolColor: '#fafafa', height: 30 },
        }
      : {}),
    backgroundColor: '#ffffff',
    show: !inTest,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !inTest,
    },
  });
  Menu.setApplicationMenu(null);
  ipcMain.handle('openpe:connection', (event) => {
    trusted(event);
    return { base: service.base, token: service.token };
  });
  registerWorkspaceRecovery({
    ipcMain,
    authorize: trusted,
    write: service.writeWorkspaceRecovery,
  });
  const projectDirectory = registerProjectDirectory({
    ipcMain,
    authorize: trusted,
    grants: fileGrants,
  });
  // Save destinations come from native pickers or the fixed managed-example grant.
  let pendingFile = null;
  ipcMain.handle('openpe:open', async (event) => {
    trusted(event);
    pendingFile = null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Open KiCad project',
      buttonLabel: 'Open',
      filters: [
        {
          name: 'KiCad Project / Schematic / PCB',
          extensions: ['kicad_pro', 'kicad_sch', 'kicad_pcb'],
        },
      ],
      properties: ['openFile'],
    });
    trusted(event);
    if (result.canceled) return null;
    const file = result.filePaths[0];
    const existing = fileGrants.findOpen(file);
    if (existing) return { fileId: existing };
    const files = await readNativeProject(file);
    const source = serializeProject(projectFromNativeFiles(files));
    const entryFile = path.join(path.dirname(file), files.entry);
    trusted(event);
    const openProject = fileGrants.findOpen(entryFile);
    if (openProject) return { fileId: openProject };
    pendingFile = {
      path: /\.kicad_pro$/i.test(entryFile) ? entryFile : null,
      source: file,
      files: files.files.map((item) => path.resolve(path.dirname(file), item.name)),
    };
    return { source, name: files.entry, native: true };
  });
  ipcMain.handle('openpe:accept-open', (event) => {
    trusted(event);
    if (!pendingFile) throw new Error('No validated file is waiting to open.');
    const fileId = pendingFile.path
      ? fileGrants.create(pendingFile.path)
      : fileGrants.createImport(pendingFile.source);
    try {
      fileGrants.setProjectFiles(fileId, pendingFile.files);
    } catch (error) {
      fileGrants.release(fileId);
      pendingFile = null;
      throw error;
    }
    pendingFile = null;
    return fileId;
  });
  ipcMain.handle('openpe:new', (event) => {
    trusted(event);
    return fileGrants.create();
  });
  ipcMain.handle('openpe:open-default-example', async (event, key) => {
    trusted(event);
    await prepareExamples();
    trusted(event);
    const opened = await exampleProjects.openDefault(key);
    trusted(event);
    return opened;
  });
  ipcMain.handle('openpe:release-file', (event, fileId) => {
    trusted(event);
    projectDirectory.release(fileId);
    fileGrants.release(fileId);
  });
  ipcMain.handle('openpe:reveal-file', async (event, fileId) => {
    trusted(event);
    const file = fileGrants.location(fileId);
    if (!file) return { status: 'needs-save' };
    try {
      await fs.access(file);
    } catch {
      throw new Error('The project file is no longer accessible. Save it again or reopen it.');
    }
    // Recheck after the filesystem await: a close, reload or Save as may revoke/change it.
    if (fileGrants.location(fileId) !== file)
      throw new Error('The project location changed. Try again.');
    if (fileGrants.isLocalExample(fileId)) {
      const error = await shell.openPath(path.dirname(file));
      if (error) throw new Error('Could not open the example folder. Check that it is accessible.');
    } else shell.showItemInFolder(file);
    return { status: 'revealed' };
  });
  ipcMain.handle('openpe:dirty', (event, value) => {
    trusted(event);
    dirty = Boolean(value);
  });
  ipcMain.handle('openpe:history-list', (event, { fileId, offset }) => {
    trusted(event);
    return history.list(fileId, offset);
  });
  ipcMain.handle('openpe:history-read', (event, { fileId, id }) => {
    trusted(event);
    return history.read(fileId, id);
  });
  ipcMain.handle('openpe:history-create', (event, { fileId, source, message }) => {
    trusted(event);
    return history.create(fileId, source, message);
  });
  ipcMain.handle('openpe:resolve-close', (event, allow) => {
    trusted(event);
    // A renderer response can only complete a close already requested by the OS.
    if (!closePending) return;
    closePending = false;
    if (allow === true) {
      closeApproved = true;
      win.close();
    }
  });
  const nativeSave = createNativeSave({
    parseProject,
    projectNativeFiles,
    fileGrants,
    dataDir: app.getPath('userData'),
    showSaveDialog: (options) => dialog.showSaveDialog(win, options),
    prepareProjectFiles: async (project, file, sourceFile) => {
      await prepareExampleFootprints(project, file);
      await prepareProjectModelFiles(
        project,
        file,
        sourceFile,
        modelStore,
        new AbortController().signal,
      );
    },
    atomicWrite,
  });
  ipcMain.handle('openpe:save', (event, options) => {
    trusted(event);
    return nativeSave(options);
  });
  const nativeExport = createNativeExport({
    parseProject,
    exportKiCad,
    modelCadFromProject,
    exportModelCadScad,
    projectFilename,
    preparePCBFiles: prepareExampleFootprints,
    atomicWrite,
    showSaveDialog: (options) => dialog.showSaveDialog(win, options),
  });
  ipcMain.handle('openpe:export', async (event, options) => {
    trusted(event);
    return nativeExport(options);
  });
  const imageExport = createImageExport({
    atomicWrite,
    nativeImage,
    showSaveDialog: (options) => dialog.showSaveDialog(win, options),
  });
  ipcMain.handle('openpe:export-image', async (event, options) => {
    trusted(event);
    return imageExport(options);
  });
  const enclosureExport = createEnclosureExport({
    parseProject,
    atomicWrite,
    createStep: (project) =>
      createEnclosureStep(project, undefined, app.isPackaged ? process.resourcesPath : undefined),
    showSaveDialog: (options) => dialog.showSaveDialog(win, options),
  });
  ipcMain.handle('openpe:export-enclosure', async (event, options) => {
    trusted(event);
    return enclosureExport(options, () => trusted(event));
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const url = process.env.OPENPE_DEV_URL || service.base;
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });
  win.on('close', (event) => {
    if (dirty && !closeApproved) {
      event.preventDefault();
      if (!closePending) {
        closePending = true;
        win.webContents.send('openpe:close-requested');
      }
    }
  });
  win.webContents.on('did-start-navigation', (details) => {
    // Loading activity can belong to a subframe or same-document navigation.
    // Revoke grants only when the renderer document itself is being replaced.
    if (!details.isMainFrame || details.isSameDocument) return;
    closePending = false;
    pendingFile = null;
    fileGrants.clear();
    projectDirectory.clear();
  });
  await win.loadURL(url);
});
app.on('window-all-closed', () => app.quit());
// before-quit may be cancelled by the renderer's unsaved-changes dialog.
app.on('will-quit', () => {
  history?.close();
  service?.close();
});
