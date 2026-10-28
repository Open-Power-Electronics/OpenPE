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
            item.unsaved === next[index].unsaved,
        )
      )
        return;
      projects = Object.freeze(
        next.map(({ id, title, unsaved }) => Object.freeze({ id, title, unsaved })),
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
