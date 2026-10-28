// Grant-bound host files; supporting text stays outside native design and Core.
export type ProjectDirectoryEntry = {
  name: string;
  kind: 'directory' | 'file';
  id?: string;
  bytes?: number;
};
export type ProjectDirectoryListing = { entries: ProjectDirectoryEntry[]; truncated: boolean };
export type ProjectFilePreview = {
  source: string;
  encoding?: 'latin1';
  bytes: number;
  binary: boolean;
  truncated: boolean;
  readOnly: boolean;
  pdf?: true;
};
export type ProjectFilePdf = { base64: string; bytes: number };
export type ProjectFileWrite = {
  fileId: string;
  id: string;
  source: string;
  expectedSource: string;
  encoding?: 'latin1';
};
