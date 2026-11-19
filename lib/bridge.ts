import type { HistoryPage } from './project-history';
import type { ProjectExportFormat } from './export-formats';
import type { Circuit } from './circuit';
export type DiscoveredExample = {
  id: string;
  title: string;
  description: string;
  section: 'project' | 'examples';
};
export type RecentProject = { id: string; title: string; description: string; pinned?: boolean };
export type RawKiCadSelection = { id: string; names: string[] };
export type SpiceModelDeclaration = {
  name: string;
  kind: 'model' | 'subcircuit';
  device?: string;
  pins: string[];
};
export type SpiceModelCatalog = { path: string; models: SpiceModelDeclaration[]; issues: string[] };
import type {
  ProjectDirectoryListing,
  ProjectFilePreview,
  ProjectFilePdf,
  ProjectFileWrite,
} from './project-directory';
declare global {
  interface Window {
    openpe?: {
      readonly titleBarOverlay: boolean;
      readonly titleBarInset: boolean;
      installPlugin(): Promise<{ id: string } | null>;
      connection(): Promise<{ base: string; token: string }>;
      setRawKiCadMode(value: boolean): Promise<void>;
      chooseRawKiCadFiles(): Promise<RawKiCadSelection | null>;
      openLibraryHomepage(site: 'jlceda' | 'easyeda'): Promise<void>;
      cursorCredentialStatus(): Promise<{ configured: boolean; suffix?: string }>;
      cursorCredentialStore(key: string): Promise<{ configured: boolean; suffix?: string }>;
      cursorCredentialRemove(): Promise<{ configured: false }>;
      writeWorkspaceRecovery(content: string | null): Promise<void>;
      open(): Promise<
        | { source: string; name: string; native: boolean; openId: number }
        | { fileId: string }
        | null
      >;
      openRecent(
        id: string,
      ): Promise<
        { source: string; name: string; native: boolean; openId: number } | { fileId: string }
      >;
      listRecent(): Promise<{ initialized: boolean; entries: RecentProject[]; warnings: string[] }>;
      removeRecent(id: string): Promise<void>;
      pinRecent(id: string, pinned: boolean): Promise<void>;
      previewRecent(id: string): Promise<Circuit>;
      onRecentChanged(callback: () => void): () => void;
      acceptOpen(openId: number): Promise<string>;
      newFile(): Promise<string>;
      listExamples(): Promise<{ entries: DiscoveredExample[]; warnings: string[] }>;
      openDefaultExample(key: string): Promise<{
        id: string;
        source: string;
        fileId: string;
        filename: string;
        warning?: string;
      }>;
      releaseFile(fileId: string): Promise<void>;
      revealFile(fileId: string): Promise<{ status: 'revealed' | 'needs-save' }>;
      projectDirectory(fileId: string): Promise<ProjectDirectoryListing>;
      chooseComponentModel(fileId: string): Promise<{ path: string } | null>;
      chooseSpiceModel(
        fileId: string,
        currentLibrary?: string,
      ): Promise<SpiceModelCatalog | null>;
      inspectSpiceModel(
        fileId: string,
        library: string,
      ): Promise<SpiceModelCatalog | null>;
      projectFilePreview(options: { fileId: string; id: string }): Promise<ProjectFilePreview>;
      projectFilePdf(options: { fileId: string; id: string }): Promise<ProjectFilePdf>;
      projectFileWrite(options: ProjectFileWrite): Promise<ProjectFilePreview>;
      setDirty(value: boolean): Promise<void>;
      onCloseRequested(callback: () => void): () => void;
      resolveClose(allow: boolean): Promise<void>;
      historyList(options: { fileId: string; offset?: number }): Promise<HistoryPage>;
      historyRead(options: { fileId: string; id: string }): Promise<string>;
      historyCreate(options: {
        fileId: string;
        source: string;
        message: string;
      }): Promise<{ id: string }>;
      save(options: {
        fileId: string;
        source: string;
        name: string;
        saveAs?: boolean;
      }): Promise<{ name: string; path: string; localExample?: boolean } | null>;
      exportProject(options: {
        source: string;
        name: string;
        format: ProjectExportFormat;
      }): Promise<{ name: string; format: ProjectExportFormat } | null>;
      exportImage(options: {
        dataUrl: string;
        width: number;
        height: number;
        name: string;
      }): Promise<{ name: string } | null>;
      exportEnclosure(options: { source: string }): Promise<{ name: string } | null>;
    };
  }
}
let connection: Promise<{ base: string; token: string }> | undefined;
let browserPreviewToken: Promise<string> | undefined;
const browserPluginEndpoints = new Map([
  ['GET workbench-plugins', 'catalog'],
  ['POST workbench-plugins', 'change'],
  ['POST plugins', 'provider-change'],
  ['GET simulation/status', 'spice-status'],
  ['POST simulation/transient', 'spice-run'],
  ['GET thermal/status', 'thermal-status'],
  ['POST thermal/run', 'thermal-run'],
]);
async function browserPreviewRequest(route: string, options: RequestInit) {
  const unavailable = () => new Error('Use the Electron desktop app to connect to local services.');
  let endpoint: string;
  let body: BodyInit | null | undefined;
  const method = options.method ?? 'GET';
  const plugin = browserPluginEndpoints.get(`${method} ${route}`);
  if (plugin) {
    endpoint = `plugin/${plugin}`;
    body = options.body ?? '{}';
  } else if (method === 'GET' && /^pcb-design\/guide\?document=[a-z][a-z-]{0,50}$/.test(route)) {
    endpoint = `plugin/guide?${route.split('?')[1]}`;
    body = '{}';
  } else if (method === 'GET' && /^plugins\?provider=(codex|claude)(&refresh=true)?$/.test(route)) {
    endpoint = `plugin/provider-list?${route.split('?')[1]}`;
    body = '{}';
  } else if (route === 'model-cad/preview' && options.method === 'POST') {
    endpoint = 'cad';
    body = options.body;
  } else {
    const prefix = route.startsWith('libraries/footprints?')
      ? 'libraries/footprints?'
      : route.startsWith('library-model?')
        ? 'library-model?'
        : route.startsWith('library-price?')
          ? 'library-price?'
          : null;
    if (!prefix || (options.method ?? 'GET') !== 'GET' || options.body !== undefined)
      throw unavailable();
    const query = new URLSearchParams(route.slice(prefix.length));
    const expectedSize = prefix === 'library-price?' ? 3 : prefix === 'library-model?' ? 2 : 1;
    if (!query.has('id') || query.size !== expectedSize) throw unavailable();
    if (prefix === 'library-model?') {
      const index = query.get('index');
      if (index === null || !/^\d{1,2}$/.test(index)) throw unavailable();
      endpoint = 'model';
      body = JSON.stringify({ id: query.get('id'), index: Number(index) });
    } else if (prefix === 'library-price?') {
      if (!query.has('kind') || !query.has('source')) throw unavailable();
      endpoint = 'price';
      body = JSON.stringify({
        id: query.get('id'),
        kind: query.get('kind'),
        source: query.get('source'),
      });
    } else {
      endpoint = 'footprint';
      body = JSON.stringify({ id: query.get('id') });
    }
  }
  options.signal?.throwIfAborted();
  browserPreviewToken ??= fetch('/api/browser-preview/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OpenPE-Browser': 'preview' },
    body: '{}',
    cache: 'no-store',
  })
    .then(async (response) => {
      if (!response.ok)
        throw new Error('Browser preview service is unavailable. Retry the preview.');
      const session = await response.json();
      if (!session || typeof session.token !== 'string' || !/^[0-9a-f]{64}$/.test(session.token))
        throw new Error('Invalid browser preview session.');
      return session.token as string;
    })
    .catch((error: unknown) => {
      browserPreviewToken = undefined;
      throw error;
    });
  const token = await browserPreviewToken;
  options.signal?.throwIfAborted();
  const response = await fetch(`/api/browser-preview/${endpoint}`, {
    ...options,
    method: 'POST',
    body,
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      'X-OpenPE-Browser': 'preview',
      'X-OpenPE-Token': token,
    },
    cache: 'no-store',
  });
  if (response.status === 401) browserPreviewToken = undefined;
  return response;
}
export async function api(route: string, options: RequestInit = {}) {
  let response: Response;
  if (window.openpe) {
    connection ??= window.openpe.connection();
    const c = await connection;
    response = await fetch(c.base + '/api/' + route, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-OpenPE-Token': c.token,
        ...options.headers,
      },
    });
  } else response = await browserPreviewRequest(route, options);
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: `Request failed: ${response.status}` }));
    throw Object.assign(
      new Error(error.error),
      typeof error.code === 'string' && error.code.length <= 128 ? { code: error.code } : {},
    );
  }
  return response;
}

export async function writeWorkspaceRecovery(content: string | null): Promise<void> {
  if (!window.openpe) throw new Error('Use the Electron desktop app to save workspace recovery.');
  await window.openpe.writeWorkspaceRecovery(content);
}
