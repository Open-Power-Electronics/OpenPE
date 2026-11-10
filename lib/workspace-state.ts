import { importDocument, projectFilename, projectSchematics } from './project';
import { restoreSessions, type ChatSession } from './chat-sessions';
import type { ReasoningEffort } from './chat-stream';
import { validExampleKey } from './workspace-example';
import {
  agentProviderIds,
  defaultReasoningEffort,
  isAgentProvider,
  isReasoningEffort,
} from './agent-providers';

export const maxOpenProjects = 12;
export type AgentPreferences = {
  provider: string;
  effort: ReasoningEffort;
  approvalMode: 'review' | 'auto';
  models: Record<string, string>;
};
export const defaultAgentPreferences: AgentPreferences = {
  provider: 'codex',
  effort: defaultReasoningEffort,
  approvalMode: 'review',
  models: Object.fromEntries(agentProviderIds.map((id) => [id, ''])),
};
export type DocumentState = {
  id: string;
  pinned?: true;
  source: string;
  sourceDraft: string | null;
  dirty: boolean;
  filename: string;
  sessions: ChatSession[];
  activeSessionId: string;
  activeSchematicId?: string;
  closedSchematicIds?: string[];
  exampleKey?: string | null;
  localExample?: boolean;
};
export type WorkspaceState = AgentPreferences & {
  version: 2;
  documents: DocumentState[];
  activeDocumentId: string | null;
};
const workspaceFields = new Set<keyof WorkspaceState>([
  'version',
  'documents',
  'activeDocumentId',
  'provider',
  'effort',
  'approvalMode',
  'models',
]);
const documentFields = new Set<keyof DocumentState>([
  'id',
  'pinned',
  'source',
  'sourceDraft',
  'dirty',
  'filename',
  'sessions',
  'activeSessionId',
  'activeSchematicId',
  'closedSchematicIds',
  'exampleKey',
  'localExample',
]);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid workspace state.');
  return value as Record<string, unknown>;
};

type RecoveryProjectSummary = Readonly<{
  schematicIds: readonly string[];
  primarySchematicId: string;
}>;
// Recovery posts often change only a conversation or pending draft. Reuse only
// metadata from successful imports of exactly the same source; envelope, draft
// and session validation still runs on every post. No mutable Project is retained.
const recoveryProjectSummaries = new Map<string, RecoveryProjectSummary>();
const maxRecoveryProjectSummaries = maxOpenProjects * 2;
// Bound retained keys to eight million UTF-16 characters (about 16 MiB), as well
// as the entry count. Oversized individual keys are validated without retention.
const maxRecoverySourceCharacters = 8_000_000;
let recoverySourceCharacters = 0;
function recoveryProjectSummary(source: string): RecoveryProjectSummary {
  const cached = recoveryProjectSummaries.get(source);
  if (cached) {
    recoveryProjectSummaries.delete(source);
    recoveryProjectSummaries.set(source, cached);
    return cached;
  }
  const project = importDocument(source);
  const summary = Object.freeze({
    schematicIds: Object.freeze(projectSchematics(project).map((file) => file.id)),
    primarySchematicId: project.schematic.id,
  });
  if (source.length > maxRecoverySourceCharacters) return summary;
  recoveryProjectSummaries.set(source, summary);
  recoverySourceCharacters += source.length;
  while (
    recoveryProjectSummaries.size > maxRecoveryProjectSummaries ||
    recoverySourceCharacters > maxRecoverySourceCharacters
  ) {
    const oldest = recoveryProjectSummaries.keys().next().value!;
    recoveryProjectSummaries.delete(oldest);
    recoverySourceCharacters -= oldest.length;
  }
  return summary;
}
export function restoreWorkspace(value: unknown): WorkspaceState {
  const state = object(value);
  if (state.version !== 2) throw new Error('Unsupported workspace version.');
  if (Object.keys(state).some((key) => !workspaceFields.has(key as keyof WorkspaceState)))
    throw new Error('Unsupported workspace recovery field.');
  const entries = state.documents;
  if (!Array.isArray(entries) || entries.length > maxOpenProjects)
    throw new Error('Invalid open project list.');
  const ids = new Set<string>(),
    sessionIds = new Set<string>();
  const documents = entries.map((entry) => {
    const doc = object(entry);
    if (Object.keys(doc).some((key) => !documentFields.has(key as keyof DocumentState)))
      throw new Error('Unsupported project recovery field.');
    if (
      typeof doc.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(doc.id) ||
      ids.has(doc.id)
    )
      throw new Error('Invalid or duplicate project ID.');
    ids.add(doc.id);
    if (doc.pinned !== undefined && doc.pinned !== true)
      throw new Error('Invalid saved project pin state.');
    if (typeof doc.source !== 'string') throw new Error('Invalid project source.');
    const project = recoveryProjectSummary(doc.source);
    if (doc.exampleKey !== undefined && doc.exampleKey !== null && !validExampleKey(doc.exampleKey))
      throw new Error('Invalid example opening identity.');
    const exampleKey = doc.exampleKey;
    if (
      doc.localExample !== undefined &&
      (typeof doc.localExample !== 'boolean' || (doc.localExample && !exampleKey))
    )
      throw new Error('Invalid local example state.');
    if (
      doc.activeSchematicId !== undefined &&
      (typeof doc.activeSchematicId !== 'string' ||
        !project.schematicIds.includes(doc.activeSchematicId))
    )
      throw new Error('The active schematic file is missing from the project.');
    if (typeof doc.dirty !== 'boolean') throw new Error('Invalid project modification state.');
    if (typeof doc.filename !== 'string' || !doc.filename)
      throw new Error('Invalid project filename.');
    if (
      doc.closedSchematicIds !== undefined &&
      (!Array.isArray(doc.closedSchematicIds) ||
        doc.closedSchematicIds.length > 11 ||
        new Set(doc.closedSchematicIds).size !== doc.closedSchematicIds.length ||
        doc.closedSchematicIds.some(
          (id) =>
            typeof id !== 'string' ||
            !project.schematicIds.includes(id) ||
            id === (doc.activeSchematicId ?? project.primarySchematicId),
        ))
    )
      throw new Error('Invalid closed schematic tabs.');
    if (
      doc.sourceDraft !== null &&
      (typeof doc.sourceDraft !== 'string' ||
        new TextEncoder().encode(doc.sourceDraft).length > 8_000_000)
    )
      throw new Error('Source drafts must be text no larger than 8 MB.');
    const restored = restoreSessions(doc as Parameters<typeof restoreSessions>[0]);
    for (const session of restored.sessions) {
      if (sessionIds.has(session.id)) throw new Error('Duplicate conversation ID across projects.');
      sessionIds.add(session.id);
    }
    return {
      id: doc.id,
      ...(doc.pinned === true ? { pinned: true as const } : {}),
      ...(exampleKey !== undefined ? { exampleKey: exampleKey as string | null } : {}),
      ...(doc.localExample !== undefined ? { localExample: doc.localExample as boolean } : {}),
      ...(doc.activeSchematicId !== undefined
        ? { activeSchematicId: doc.activeSchematicId as string }
        : {}),
      ...(doc.closedSchematicIds !== undefined
        ? { closedSchematicIds: [...doc.closedSchematicIds] as string[] }
        : {}),
      source: doc.source,
      sourceDraft: doc.sourceDraft as string | null,
      dirty: doc.dirty,
      filename: projectFilename(doc.filename),
      ...restored,
    };
  });
  if (
    (documents.length && !ids.has(String(state.activeDocumentId))) ||
    (!documents.length && state.activeDocumentId !== null)
  )
    throw new Error('The active project is missing from the workspace.');
  if (!isAgentProvider(state.provider)) throw new Error('Invalid saved Agent provider.');
  if (!isReasoningEffort(state.effort)) throw new Error('Invalid saved Agent reasoning effort.');
  if (state.approvalMode !== 'review' && state.approvalMode !== 'auto')
    throw new Error('Invalid saved Agent approval mode.');
  const models = object(state.models);
  if (Object.keys(models).length !== agentProviderIds.length)
    throw new Error('Invalid saved Agent model list.');
  for (const id of agentProviderIds)
    if (
      typeof models[id] !== 'string' ||
      (models[id] !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@\[\]-]{0,199}$/.test(models[id]))
    )
      throw new Error('Invalid saved Agent model.');
  return {
    version: 2,
    documents,
    activeDocumentId: state.activeDocumentId as string | null,
    provider: state.provider,
    effort: state.effort as ReasoningEffort,
    approvalMode: state.approvalMode,
    models: Object.fromEntries(agentProviderIds.map((id) => [id, models[id] as string])),
  };
}
