import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectDirectoryListing, ProjectFilePreview } from '@/lib/project-directory';
import { acceptProjectFileSave, type ProjectFileDraft } from '@/lib/project-file-drafts';
import {
  createProjectFileAccess,
  type ProjectFileAccessPorts,
  type ProjectFileGuard,
} from '@/lib/project-file-capabilities';

const empty: ProjectDirectoryListing = { entries: [], truncated: false };
const message = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;
type LocatedDraft = ProjectFileDraft & { scope: string; name: string };
function cachePreview(
  previous: ReadonlyMap<string, ProjectFilePreview>,
  id: string,
  value: ProjectFilePreview,
) {
  const next = new Map(previous);
  next.set(id, value);
  while (next.size > 8) next.delete(next.keys().next().value!);
  return next;
}
export function useProjectDirectory(
  fileId: string | undefined,
  destination: string,
  visible: boolean,
  selected: string,
) {
  const [request, setRequest] = useState(0);
  const [listing, setListing] = useState<{
    fileId?: string;
    destination: string;
    value: ProjectDirectoryListing;
  }>({ destination: '', value: empty });
  const [previews, setPreviews] = useState<ReadonlyMap<string, ProjectFilePreview>>(new Map());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const listingSequence = useRef(0);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, LocatedDraft>>(new Map());
  const draftsRef = useRef(drafts);
  const draftRevision = useRef(0);
  const scope = JSON.stringify([fileId, destination]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const updateDrafts = useCallback((next: ReadonlyMap<string, LocatedDraft>) => {
    draftsRef.current = next;
    draftRevision.current++;
    setDrafts(next);
  }, []);
  const current =
    listing.fileId === fileId && listing.destination === destination ? listing.value : empty;
  const refresh = useCallback(() => setRequest((value) => value + 1), []);
  useEffect(() => {
    if (!visible) return;
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [visible, refresh]);
  useEffect(() => {
    if (!visible || !fileId || !window.openpe || savingRef.current) return;
    let cancelled = false;
    const sequence = ++listingSequence.current;
    setLoading(true);
    setError('');
    void window.openpe
      .projectDirectory(fileId)
      .then((value) => {
        if (cancelled || sequence !== listingSequence.current) return;
        setListing({ fileId, destination, value });
        setPreviews(new Map());
        if (value.truncated)
          setError('The project folder listing is limited. Some entries are not shown.');
      })
      .catch((reason: unknown) => {
        if (!cancelled && sequence === listingSequence.current)
          setError(message(reason, 'Could not read project folders.'));
      })
      .finally(() => {
        if (!cancelled && sequence === listingSequence.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, destination, visible, request]);
  useEffect(() => {
    if (!visible || !fileId || loading || saving || !window.openpe) return;
    const entry = current.entries.find((item) => item.kind === 'file' && item.name === selected);
    if (!entry?.id || previews.has(entry.id)) return;
    let cancelled = false;
    void window.openpe
      .projectFilePreview({ fileId, id: entry.id })
      .then((value) => {
        if (cancelled) return;
        setPreviews((previous) => cachePreview(previous, entry.id!, value));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(message(reason, 'Could not preview project file.'));
      });
    return () => {
      cancelled = true;
    };
  }, [current, selected, previews, fileId, loading, saving, visible]);
  const change = useCallback(
    (name: string, source: string, suppliedPreview?: ProjectFilePreview) => {
      const key = JSON.stringify([scope, name]);
      const existing = draftsRef.current.get(key);
      const entry = current.entries.find((item) => item.kind === 'file' && item.name === name);
      const preview = suppliedPreview ?? (entry?.id ? previews.get(entry.id) : undefined);
      if (!existing && (!preview || preview.binary || preview.truncated || preview.readOnly))
        return;
      const draft: LocatedDraft = existing
        ? { ...existing, source }
        : {
            scope,
            name,
            source,
            expectedSource: preview!.source,
            ...(preview!.encoding ? { encoding: preview!.encoding } : {}),
          };
      const next = new Map(draftsRef.current);
      // Keep a reversal while writing: it becomes pending if that write succeeds.
      if (draft.source === draft.expectedSource && !savingRef.current) next.delete(key);
      else next.set(key, draft);
      updateDrafts(next);
      setError('');
    },
    [scope, current, previews, updateDrafts],
  );
  const save = useCallback(
    async (name?: string, guard?: ProjectFileGuard) => {
      guard?.check();
      if (savingRef.current) throw new Error('A project file is already being saved.');
      const pending = [...draftsRef.current.entries()].filter(
        ([, draft]) => draft.source !== draft.expectedSource && (!name || draft.name === name),
      );
      if (!pending.length) return;
      if (!fileId || !window.openpe || pending.some(([, draft]) => draft.scope !== scope))
        throw new Error('The project location changed. Reopen the original project files.');
      savingRef.current = true;
      listingSequence.current++;
      setSaving(true);
      setLoading(false);
      setError('');
      try {
        const value = await window.openpe.projectDirectory(fileId);
        guard?.check();
        if (scopeRef.current !== scope)
          throw new Error('The project location changed while saving its files.');
        setListing({ fileId, destination, value });
        setPreviews(new Map());
        for (const [key, draft] of pending) {
          const entry = value.entries.find(
            (item) => item.kind === 'file' && item.name === draft.name,
          );
          if (!entry?.id)
            throw new Error(`The file ${draft.name} is unavailable. Refresh project files.`);
          if (scopeRef.current !== scope)
            throw new Error('The project location changed while saving its files.');
          guard?.check();
          const saved = await window.openpe.projectFileWrite({
            fileId,
            id: entry.id,
            source: draft.source,
            expectedSource: draft.expectedSource,
            ...(draft.encoding ? { encoding: draft.encoding } : {}),
          });
          const next = new Map(draftsRef.current);
          const accepted = acceptProjectFileSave(next.get(key), draft);
          if (accepted) next.set(key, accepted as LocatedDraft);
          else next.delete(key);
          updateDrafts(next);
          if (scopeRef.current === scope)
            setPreviews((previous) => cachePreview(previous, entry.id!, saved));
        }
        if (
          [...draftsRef.current.values()].some(
            (draft) => draft.source !== draft.expectedSource && (!name || draft.name === name),
          )
        )
          throw new Error(
            'A project file changed while saving. Save again to include the latest edits.',
          );
      } catch (reason) {
        const error = new Error(message(reason, 'Could not save project file.'));
        setError(error.message);
        throw error;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [fileId, destination, scope, updateDrafts],
  );
  const discard = useCallback(
    (name?: string) => {
      const next = new Map(draftsRef.current);
      if (name === undefined) next.clear();
      else next.delete(JSON.stringify([scopeRef.current, name]));
      updateDrafts(next);
      setError('');
    },
    [updateDrafts],
  );
  const hasPending = useCallback(
    () => [...draftsRef.current.values()].some((draft) => draft.source !== draft.expectedSource),
    [],
  );
  const files = useMemo(() => {
    const files = current.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => {
        const preview = entry.id ? previews.get(entry.id) : undefined;
        const draft = drafts.get(JSON.stringify([scope, entry.name]));
        return {
          name: entry.name,
          observation: true as const,
          pdf: preview?.pdf && fileId && entry.id ? { fileId, id: entry.id } : undefined,
          source: draft?.source ?? preview?.source ?? 'Loading file…',
          encoding: draft?.encoding ?? preview?.encoding,
          readOnly: draft
            ? false
            : !preview || preview.binary || preview.truncated || preview.readOnly,
          previewStatus: preview?.binary
            ? 'Binary file metadata'
            : preview?.truncated
              ? 'Preview truncated to 1 MiB'
              : undefined,
        };
      });
    for (const draft of drafts.values())
      if (draft.scope === scope && !files.some((file) => file.name === draft.name))
        files.push({
          name: draft.name,
          observation: true as const,
          pdf: undefined,
          source: draft.source,
          encoding: draft.encoding,
          readOnly: false,
          previewStatus: undefined,
        });
    return files;
  }, [current, previews, drafts, scope, fileId]);
  const directories = useMemo(
    () => current.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.name),
    [current],
  );
  const pending = [...drafts.values()].some((draft) => draft.source !== draft.expectedSource);
  const selectedDraft = drafts.get(JSON.stringify([scope, selected]));
  const selectedPending = !!selectedDraft && selectedDraft.source !== selectedDraft.expectedSource;
  const accessPorts = useRef<ProjectFileAccessPorts>(null!);
  accessPorts.current = {
    scope: () => scopeRef.current,
    draftRevision: () => draftRevision.current,
    draft: (name) => draftsRef.current.get(JSON.stringify([scopeRef.current, name])),
    list: async (guard) => {
      guard.check();
      if (!fileId || !window.openpe)
        throw new Error('Open a desktop project before reading its files.');
      if (savingRef.current) throw new Error('A project file is already being saved.');
      const sequence = ++listingSequence.current;
      setLoading(true);
      try {
        const value = await window.openpe.projectDirectory(fileId);
        guard.check();
        if (sequence !== listingSequence.current)
          throw new Error('The project file listing changed. Read it again.');
        setListing({ fileId, destination, value });
        setPreviews(new Map());
        setError(
          value.truncated
            ? 'The project folder listing is limited. Some entries are not shown.'
            : '',
        );
        return value;
      } finally {
        if (sequence === listingSequence.current) setLoading(false);
      }
    },
    preview: async (id, guard) => {
      guard.check();
      if (!fileId || !window.openpe)
        throw new Error('Open a desktop project before reading its files.');
      const sequence = listingSequence.current;
      const value = await window.openpe.projectFilePreview({ fileId, id });
      guard.check();
      if (sequence !== listingSequence.current)
        throw new Error('The project file listing changed. Read it again.');
      setPreviews((previous) => cachePreview(previous, id, value));
      return value;
    },
    change: (name, source, preview) => {
      if (savingRef.current) throw new Error('A project file is already being saved.');
      change(name, source, preview);
    },
    save,
    discard: (name) => {
      if (savingRef.current) throw new Error('A project file is already being saved.');
      discard(name);
    },
  };
  const [capabilities] = useState(() =>
    createProjectFileAccess({
      scope: () => accessPorts.current.scope(),
      draftRevision: () => accessPorts.current.draftRevision(),
      draft: (name) => accessPorts.current.draft(name),
      list: (guard) => accessPorts.current.list(guard),
      preview: (id, guard) => accessPorts.current.preview(id, guard),
      change: (name, source, preview) => accessPorts.current.change(name, source, preview),
      save: (name, guard) => accessPorts.current.save(name, guard),
      discard: (name) => accessPorts.current.discard(name),
    }),
  );
  return {
    capabilities,
    files,
    directories,
    error,
    refresh,
    loading,
    pending,
    selectedPending,
    saving,
    change,
    save,
    discard,
    hasPending,
  };
}
