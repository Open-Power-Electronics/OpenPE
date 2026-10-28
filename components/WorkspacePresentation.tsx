'use client';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ProjectNavigationItem } from './ProjectNavigation';

export const emptyWorkspaceProjects: readonly ProjectNavigationItem[] = Object.freeze([]);
const noSubscription = () => () => {};
const noDraftStatus = () => undefined;

/** Workspace presentation only; project/runtime state remains with its owners. */
export function createWorkspacePresentation() {
  let projects = emptyWorkspaceProjects;
  let draftStatus = '';
  const projectListeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  return {
    // Retained snapshots must not retain methods from a replaced renderer module.
    implementation: createWorkspacePresentation,
    getProjects: () => projects,
    getDraftStatus: () => draftStatus,
    subscribeProjects: (listener: () => void) => {
      projectListeners.add(listener);
      return () => projectListeners.delete(listener);
    },
    subscribeDraftStatus: (listener: () => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    publishProjects(next: readonly ProjectNavigationItem[]) {
      if (
        projects.length === next.length &&
        projects.every(
          (item, index) =>
            item.id === next[index].id &&
            item.title === next[index].title &&
            item.unsaved === next[index].unsaved &&
            item.pinned === next[index].pinned &&
            JSON.stringify(item.sessions) === JSON.stringify(next[index].sessions),
        )
      )
        return;
      projects = Object.freeze(
        next.map((item) =>
          Object.freeze({
            ...item,
            ...(item.sessions && {
              sessions: Object.freeze(
                item.sessions.map((session) => Object.freeze({ ...session })),
              ),
            }),
          }),
        ),
      );
      projectListeners.forEach((listener) => listener());
    },
    publishDraftStatus(next: string) {
      if (draftStatus === next) return;
      draftStatus = next;
      statusListeners.forEach((listener) => listener());
    },
  };
}

export const WorkspacePresentationContext = createContext<ReturnType<
  typeof createWorkspacePresentation
> | null>(null);

function usePresentationSnapshot<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
  initial: T,
  active: boolean,
) {
  const committed = useRef(initial);
  const pausedSnapshot = useCallback(() => committed.current, []);
  const read = active ? getSnapshot : pausedSnapshot;
  const snapshot = useSyncExternalStore(active ? subscribe : noSubscription, read, read);
  useLayoutEffect(() => {
    committed.current = snapshot;
  }, [snapshot]);
  return snapshot;
}

export function useWorkspaceProjects(fallback: readonly ProjectNavigationItem[], active: boolean) {
  const presentation = useContext(WorkspacePresentationContext);
  const fallbackSnapshot = useCallback(() => fallback, [fallback]);
  const getSnapshot = presentation?.getProjects ?? fallbackSnapshot;
  return usePresentationSnapshot(
    presentation?.subscribeProjects ?? noSubscription,
    getSnapshot,
    fallback,
    active,
  );
}

export function useWorkspaceDraftStatus(active: boolean) {
  const presentation = useContext(WorkspacePresentationContext);
  const getSnapshot = presentation?.getDraftStatus ?? noDraftStatus;
  return usePresentationSnapshot<string | undefined>(
    presentation?.subscribeDraftStatus ?? noSubscription,
    getSnapshot,
    undefined,
    active,
  );
}
