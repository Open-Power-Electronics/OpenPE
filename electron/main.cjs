const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
  nativeImage,
  net,
  safeStorage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const {
  sourceRoots,
  recent: defaultRecent,
} = require('../resources/example-catalog/home-manifest.json');
const { FileGrants } = require('./file-grants.cjs');
const { RecentProjects } = require('./recent-projects.cjs');
const { createNativeSave } = require('./native-save.cjs');
const { createNativeExport } = require('./native-export.cjs');
const { createImageExport } = require('./image-export.cjs');
const { createEnclosureExport } = require('./enclosure-export.cjs');
const { readNativeProject } = require('./native-project.cjs');
const { registerWorkspaceRecovery } = require('./workspace-recovery.cjs');
const { registerProjectDirectory } = require('./project-directory.cjs');
const { registerComponentModelPicker } = require('./component-model-picker.cjs');
const {
  registerSpiceModelPicker,
} = require('../plugins/spice-simulation/electron/spice-model-picker.cjs');
const {
  createCursorCredentialStore,
  registerCursorCredential,
} = require('./cursor-credential.cjs');
const { registerPluginInstaller } = require('./plugin-installer.cjs');
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
function desktopWindowChrome() {
  if (process.platform === 'win32' || process.platform === 'linux')
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#202020', symbolColor: '#fafafa', height: 30 },
    };
  if (process.platform === 'darwin')
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 8 },
    };
  throw new Error(`Unsupported desktop platform ${process.platform}.`);
}
function installDesktopMenu() {
  if (process.platform === 'win32' || process.platform === 'linux') {
    Menu.setApplicationMenu(null);
    return;
  }
  if (process.platform !== 'darwin')
    throw new Error(`Unsupported desktop platform ${process.platform}.`);
  // Edit roles keep text-field editing. Renderer command shortcuts use the same
  // keys when the event reaches the page; Quit uses the window close review.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]),
  );
}
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
  import('../server/manufacturing-format.mjs'),
]);
app.whenReady().then(async () => {
  const [
    { startServer },
    { atomicWrite },
    {
      readProjectModelFile,
      writeProjectModelFile,
      prepareProjectModelFiles,
      prepareBoundTiModelFiles,
      readCachedTiImport,
    },
    { createSimulationModelStore },
    { createProjectSpiceStore },
    { createProjectThermalStore },
    { ProjectHistory },
    { ExampleProjects },
    { prepareExampleFootprints },
    { parseProject, serializeProject, projectFilename, projectFromNativeFiles, projectNativeFiles },
    { createEnclosureStep },
    { exportProjectFile, projectExportFormats },
  ] = await serviceModules;
  const modelFetcher = (url, options) =>
    net.fetch(url, { ...options, credentials: 'omit', cache: 'no-store' });
  const examplesRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'examples-native')
    : path.join(__dirname, '..', sourceRoots.examples);
  const projectRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'project-native')
    : path.join(__dirname, '..', sourceRoots.project);
  const modelStore = createSimulationModelStore(app.getPath('userData'), modelFetcher, projectRoot);
  history = new ProjectHistory(app.getPath('userData'), fileGrants);
  const exampleProjects = new ExampleProjects(examplesRoot, fileGrants, history, projectRoot);
  const defaultRecentProject = defaultRecent[0];
  const recentProjects = new RecentProjects(app.getPath('userData'), atomicWrite, {
    ...defaultRecentProject,
    file: path.join(
      projectRoot,
      defaultRecentProject.directory,
      `${defaultRecentProject.file}.kicad_pro`,
    ),
  });
  const cursorCredentials = createCursorCredentialStore({
    directory: app.getPath('userData'),
    safeStorage,
  });
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
    // Vendor resources follow the desktop's system proxy instead of Node's direct HTTP stack.
    simulationModelFetcher: modelFetcher,
    datasheetFetcher: modelFetcher,
    nextpcbFetcher: modelFetcher,
    jlcpcbFetcher: modelFetcher,
    priceFetcher: modelFetcher,
    libraryModelFetcher: modelFetcher,
    datasheetRoots: { examples: examplesRoot, project: projectRoot },
    simulationProjectRoot: projectRoot,
    componentModelFiles: { resolve: (id) => fileGrants.location(id) },
    simulationModelFiles: {
      location: (fileId) => fileGrants.get(fileId),
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
    cursorCredential: { read: () => cursorCredentials.read() },
  });
  win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 740,
    title: 'OpenPE · Electrical Engineering Studio',
    icon: path.join(__dirname, '../out/brand/openpe-window.ico'),
    ...desktopWindowChrome(),
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
  installDesktopMenu();
  let rawMode = false;
  let nativeRequests = 0;
  let rawPicker = false;
  let rawEpoch = 0;
  const workbenchIpc = {
    handle(channel, handler) {
      ipcMain.handle(channel, async (event, ...args) => {
        trusted(event);
        if (rawMode) throw new Error('This action is unavailable in Raw KiCad mode.');
        ++nativeRequests;
        try {
          return await handler(event, ...args);
        } finally {
          --nativeRequests;
        }
      });
    },
  };
  ipcMain.handle('openpe:connection', (event) => {
    trusted(event);
    return { base: service.base, token: service.token };
  });
  ipcMain.handle('openpe:set-raw-kicad-mode', (event, value) => {
    trusted(event);
    if (typeof value !== 'boolean') throw new Error('Invalid Raw KiCad mode.');
    if (value === rawMode) return;
    if (nativeRequests || rawPicker || (value && closePending))
      throw new Error(
        'Wait for the current native file operation to finish before switching modes.',
      );
    service.setRawKiCadMode(value);
    rawMode = value;
    ++rawEpoch;
  });
  ipcMain.handle('openpe:choose-raw-kicad-files', async (event) => {
    trusted(event);
    if (!rawMode || rawPicker) throw new Error('The Raw KiCad file picker is unavailable.');
    const epoch = rawEpoch;
    rawPicker = true;
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose raw KiCad files',
        buttonLabel: 'Choose files',
        filters: [{ name: 'KiCad files', extensions: service.rawKiCadExtensions }],
        properties: ['openFile', 'multiSelections'],
      });
      trusted(event);
      if (epoch !== rawEpoch) throw new Error('The Raw KiCad mode changed while choosing files.');
      return result.canceled ? null : await service.selectRawKiCadFiles(result.filePaths);
    } finally {
      rawPicker = false;
    }
  });
  workbenchIpc.handle('openpe:open-library-homepage', async (event, site) => {
    trusted(event);
    if (site === 'jlceda') return shell.openExternal('https://lceda.cn/');
    if (site === 'easyeda') return shell.openExternal('https://easyeda.com/');
    throw new Error('Unknown library homepage.');
  });
  registerPluginInstaller({
    ipcMain: workbenchIpc,
    dialog,
    authorize: trusted,
    getWindow: () => win,
    service,
  });
  registerCursorCredential({ ipcMain: workbenchIpc, authorize: trusted, store: cursorCredentials });
  registerWorkspaceRecovery({
    ipcMain: workbenchIpc,
    authorize: trusted,
    write: service.writeWorkspaceRecovery,
  });
  const projectDirectory = registerProjectDirectory({
    ipcMain: workbenchIpc,
    authorize: trusted,
    grants: fileGrants,
  });
  registerComponentModelPicker({
    ipcMain: workbenchIpc,
    dialog,
    getWindow: () => win,
    authorize: trusted,
    grants: fileGrants,
    models: service.componentModels,
  });
  registerSpiceModelPicker({
    ipcMain: workbenchIpc,
    authorize: trusted,
    grants: fileGrants,
    dialog,
    getWindow: () => win,
    readPrepared: (file) => readCachedTiImport(app.getPath('userData'), file),
  });
  // Save destinations come from native pickers or the fixed managed-example grant.
  let pendingFile = null;
  let nextOpenId = 0;
  const rememberRecent = async (file) => {
    await recentProjects.remember(file);
    if (!win.isDestroyed()) win.webContents.send('openpe:recent-changed');
  };
  const openNativeFile = async (event, file) => {
    trusted(event);
    const existing = fileGrants.findOpen(file);
    if (existing) {
      await rememberRecent(fileGrants.location(existing));
      trusted(event);
      // Closing can release the editor while Recent is being written.
      if (fileGrants.findOpen(file) === existing) return { fileId: existing };
    }
    const files = await readNativeProject(file);
    const source = serializeProject(projectFromNativeFiles(files));
    const entryFile = path.join(path.dirname(file), files.entry);
    trusted(event);
    const openProject = fileGrants.findOpen(entryFile);
    if (openProject) {
      await rememberRecent(fileGrants.location(openProject));
      trusted(event);
      if (fileGrants.findOpen(entryFile) === openProject) return { fileId: openProject };
    }
    pendingFile = {
      openId: ++nextOpenId,
      path: /\.kicad_pro$/i.test(entryFile) ? entryFile : null,
      source: entryFile,
      files: files.files.map((item) => path.resolve(path.dirname(file), item.name)),
    };
    return { source, name: files.entry, native: true, openId: pendingFile.openId };
  };
  workbenchIpc.handle('openpe:open', async (event) => {
    trusted(event);
    pendingFile = null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Open KiCad project',
      buttonLabel: 'Open',
      filters: [
        {
          name: 'KiCad Projects and PCB Layouts',
          extensions: ['kicad_pro', 'kicad_pcb'],
        },
      ],
      properties: ['openFile'],
    });
    trusted(event);
    if (result.canceled) return null;
    return openNativeFile(event, result.filePaths[0]);
  });
  workbenchIpc.handle('openpe:open-recent', async (event, id) => {
    trusted(event);
    pendingFile = null;
    const file = await recentProjects.resolve(id);
    return openNativeFile(event, file);
  });
  workbenchIpc.handle('openpe:list-recent', async (event) => {
    trusted(event);
    const result = await recentProjects.list();
    trusted(event);
    return result;
  });
  workbenchIpc.handle('openpe:remove-recent', async (event, id) => {
    trusted(event);
    await recentProjects.remove(id);
    trusted(event);
    win.webContents.send('openpe:recent-changed');
  });
  workbenchIpc.handle('openpe:pin-recent', async (event, id, pinned) => {
    trusted(event);
    await recentProjects.setPinned(id, pinned);
    trusted(event);
    win.webContents.send('openpe:recent-changed');
  });
  let recentPreviewQueue = Promise.resolve();
  const recentPreviews = new Map();
  workbenchIpc.handle('openpe:preview-recent', (event, id) => {
    trusted(event);
    if (typeof id !== 'string' || !/^recent:[a-f0-9]{64}$/.test(id))
      throw new Error('Unknown recent project.');
    if (recentPreviews.has(id)) return recentPreviews.get(id);
    if (recentPreviews.size >= 32) throw new Error('Recent previews are busy. Retry shortly.');
    const preview = recentPreviewQueue.then(async () => {
      trusted(event);
      const file = await recentProjects.resolve(id);
      trusted(event);
      const bundle = await readNativeProject(file);
      const project = projectFromNativeFiles(bundle);
      const circuit = project.schematic;
      if (Buffer.byteLength(JSON.stringify(circuit), 'utf8') > 8_000_000)
        throw new Error('The project preview exceeds 8 MB.');
      if ((await recentProjects.resolve(id)) !== file)
        throw new Error('Recent changed. Refresh the preview.');
      trusted(event);
      return circuit;
    });
    recentPreviews.set(id, preview);
    recentPreviewQueue = preview.catch(() => {}).finally(() => recentPreviews.delete(id));
    return preview;
  });
  workbenchIpc.handle('openpe:accept-open', async (event, openId) => {
    trusted(event);
    if (!pendingFile) throw new Error('No validated file is waiting to open.');
    if (openId !== pendingFile.openId)
      throw new Error('The file opening request changed. Open the intended project again.');
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
    const file = pendingFile.source;
    pendingFile = null;
    await rememberRecent(file);
    trusted(event);
    return fileId;
  });
  workbenchIpc.handle('openpe:new', (event) => {
    trusted(event);
    return fileGrants.create();
  });
  workbenchIpc.handle('openpe:open-default-example', async (event, key) => {
    trusted(event);
    await prepareExamples();
    trusted(event);
    const opened = await exampleProjects.openDefault(key);
    trusted(event);
    await rememberRecent(fileGrants.location(opened.fileId));
    trusted(event);
    return opened;
  });
  workbenchIpc.handle('openpe:list-examples', async (event) => {
    trusted(event);
    const result = await exampleProjects.list();
    trusted(event);
    return result;
  });
  workbenchIpc.handle('openpe:release-file', (event, fileId) => {
    trusted(event);
    projectDirectory.release(fileId);
    fileGrants.release(fileId);
  });
  workbenchIpc.handle('openpe:reveal-file', async (event, fileId) => {
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
  workbenchIpc.handle('openpe:history-list', (event, { fileId, offset }) => {
    trusted(event);
    return history.list(fileId, offset);
  });
  workbenchIpc.handle('openpe:history-read', (event, { fileId, id }) => {
    trusted(event);
    return history.read(fileId, id);
  });
  workbenchIpc.handle('openpe:history-create', (event, { fileId, source, message }) => {
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
    exampleRoots: [examplesRoot, projectRoot],
    showSaveDialog: (options) => dialog.showSaveDialog(win, options),
    prepareModelSources: (project, bundle, file, sourceFile) =>
      prepareBoundTiModelFiles(project, bundle, file, sourceFile, app.getPath('userData')),
    prepareProjectFiles: async (project, file, sourceFile) => {
      await prepareExampleFootprints(project, file);
      await service.componentModels.prepare(project, file, sourceFile);
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
  workbenchIpc.handle('openpe:save', async (event, options) => {
    trusted(event);
    const saved = await nativeSave(options);
    trusted(event);
    if (saved) await rememberRecent(saved.path);
    trusted(event);
    return saved;
  });
  const nativeExport = createNativeExport({
    parseProject,
    exportProjectFile,
    projectExportFormats,
    fileGrants,
    atomicWrite,
    showSaveDialog: (options) => dialog.showSaveDialog(win, options),
  });
  workbenchIpc.handle('openpe:export', async (event, options) => {
    trusted(event);
    return nativeExport(options, () => trusted(event));
  });
  const imageExport = createImageExport({
    atomicWrite,
    nativeImage,
    showSaveDialog: (options) => dialog.showSaveDialog(win, options),
  });
  workbenchIpc.handle('openpe:export-image', async (event, options) => {
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
  workbenchIpc.handle('openpe:export-enclosure', async (event, options) => {
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
    if (rawMode) {
      service.setRawKiCadMode(false);
      rawMode = false;
      ++rawEpoch;
    }
    closePending = false;
    pendingFile = null;
    fileGrants.clear();
    projectDirectory.clear();
  });
  await win.loadURL(url);
});
// One window owns the service, grants and history. The traffic-light close and
// Command+Q both reach this window's close review; the last window then quits
// so a windowless process is not left running.
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  history?.close();
  service?.close();
});
