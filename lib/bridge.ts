import type { HistoryPage } from './project-history';
import type { ProjectExportFormat } from './export-formats';
import type { Circuit } from './circuit';
export type DiscoveredExample = {
  id: string;
  title: string;
  description: string;
  section: 'project' | 'examples';
};
export type RecentProject = { id: string; title: string; description: string };
export type SpiceModelDeclaration = {
  name: string;
  kind: 'model' | 'subcircuit';
  device?: string;
  pins: string[];
};
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
      connection(): Promise<{ base: string; token: string }>;
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
      ): Promise<{ path: string; models: SpiceModelDeclaration[]; issues: string[] } | null>;
      inspectSpiceModel(
        fileId: string,
        library: string,
      ): Promise<{ path: string; models: SpiceModelDeclaration[]; issues: string[] } | null>;
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
async function browserPreviewRequest(route: string, options: RequestInit) {
  const unavailable = () => new Error('Use the Electron desktop app to connect to local services.');
  let endpoint: string;
  let body: BodyInit | null | undefined;
  if (route === 'model-cad/preview' && options.method === 'POST') {
    endpoint = 'cad';
    body = options.body;
  } else {
    const prefix = route.startsWith('libraries/footprints?')
      ? 'libraries/footprints?'
      : route.startsWith('library-model?')
        ? 'library-model?'
        : null;
    if (!prefix || (options.method ?? 'GET') !== 'GET' || options.body !== undefined)
      throw unavailable();
    const query = new URLSearchParams(route.slice(prefix.length));
    if (!query.has('id') || query.size !== (prefix === 'library-model?' ? 2 : 1))
      throw unavailable();
    if (prefix === 'library-model?') {
      const index = query.get('index');
      if (index === null || !/^\d{1,2}$/.test(index)) throw unavailable();
      endpoint = 'model';
      body = JSON.stringify({ id: query.get('id'), index: Number(index) });
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
