import type { HistoryPage } from './project-history';
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
        { source: string; name: string; native: boolean } | { fileId: string } | null
      >;
      acceptOpen(): Promise<string>;
      newFile(): Promise<string>;
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
      exportKiCad(options: {
        source: string;
        name: string;
        kind?: 'schematic' | 'pcb';
        schematicId?: string;
      }): Promise<{ name: string; path: string; kind?: 'schematic' | 'pcb' } | null>;
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
export async function api(route: string, options: RequestInit = {}) {
  if (!window.openpe) throw new Error('Use the Electron desktop app to connect to local services.');
  connection ??= window.openpe.connection();
  const c = await connection;
  const response = await fetch(c.base + '/api/' + route, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': c.token, ...options.headers },
  });
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
