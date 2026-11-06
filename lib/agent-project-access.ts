import type { Project } from './project';
import type { KiCadProjectFiles } from './kicad-project';
import { isAgentRestrictedFile } from './agent-file-policy';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const denied = () => new Error('Agent access to model contents and logs is unavailable.');
type SourceState = { project: Project | null; sourceDraft: string | null };

/** Native backing is optional in the canonical document, and stays host-owned. */
export function agentProject<T>(project: T): T {
  if (!record(project)) return project;
  const { nativeFiles: _nativeFiles, ...visible } = project;
  return visible as T;
}

export function agentProjectSource(source: string): string {
  return source ? JSON.stringify(agentProject(JSON.parse(source))) : source;
}

export function agentNativeFiles(bundle: KiCadProjectFiles): KiCadProjectFiles {
  return { ...bundle, files: bundle.files.filter((file) => !isAgentRestrictedFile(file.name)) };
}

/** Project/source results have a small set of explicit envelopes; no recursive
 * string inspection or changes to accepted Core data are involved. */
export function agentCoreResult(value: unknown): unknown {
  if (typeof value === 'string') return agentProjectSource(value);
  if (!record(value)) return value;
  if (value.format === 'openpe') return agentProject(value);
  if (typeof value.entry === 'string' && Array.isArray(value.files))
    return agentNativeFiles(value as KiCadProjectFiles);
  const result = { ...value };
  if ('project' in result) result.project = agentProject(result.project);
  if (typeof result.source === 'string') result.source = agentProjectSource(result.source);
  if ('sourceDraft' in result) {
    result.sourcePending = result.sourceDraft !== null;
    result.draftCharacters = typeof result.sourceDraft === 'string' ? result.sourceDraft.length : 0;
    result.sourceDraft = null;
  }
  if (result.sourceError)
    result.sourceError = 'Source validation failed. Review the Source editor.';
  return result;
}

function nativeBundle(value: unknown): KiCadProjectFiles | undefined {
  if (!record(value) || typeof value.entry !== 'string' || !Array.isArray(value.files)) return;
  if (
    !value.files.every(
      (file) => record(file) && typeof file.name === 'string' && typeof file.source === 'string',
    )
  )
    return;
  return value as KiCadProjectFiles;
}

function draftBundle(draft: unknown): KiCadProjectFiles | undefined {
  return nativeBundle(record(draft) && draft.format === 'openpe' ? draft.nativeFiles : draft);
}

/** Host commands which apply Source use this same guard before starting. */
export function assertAgentSourceDraftSafe({ project, sourceDraft }: SourceState): void {
  if (sourceDraft === null) return;
  let draft: unknown;
  try {
    draft = JSON.parse(sourceDraft);
  } catch {
    throw new Error('Review the invalid Source draft in the editor before continuing.');
  }
  const protectedFiles = (files: KiCadProjectFiles | undefined) =>
    (files?.files ?? []).filter((file) => isAgentRestrictedFile(file.name));
  const accepted = protectedFiles(project?.nativeFiles);
  const pending = protectedFiles(draftBundle(draft));
  if (
    accepted.length !== pending.length ||
    accepted.some(
      (file) =>
        !pending.some(
          (other) =>
            other.name === file.name &&
            other.source === file.source &&
            other.encoding === file.encoding,
        ),
    )
  )
    throw new Error('Review model or log Source edits in the editor before continuing.');
}

function preserveNativeBacking(incoming: unknown, current: Project | null): unknown {
  if (!record(incoming)) return incoming;
  const canonical = incoming.format === 'openpe';
  const supplied = canonical ? incoming.nativeFiles : incoming;
  const explicit = 'nativeFiles' in incoming ? incoming.nativeFiles : incoming;
  const bundle = nativeBundle(supplied);
  // Reject every explicitly supplied protected entry, including malformed ones.
  if (
    record(explicit) &&
    Array.isArray(explicit.files) &&
    explicit.files.some(
      (file) => record(file) && typeof file.name === 'string' && isAgentRestrictedFile(file.name),
    )
  )
    throw denied();
  const retained = current?.nativeFiles;
  if (canonical && supplied === undefined && retained)
    return { ...incoming, nativeFiles: structuredClone(retained) };
  if (!retained?.files.some((file) => isAgentRestrictedFile(file.name))) return incoming;
  if (!bundle) return incoming; // The ordinary current-format validator rejects malformed data.
  if (new Set(bundle.files.map((file) => file.name)).size !== bundle.files.length)
    throw new Error('Native Source filenames must be unique.');
  const remaining = new Map(bundle.files.map((file) => [file.name, file]));
  const files = retained.files.flatMap((file) => {
    if (isAgentRestrictedFile(file.name)) return [{ ...file }];
    const next = remaining.get(file.name);
    remaining.delete(file.name);
    return next ? [next] : [];
  });
  files.push(...remaining.values());
  const merged = { ...bundle, files };
  return canonical ? { ...incoming, nativeFiles: merged } : merged;
}

/** Agent-authored document text cannot introduce resource bodies. Existing
 * protected native bytes are copied from accepted Core state, never from input. */
export function prepareAgentCoreInput(id: string, input: unknown, state: SourceState): unknown {
  if (['source.update', 'source.updateFile', 'source.apply', 'source.discard'].includes(id))
    assertAgentSourceDraftSafe(state);
  if (!record(input)) return input;
  if (
    id === 'source.updateFile' &&
    typeof input.name === 'string' &&
    isAgentRestrictedFile(input.name)
  )
    throw denied();
  const field =
    id === 'source.update'
      ? 'draft'
      : ['project.replace', 'schematic.paste'].includes(id)
        ? 'source'
        : undefined;
  if (!field || typeof input[field] !== 'string') return input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input[field]);
  } catch {
    if (id === 'source.update')
      throw new Error('Use source.updateFile to edit native Source text.');
    throw new Error('Provide a valid canonical project JSON document.');
  }
  if (
    id === 'source.update' &&
    (!record(parsed) ||
      (parsed.format !== 'openpe' &&
        !(typeof parsed.entry === 'string' && Array.isArray(parsed.files))))
  )
    throw new Error('Use canonical project JSON or source.updateFile to edit native Source text.');
  const merged = preserveNativeBacking(parsed, id === 'schematic.paste' ? null : state.project);
  return { ...input, [field]: JSON.stringify(merged) };
}
