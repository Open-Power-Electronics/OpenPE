import type { CapabilityHost } from '../api/capabilities';
import type { ProjectDirectoryListing, ProjectFilePreview } from './project-directory';
import type { ProjectFileDraft } from './project-file-drafts';
import { isAgentRestrictedFile } from './agent-file-policy';

export type ProjectFileGuard = { signal: AbortSignal; check: () => void };
export type ProjectFileAccessPorts = {
  scope: () => string;
  draftRevision: () => number;
  draft: (name: string) => ProjectFileDraft | undefined;
  list: (guard: ProjectFileGuard) => Promise<ProjectDirectoryListing>;
  preview: (id: string, guard: ProjectFileGuard) => Promise<ProjectFilePreview>;
  change: (name: string, source: string, preview: ProjectFilePreview) => void;
  save: (name: string, guard: ProjectFileGuard) => Promise<void>;
  discard: (name: string) => void;
};
export type ProjectFileRead = ProjectFilePreview & {
  name: string;
  pending: boolean;
  fileRevision: string;
};

const textBytes = 1024 * 1024;
const nativeFile = /(?:\.kicad_[^/.]+|(?:^|\/)(?:fp|sym)-lib-table)$/i;

/** Explicit Agent file access preserves the GUI's separate model/log boundary. */
export function projectFileRestriction(name: string): string | undefined {
  if (
    !name ||
    name.length > 1024 ||
    /[\\:\0]/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return 'Choose a relative filename returned by project.files.list.';
  if (nativeFile.test(name))
    return 'Use source.files and source.updateFile for native project files.';
  if (isAgentRestrictedFile(name)) return 'Agent access to model contents and logs is unavailable.';
  return undefined;
}

/** Browser-safe presentation adapter. All writes use the existing GUI draft/save ports. */
export function createProjectFileAccess(ports: ProjectFileAccessPorts) {
  const observations = new Map<
    string,
    {
      name: string;
      scope: string;
      draftRevision: number;
      preview: ProjectFilePreview;
    }
  >();
  const latest = new Map<string, string>();
  const session = crypto.randomUUID();
  let revision = 0;
  function checked(guard: ProjectFileGuard) {
    const scope = ports.scope();
    return {
      signal: guard.signal,
      check() {
        guard.signal.throwIfAborted();
        guard.check();
        if (ports.scope() !== scope)
          throw new Error('The project location changed. Read the file again.');
      },
    };
  }
  function allow(name: string) {
    const reason = projectFileRestriction(name);
    if (reason) throw new Error(reason);
  }
  function view(name: string, preview: ProjectFilePreview): ProjectFileRead {
    const draft = ports.draft(name);
    const fileRevision = `${session}:${++revision}`;
    observations.set(fileRevision, {
      name,
      scope: ports.scope(),
      draftRevision: ports.draftRevision(),
      preview: { ...preview },
    });
    latest.set(name, fileRevision);
    while (observations.size > 64) {
      const oldest = observations.keys().next().value!;
      const entry = observations.get(oldest)!;
      observations.delete(oldest);
      if (latest.get(entry.name) === oldest) latest.delete(entry.name);
    }
    return {
      ...preview,
      name,
      source: draft?.source ?? preview.source,
      ...(draft?.encoding ? { encoding: draft.encoding } : {}),
      pending: !!draft && draft.source !== draft.expectedSource,
      fileRevision,
    };
  }
  function observation(name: string, fileRevision: string, guard: ProjectFileGuard) {
    guard.check();
    allow(name);
    const value = observations.get(fileRevision);
    if (
      !value ||
      latest.get(name) !== fileRevision ||
      value.name !== name ||
      value.scope !== ports.scope() ||
      value.draftRevision !== ports.draftRevision()
    )
      throw new Error('The file or its draft changed. Read the file again before editing.');
    if (value.preview.binary || value.preview.truncated || value.preview.readOnly)
      throw new Error('Only fully loaded ordinary project text files can be edited.');
    return value;
  }
  return {
    async list(guard: ProjectFileGuard) {
      const current = checked(guard);
      current.check();
      const result = await ports.list(current);
      current.check();
      return {
        entries: result.entries.map(({ name, kind, bytes }) => {
          const reason = kind === 'file' ? projectFileRestriction(name) : undefined;
          const draft = ports.draft(name);
          return {
            name,
            kind,
            ...(bytes !== undefined ? { bytes } : {}),
            ...(reason ? { readOnly: true, reason } : {}),
            pending: !!draft && draft.source !== draft.expectedSource,
          };
        }),
        truncated: result.truncated,
      };
    },
    async read(name: string, guard: ProjectFileGuard) {
      const current = checked(guard);
      current.check();
      allow(name);
      const listing = await ports.list(current);
      current.check();
      const entry = listing.entries.find((item) => item.kind === 'file' && item.name === name);
      if (!entry?.id)
        throw new Error('The project file is unavailable. Refresh project.files.list.');
      const preview = await ports.preview(entry.id, current);
      current.check();
      return view(name, preview);
    },
    update(name: string, source: string, fileRevision: string, guard: ProjectFileGuard) {
      const current = checked(guard);
      const value = observation(name, fileRevision, current);
      const encoded = new TextEncoder().encode(source);
      if (
        source.includes('\0') ||
        source.length > textBytes ||
        (value.preview.encoding !== 'latin1' &&
          (encoded.length > textBytes ||
            new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded) !== source)) ||
        (value.preview.encoding === 'latin1' &&
          [...source].some((char) => char.charCodeAt(0) > 255))
      )
        throw new Error('Project text edits require valid text up to 1 MiB.');
      ports.change(name, source, value.preview);
      return view(name, value.preview);
    },
    async save(name: string, fileRevision: string, guard: ProjectFileGuard) {
      const current = checked(guard);
      observation(name, fileRevision, current);
      await ports.save(name, {
        signal: current.signal,
        check() {
          observation(name, fileRevision, current);
        },
      });
      current.check();
      return { name, status: 'saved' as const, pending: !!ports.draft(name) };
    },
    discard(name: string, fileRevision: string, guard: ProjectFileGuard) {
      const current = checked(guard);
      observation(name, fileRevision, current);
      ports.discard(name);
      return { name, status: 'discarded' as const };
    },
  };
}

export type ProjectFileCapabilityPorts = {
  revision: () => string;
  available: (write: boolean) => boolean | string;
  files: ReturnType<typeof createProjectFileAccess>;
};

export function registerProjectFileCapabilities(
  host: CapabilityHost,
  ports: () => ProjectFileCapabilityPorts,
) {
  const name = { type: 'string', minLength: 1, maxLength: 1024 };
  const fileRevision = { type: 'string', minLength: 1, maxLength: 200 };
  const definitions = [
    ['list', 'query', {}, [], false],
    ['read', 'query', { name }, ['name'], false],
    [
      'update',
      'command',
      { name, fileRevision, source: { type: 'string', maxLength: textBytes } },
      ['name', 'fileRevision', 'source'],
      'session',
    ],
    ['save', 'command', { name, fileRevision }, ['name', 'fileRevision'], 'external'],
    ['discard', 'command', { name, fileRevision }, ['name', 'fileRevision'], 'session'],
  ] as const;
  const disposers = definitions.map(([action, kind, properties, required, mutation]) =>
    host.register({
      id: `project.files.${action}`,
      kind,
      owner: 'host',
      mutation,
      review: kind === 'command' ? 'optional' : 'none',
      description: {
        list: 'List bounded project-directory names and metadata, excluding file grants and host paths.',
        read: 'Explicitly read ordinary project text or read-only binary metadata. Native files, model contents and logs are excluded.',
        update:
          'Stage an ordinary project text draft through the same editor path, using a fresh fileRevision.',
        save: 'Save one ordinary text draft through its existing grant and compare-before-write checks.',
        discard: 'Discard one ordinary text draft after checking its observed fileRevision.',
      }[action],
      inputSchema: {
        type: 'object',
        properties,
        required: [...required],
        additionalProperties: false,
      },
      available: () => ports().available(kind === 'command'),
      handler: async (input: any, context) => {
        const original = ports();
        const revision = original.revision();
        const guard = {
          signal: context.signal,
          check() {
            context.signal.throwIfAborted();
            const current = ports();
            const available = current.available(kind === 'command');
            if (available !== true)
              throw new Error(
                typeof available === 'string' ? available : 'Project files are unavailable.',
              );
            if (
              current.files !== original.files ||
              current.revision() !== revision ||
              (context.expectedRevision !== undefined && context.expectedRevision !== revision)
            )
              throw new Error('The project changed while accessing its files. Query it again.');
          },
        };
        guard.check();
        const files = original.files;
        if (action === 'list') return files.list(guard);
        if (action === 'read') return files.read(input.name, guard);
        if (action === 'update')
          return files.update(input.name, input.source, input.fileRevision, guard);
        if (action === 'save') return files.save(input.name, input.fileRevision, guard);
        return files.discard(input.name, input.fileRevision, guard);
      },
    }),
  );
  return () => {
    for (const dispose of disposers) dispose();
  };
}
