'use client';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import Workbench from './Workbench';
import type { Agent } from './Chat';
import { createWorkspacePresentation, WorkspacePresentationContext } from './WorkspacePresentation';
import type { ProjectAction, ProjectFileAction, ProjectNavigationItem } from './ProjectNavigation';
import { useAppearance } from './AppearanceSettings';
import DesktopTitlebar from './DesktopTitlebar';
import WorkspaceLoading from './WorkspaceLoading';
import { loadAgentModelCatalog, resetAgentModelCatalogs } from './ModelSelect';
import { api, writeWorkspaceRecovery } from '@/lib/bridge';
import { importDocument, projectFilename, type Project } from '@/lib/project';
import { createProjectAdmissions } from '@/lib/project-admission';
import { createSession, sessionTitle, type SessionAction } from '@/lib/chat-sessions';
import { validExampleKey } from '@/lib/workspace-example';
import {
  isCloseSnapshotUnsaved,
  WorkspaceCloseReview,
  type CloseChoice,
  type CloseSnapshot,
} from '@/lib/workspace-close';
import {
  defaultAgentPreferences,
  maxOpenProjects,
  restoreWorkspace,
  type AgentPreferences,
  type DocumentState,
  type WorkspaceState,
} from '@/lib/workspace-state';

export type DocumentUpdate = Omit<DocumentState, 'id' | 'pinned'> & {
  title: string;
  unsaved: boolean;
};
export type DocumentController = {
  activate: (sessionId?: string) => void;
  newConversation: () => void;
  sessionAction: (id: string, action: SessionAction) => void;
  snapshot: () => CloseSnapshot;
  fileAction: (action: Exclude<ProjectFileAction, 'reveal'>) => Promise<boolean>;
  notify: (message: string) => void;
  requestClose: (
    done: (choice: CloseChoice, snapshot: CloseSnapshot) => Promise<void>,
    cancel: () => void,
  ) => void;
};
type OpenDocument = {
  state: DocumentState;
  initiallyDirty: boolean;
  fileId?: string;
  openKey?: string;
  title: string;
  unsaved: boolean;
  recovered: boolean;
  notice?: string;
};

// A replacement workspace must wait for cancelled recovery to release its
// grants before acquiring the same managed-example destination again.
const workspaceRestoration = { pending: Promise.resolve() };
// Navigation/recovery presentation subscribes at its leaves. Runtime observations
// retain the current project-list getter without rendering an unchanged editor.
const ProjectWorkbench = memo(Workbench);

function ProjectSurface({ active, children }: { active: boolean; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = document.createElement('div');
    element.className = 'project-workspace';
    setContainer(element);
  }, []);
  useLayoutEffect(() => {
    if (!container || !active) return;
    host.current?.appendChild(container);
    return () => container.remove();
  }, [active, container]);
  // Inactive editors stay mounted in detached DOM, preserving editor history,
  // canvas state and streams without exposing their controls to keyboard users.
  return (
    <>
      <div ref={host} hidden={!active} />
      {container && createPortal(children, container)}
    </>
  );
}

export default function DesktopWorkspace() {
  const appearanceSettings = useAppearance();
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const projects = useMemo<ProjectNavigationItem[]>(
    () =>
      documents.map(({ state, title, unsaved }) => ({
        id: state.id,
        title,
        unsaved,
        ...(state.pinned ? { pinned: true as const } : {}),
        sessions: state.sessions.map((session) => ({
          id: session.id,
          title: sessionTitle(session),
          ...(session.pinned ? { pinned: true as const } : {}),
          ...(session.archived ? { archived: true as const } : {}),
        })),
      })),
    [documents],
  );
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const getProjects = useCallback(() => projectsRef.current, []);
  const documentsRef = useRef(documents);
  const [initialProjects] = useState(createProjectAdmissions);
  const getInitialProject = useCallback(
    (id: string, source: string) => initialProjects.get(id, source),
    [initialProjects],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef(activeId);
  const [preferences, setPreferences] = useState<AgentPreferences>(defaultAgentPreferences);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [agentError, setAgentError] = useState('');
  const detectionInFlight = useRef(false);
  const detectAgents = useCallback(async (redetect = true) => {
    if (!window.openpe || detectionInFlight.current) return;
    detectionInFlight.current = true;
    setDetecting(true);
    setAgentError('');
    try {
      setAgents(await (await api('agents')).json());
      if (redetect) resetAgentModelCatalogs();
    } catch (error) {
      setAgentError((error as Error).message);
    } finally {
      detectionInFlight.current = false;
      setDetecting(false);
    }
  }, []);
  useEffect(() => void detectAgents(false), [detectAgents]);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded && agents.some((agent) => agent.id === preferences.provider && agent.available))
      loadAgentModelCatalog(preferences.provider);
  }, [agents, loaded, preferences.provider]);
  const [error, setError] = useState('');
  const [draftStatus, setDraftStatus] = useState('');
  const [presentation, setPresentation] = useState(createWorkspacePresentation);
  useLayoutEffect(() => {
    // Refresh presentation code without resetting documents, drafts or editors.
    // Fast Refresh retains useState values, including their closed-over methods.
    if (presentation.implementation !== createWorkspacePresentation) {
      const current = createWorkspacePresentation();
      current.publishProjects(projects);
      current.publishDraftStatus(draftStatus);
      setPresentation(current);
      return;
    }
    presentation.publishProjects(projects);
    presentation.publishDraftStatus(draftStatus);
  }, [presentation, projects, draftStatus]);
  const ready = useRef(false),
    closing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const controllers = useRef(new Map<string, DocumentController>());
  const revealing = useRef(new Set<string>());
  const openingExamples = useRef(new Set<string>());
  // Retain the queue through development refreshes as well as effect replays.
  const restoration = useRef(workspaceRestoration);
  const quit = useRef(false);
  const [quitting, setQuitting] = useState(false);
  const updateDocuments = useCallback(
    (next: OpenDocument[]) => {
      initialProjects.retain(new Set(next.map((item) => item.state.id)));
      documentsRef.current = next;
      setDocuments(next);
    },
    [initialProjects],
  );
  const getInitialState = useCallback(
    (id: string) => documentsRef.current.find((item) => item.state.id === id)?.state,
    [],
  );
  const selectDocument = useCallback((id: string, sessionId?: string) => {
    if (
      !documentsRef.current.some(
        (item) =>
          item.state.id === id &&
          (!sessionId || item.state.sessions.some((session) => session.id === sessionId)),
      ) ||
      closing.current
    )
      return;
    const fromNavigation = document.activeElement?.closest('.project-navigation');
    activeRef.current = id;
    setActiveId(id);
    controllers.current.get(id)?.activate(sessionId);
    if (fromNavigation)
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            sessionId
              ? `[data-project-id="${id}"] [data-session-id="${sessionId}"]`
              : `[data-project-id="${id}"] button`,
          )
          ?.focus({ preventScroll: true });
      });
  }, []);
  const newProjectConversation = useCallback(
    (id: string) => {
      if (closing.current || !documentsRef.current.some((item) => item.state.id === id)) return;
      selectDocument(id);
      controllers.current.get(id)?.newConversation();
    },
    [selectDocument],
  );
  const projectSessionAction = useCallback(
    (projectId: string, sessionId: string, action: SessionAction) => {
      if (
        closing.current ||
        !documentsRef.current.some(
          (item) =>
            item.state.id === projectId &&
            item.state.sessions.some((session) => session.id === sessionId),
        )
      )
        return;
      controllers.current.get(projectId)?.sessionAction(sessionId, action);
    },
    [],
  );
  const persist = useCallback((items = documentsRef.current, selected = activeRef.current) => {
    if (!window.openpe) return Promise.resolve();
    const state: WorkspaceState = {
      version: 2,
      documents: items.map((item) => item.state),
      activeDocumentId: selected,
      ...preferencesRef.current,
    };
    writes.current = writes.current
      .catch(() => {})
      .then(() => writeWorkspaceRecovery(items.length ? JSON.stringify(state) : null));
    return writes.current;
  }, []);
  useEffect(() => {
    let alive = true;
    const queue = restoration.current;
    queue.pending = queue.pending.then(async () => {
      if (!alive) return;
      try {
        const raw = window.openpe ? await (await api('state')).json() : null;
        if (!alive) return;
        if (raw) {
          // Validate every project before accepting any of a recovered workspace.
          const restored = restoreWorkspace(raw);
          const items: OpenDocument[] = [];
          const restoredIds = new Map<string, string>();
          try {
            for (const state of restored.documents) {
              const exampleKey = state.exampleKey ?? undefined;
              const unsaved =
                state.dirty || (state.sourceDraft !== null && state.sourceDraft !== state.source);
              const managed = exampleKey && state.localExample !== false;
              const detached = managed && unsaved;
              const local =
                managed && !detached
                  ? await window.openpe?.openDefaultExample(exampleKey)
                  : undefined;
              const restoredProject = importDocument(local ? local.source : state.source);
              const recoveredState: DocumentState = local
                ? {
                    ...state,
                    id: local.id,
                    source: local.source,
                    sourceDraft: null,
                    dirty: false,
                    localExample: true,
                    filename: local.filename,
                    activeSchematicId: restoredProject.schematic.id,
                    closedSchematicIds: [],
                  }
                : detached
                  ? {
                      ...state,
                      id: crypto.randomUUID(),
                      localExample: false,
                      exampleKey: null,
                    }
                  : state;
              restoredIds.set(state.id, recoveredState.id);
              const item: OpenDocument = {
                state: recoveredState,
                initiallyDirty: recoveredState.dirty,
                fileId: local?.fileId ?? (await window.openpe?.newFile()),
                title: restoredProject.name ?? restoredProject.schematic.title,
                unsaved: local ? false : unsaved,
                recovered: !local,
                notice:
                  local?.warning ??
                  (detached
                    ? 'Recovered your example edits as a separate project. Save to choose a location.'
                    : undefined),
              };
              const existing = items.findIndex((entry) => entry.state.id === recoveredState.id);
              if (existing < 0) items.push(item);
              else if (state.id === restored.activeDocumentId) items[existing] = item;
              if (!alive) throw new Error('Workspace restoration cancelled.');
            }
          } catch (error) {
            for (const item of items)
              if (item.fileId) await window.openpe?.releaseFile(item.fileId);
            throw error;
          }
          if (!alive) {
            for (const item of items)
              if (item.fileId) await window.openpe?.releaseFile(item.fileId);
            return;
          }
          updateDocuments(items);
          const selected = restored.activeDocumentId
            ? (restoredIds.get(restored.activeDocumentId) ?? null)
            : null;
          activeRef.current = selected;
          setActiveId(selected);
          const { provider, effort, approvalMode, models } = restored;
          setPreferences({ provider, effort, approvalMode, models });
        }
        ready.current = true;
      } catch (error) {
        if (alive)
          setError(`${(error as Error).message} The original recovery file was preserved.`);
      } finally {
        if (alive) setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [updateDocuments]);
  useEffect(() => {
    if (!loaded || !ready.current || !documents.length || closing.current || quit.current) return;
    setDraftStatus('Saving draft');
    timer.current = setTimeout(() => {
      void persist()
        .then(() => setDraftStatus('Draft saved'))
        .catch((error) => {
          setDraftStatus('Draft save failed');
          setError((error as Error).message);
        });
    }, 700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [loaded, documents, activeId, preferences, persist, quitting]);
  useEffect(() => {
    void window.openpe?.setDirty(documents.some((item) => item.unsaved));
  }, [documents]);
  const reportDocument = useCallback(
    (id: string, update: DocumentUpdate) => {
      updateDocuments(
        documentsRef.current.map((item) =>
          item.state.id === id
            ? {
                ...item,
                title: update.title,
                unsaved: update.unsaved,
                openKey: update.localExample === false ? undefined : item.openKey,
                state: {
                  ...item.state,
                  id,
                  source: update.source,
                  sourceDraft: update.sourceDraft,
                  dirty: update.dirty,
                  filename: update.filename,
                  sessions: update.sessions,
                  activeSessionId: update.activeSessionId,
                  activeSchematicId: update.activeSchematicId,
                  closedSchematicIds: update.closedSchematicIds,
                  localExample: update.localExample,
                  exampleKey: update.localExample === false ? null : item.state.exampleKey,
                },
              }
            : item,
        ),
      );
    },
    [updateDocuments],
  );
  const findExample = useCallback(
    (key: string) =>
      documentsRef.current.find(
        (item) => item.state.localExample !== false && item.state.exampleKey === key,
      ),
    [],
  );
  const selectExample = useCallback(
    (key: string) => {
      const existing = findExample(key);
      if (!existing) return false;
      selectDocument(existing.state.id);
      return true;
    },
    [findExample, selectDocument],
  );
  const addDocument = useCallback(
    async (
      input: Project | (() => Promise<Project>),
      filename: string,
      unsaved: boolean,
      brief = '',
      fileId?: string,
      notice?: string,
      openKey?: string,
    ) => {
      const findExisting = () =>
        documentsRef.current.find(
          (item) => (fileId && item.fileId === fileId) || (openKey && item.openKey === openKey),
        ) ?? (openKey && validExampleKey(openKey) ? findExample(openKey) : undefined);
      const existing = findExisting();
      if (existing) {
        selectDocument(existing.state.id);
        return;
      }
      if (documentsRef.current.length >= maxOpenProjects) {
        if (fileId) await window.openpe?.releaseFile(fileId);
        throw new Error('Close a project before opening another (maximum 12).');
      }
      let id = crypto.randomUUID();
      const exampleKey = !fileId && openKey && validExampleKey(openKey) ? openKey : undefined;
      if (exampleKey && openingExamples.current.has(exampleKey)) return;
      if (exampleKey) openingExamples.current.add(exampleKey);
      let local:
        | { fileId: string; filename: string; warning?: string; id?: string; source?: string }
        | undefined;
      let grant: string | undefined;
      let project = typeof input === 'function' ? undefined : input;
      const resolveProject = async () =>
        (project ??= typeof input === 'function' ? await input() : input);
      try {
        local =
          exampleKey && window.openpe
            ? await window.openpe.openDefaultExample(exampleKey)
            : undefined;
        if (local?.id) id = local.id;
        if (local?.source) {
          project = importDocument(local.source);
        } else await resolveProject();
        grant = fileId ?? local?.fileId ?? (await window.openpe?.newFile());
      } finally {
        if (exampleKey) openingExamples.current.delete(exampleKey);
      }
      // Another open can finish while native grant allocation is pending.
      const opened =
        documentsRef.current.find(
          (item) => item.state.id === id || (grant && item.fileId === grant),
        ) ?? findExisting();
      if (opened) {
        if (grant && grant !== opened.fileId) await window.openpe?.releaseFile(grant);
        selectDocument(opened.state.id);
        return;
      }
      if (documentsRef.current.length >= maxOpenProjects) {
        if (grant) await window.openpe?.releaseFile(grant);
        throw new Error('Close a project before opening another (maximum 12).');
      }
      const session = createSession(brief);
      // Detach and validate once at admission. The first Workbench/Core reads
      // this exact Source-bound snapshot instead of importing it a second time.
      const source = initialProjects.stage(id, project!);
      const state: DocumentState = {
        id,
        exampleKey: openKey && validExampleKey(openKey) ? openKey : null,
        localExample: local ? true : undefined,
        source,
        sourceDraft: null,
        dirty: unsaved,
        filename: local?.filename ?? projectFilename(filename),
        sessions: [session],
        activeSessionId: session.id,
      };
      ready.current = true;
      setError('');
      updateDocuments([
        ...documentsRef.current,
        {
          state,
          initiallyDirty: state.dirty,
          fileId: grant,
          openKey,
          title: project!.name ?? project!.schematic.title,
          unsaved,
          recovered: false,
          notice: local?.warning ?? notice,
        },
      ]);
      selectDocument(id);
    },
    [findExample, selectDocument, updateDocuments, initialProjects],
  );
  const closeDocument = useCallback(
    async (id: string) => {
      if (closing.current) return false;
      closing.current = true;
      if (timer.current) clearTimeout(timer.current);
      try {
        const items = documentsRef.current;
        const item = items.find((entry) => entry.state.id === id);
        const next = items.filter((entry) => entry.state.id !== id);
        const selected =
          activeRef.current === id
            ? (next[Math.max(0, items.findIndex((entry) => entry.state.id === id) - 1)]?.state.id ??
              null)
            : activeRef.current;
        await persist(next, selected);
        if (item?.fileId) await window.openpe?.releaseFile(item.fileId);
        activeRef.current = selected;
        setActiveId(selected);
        // Other projects may finish an Agent response while this write is pending.
        updateDocuments(documentsRef.current.filter((entry) => entry.state.id !== id));
        return true;
      } finally {
        closing.current = false;
      }
    },
    [persist, updateDocuments],
  );
  const register = useCallback(
    (id: string, controller: DocumentController | null) => {
      if (controller) {
        controllers.current.set(id, controller);
        // Strict Mode's initializers have both completed before registration.
        // Core now owns this snapshot; the workspace retains no duplicate basis.
        initialProjects.release(id);
      } else controllers.current.delete(id);
    },
    [initialProjects],
  );
  const selectFile = useCallback(
    (fileId: string) => {
      const existing = documentsRef.current.find((item) => item.fileId === fileId);
      if (!existing) throw new Error('This project is no longer open. Open it again.');
      selectDocument(existing.state.id);
    },
    [selectDocument],
  );
  const requestDocumentAction = useCallback(
    (id: string, action: ProjectAction) => {
      if (closing.current || quit.current) return;
      if (action === 'pin' || action === 'unpin') {
        const target = documentsRef.current.find((item) => item.state.id === id);
        const pinned = action === 'pin';
        if (!target || Boolean(target.state.pinned) === pinned) return;
        updateDocuments(
          documentsRef.current.map((item) => {
            if (item !== target) return item;
            const state = { ...item.state };
            if (pinned) state.pinned = true;
            else delete state.pinned;
            return { ...item, state };
          }),
        );
        return;
      }
      if (action === 'reveal') {
        if (revealing.current.has(id)) return;
        const notify = (message: string) =>
          controllers.current.get(activeRef.current ?? 'home')?.notify(message);
        const fileId = documentsRef.current.find((item) => item.state.id === id)?.fileId;
        if (!fileId || !window.openpe) {
          notify('Save this project in the desktop app before showing it in File Explorer.');
          return;
        }
        const reveal = window.openpe.revealFile;
        revealing.current.add(id);
        void (async () => {
          const result = await reveal(fileId);
          if (result?.status !== 'needs-save' || closing.current || quit.current) return;
          const controller = controllers.current.get(id);
          if (!controller) return;
          selectDocument(id);
          if (!(await controller.fileAction('save'))) return;
          if (
            !documentsRef.current.some((item) => item.state.id === id) ||
            closing.current ||
            quit.current
          )
            return;
          if ((await reveal(fileId))?.status === 'needs-save')
            notify('The project has no saved location. Save it and try again.');
        })()
          .catch((error: unknown) => {
            const message =
              error instanceof Error
                ? error.message
                : 'Could not show the project in File Explorer.';
            notify(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
          })
          .finally(() => revealing.current.delete(id));
        return;
      }
      const controller = controllers.current.get(id);
      if (!controller) return;
      if (action !== 'close' || isCloseSnapshotUnsaved(controller.snapshot())) selectDocument(id);
      controller.fileAction(action);
    },
    [selectDocument, updateDocuments],
  );
  useEffect(
    () =>
      window.openpe?.onCloseRequested(() => {
        // A repeated close request must not revoke the review already in progress.
        if (quit.current) return;
        if (closing.current) {
          void window.openpe?.resolveClose(false);
          return;
        }
        quit.current = true;
        setQuitting(true);
        if (timer.current) clearTimeout(timer.current);
        const review = new WorkspaceCloseReview();
        const snapshots = () =>
          documentsRef.current.map(({ state }) => ({
            id: state.id,
            // A synchronous edit can precede the Workbench reporting effect.
            ...(controllers.current.get(state.id)?.snapshot() ?? {
              native: state,
              ordinaryDraftRevision: null,
            }),
          }));
        const cancel = () => {
          quit.current = false;
          setQuitting(false);
          void window.openpe?.resolveClose(false);
        };
        const advance = async () => {
          if (!quit.current) return;
          const id = review.pending(snapshots())?.id;
          if (!id) {
            // Let failures reach the visible confirmation so the user can retry
            // or cancel, instead of silently cancelling the native close request.
            const finished = await review.finish(
              snapshots,
              (retainedIds) => {
                const items = documentsRef.current
                  .filter((item) => retainedIds.has(item.state.id))
                  .map((item) => ({
                    ...item,
                    state: {
                      ...item.state,
                      ...controllers.current.get(item.state.id)?.snapshot().native,
                    },
                  }));
                const selected = items.some((item) => item.state.id === activeRef.current)
                  ? activeRef.current
                  : (items[0]?.state.id ?? null);
                return persist(items, selected);
              },
              async () => {
                await window.openpe?.resolveClose(true);
              },
            );
            // Leave autosave paused until the native window is gone.
            if (!finished) await advance();
            return;
          }
          const controller = controllers.current.get(id);
          if (!controller) {
            cancel();
            return;
          }
          selectDocument(id);
          controller.requestClose(async (choice, snapshot) => {
            review.accept(id, snapshot, choice);
            await advance();
          }, cancel);
        };
        void advance().catch((error) => {
          setError((error as Error).message);
          cancel();
        });
      }),
    [persist, selectDocument],
  );

  if (!loaded)
    return (
      <>
        <DesktopTitlebar />
        <WorkspaceLoading />
      </>
    );
  return (
    <WorkspacePresentationContext.Provider value={presentation}>
      {[null, ...documents].map((item) => {
        const id = item?.state.id ?? 'home';
        const active = item ? activeId === id : activeId === null;
        return (
          <ProjectSurface key={id} active={active}>
            <ProjectWorkbench
              documentId={id}
              active={active}
              getInitialState={getInitialState}
              getInitialProject={getInitialProject}
              fileId={item?.fileId}
              initiallyDirty={item?.initiallyDirty ?? false}
              recovered={item?.recovered ?? false}
              initialNotice={item?.notice}
              getProjects={getProjects}
              onSelectProject={selectDocument}
              onNewProjectSession={newProjectConversation}
              onProjectSessionAction={projectSessionAction}
              onSelectExample={selectExample}
              onSelectFile={selectFile}
              onAddProject={addDocument}
              onCloseProject={closeDocument}
              onProjectAction={requestDocumentAction}
              onDocumentChange={reportDocument}
              registerController={register}
              preferences={preferences}
              agents={agents}
              detecting={detecting}
              agentError={agentError}
              detectAgents={detectAgents}
              setPreferences={setPreferences}
              appearanceSettings={appearanceSettings}
              startupError={error}
            />
          </ProjectSurface>
        );
      })}
    </WorkspacePresentationContext.Provider>
  );
}
