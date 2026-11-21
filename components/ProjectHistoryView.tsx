'use client';

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  CircuitBoard,
  Code2,
  FileCode2,
  FileCheck2,
  Check,
  Circle,
  RotateCcw,
  Save,
} from 'lucide-react';
import Select from './Select';
import Dialog from './Dialog';
import WorkspaceLoading from './WorkspaceLoading';
import { GitIcon, ModelIcon, SchematicIcon } from './EditorIcons';
import ProjectFileComparison from './ProjectFileComparison';
import {
  compareProjectFiles,
  sameHistoryFile,
  type HistoryEntry,
  type HistoryPage,
} from '@/lib/project-history';
import type { CapabilityHost } from '@/api/capabilities';
import { parseProject, projectNativeFiles } from '@/lib/project';
import { isCommandModifier } from '@/lib/command-modifier';

const SchematicComparison = lazy(() => import('./SchematicComparison'));
const LayoutComparison = lazy(() => import('./LayoutComparison'));
const ModelComparison = lazy(() => import('./ModelComparison'));
const previewModes = [
  { id: 'schematic', label: 'Schematic', icon: SchematicIcon },
  { id: 'layout', label: 'Layout', icon: CircuitBoard },
  { id: 'model', label: 'Model', icon: ModelIcon },
  { id: 'source', label: 'Source', icon: Code2 },
] as const;
type Display = (typeof previewModes)[number]['id'];
type Version = { id: string; source: string };
const changeLabel = { added: 'Added', removed: 'Deleted', changed: 'Modified' };
const changeStatus = { added: 'A', removed: 'D', changed: 'M' };

export default function ProjectHistoryView({
  visible,
  onClose,
  fileId,
  source,
  sourcePending,
  onSave,
  capabilityHost,
}: {
  visible: boolean;
  onClose: () => void;
  fileId?: string;
  source: string;
  sourcePending: boolean;
  onSave: () => Promise<'saved' | 'cancelled' | Error>;
  capabilityHost: CapabilityHost;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  const [needsSave, setNeedsSave] = useState(false);
  const [historyAvailable, setHistoryAvailable] = useState(false);
  // A null target is the live validated worktree. The base is always explicit.
  const [selected, setSelected] = useState<Version | null>(null);
  const [base, setBase] = useState<Version | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [display, setDisplay] = useState<Display>('schematic');
  const [openedDisplays, setOpenedDisplays] = useState<Display[]>(['schematic']);
  function showDisplay(next: Display) {
    setDisplay(next);
    setOpenedDisplays((opened) => (opened.includes(next) ? opened : [...opened, next]));
  }
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const pending = useRef(false);
  const composing = useRef(false);
  const mounted = useRef(false);
  const current = useRef({ entries, selected, base });
  current.current = { entries, selected, base };
  const before = base?.source ?? source;
  const after = selected?.source ?? source;
  const restoreVersion = selected?.id ?? base?.id;
  const { changes, restorable } = useMemo(() => {
    const oldFiles = projectNativeFiles(parseProject(before));
    const newFiles = projectNativeFiles(parseProject(after));
    const changes = compareProjectFiles(oldFiles, newFiles);
    const liveFiles =
      after === source
        ? newFiles
        : before === source
          ? oldFiles
          : projectNativeFiles(parseProject(source));
    const liveByName = new Map(liveFiles.files.map((file) => [file.name, file]));
    const restorable = new Set(
      changes.flatMap((change) => {
        const file = selected ? change.after : change.before;
        return file && !sameHistoryFile(file, liveByName.get(file.name)) ? [file.name] : [];
      }),
    );
    return { changes, restorable };
  }, [before, after, source, selected]);
  const activeChange = changes.find((change) => change.name === selectedFile) ?? changes[0];
  const labels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { message } of entries) counts.set(message, (counts.get(message) ?? 0) + 1);
    return new Map(
      entries.map(({ id, message }) => [
        id,
        counts.get(message) === 1 && message !== 'Worktree'
          ? message
          : `${message} · ${id.slice(0, 8)}`,
      ]),
    );
  }, [entries]);
  const beforeLabel = base ? (labels.get(base.id) ?? base.id.slice(0, 8)) : 'Worktree';
  const afterLabel = selected ? (labels.get(selected.id) ?? selected.id.slice(0, 8)) : 'Worktree';

  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function createVersion() {
    if (busy || sourcePending || !name.trim() || !historyAvailable) return;
    void perform(async () => {
      await capabilityHost.execute('versions.create', { message: name });
      if (!mounted.current) return;
      setName('');
      await load(false, true);
      setStatus('Version created.');
    });
  }
  function restoreFile(name: string) {
    if (busy || sourcePending || !restoreVersion || !restorable.has(name)) return;
    void perform(async () => {
      await capabilityHost.execute(
        'versions.restore',
        { id: restoreVersion, file: name },
        { actor: 'human' },
      );
      if (mounted.current) setStatus('File restored. Save to write it to disk.');
    });
  }
  async function read(id: string): Promise<Version> {
    const result = (await capabilityHost.query('versions.read', { id })) as { source: string };
    return { id, source: result.source };
  }
  async function load(append = false, reset = false) {
    const state = current.current;
    const result = (await capabilityHost.query('versions.list', {
      offset: append ? state.entries.length : 0,
    })) as HistoryPage;
    if (!mounted.current) return;
    const nextEntries = append ? [...state.entries, ...result.commits] : [...result.commits];
    let nextMore = result.more;
    // Refresh every loaded page so retained selections still belong to this destination.
    while (!append && !reset && nextMore && nextEntries.length < state.entries.length) {
      const page = (await capabilityHost.query('versions.list', {
        offset: nextEntries.length,
      })) as HistoryPage;
      if (!mounted.current) return;
      nextEntries.push(...page.commits);
      nextMore = page.more;
    }
    const target =
      !reset && state.selected && nextEntries.some((entry) => entry.id === state.selected!.id)
        ? state.selected
        : null;
    const preserveBase =
      !reset &&
      state.entries.length > 0 &&
      (!state.base || target || state.base.id !== state.entries[0]?.id);
    const baseId =
      preserveBase && (!state.base || nextEntries.some((entry) => entry.id === state.base!.id))
        ? state.base?.id
        : nextEntries[0]?.id;
    const nextBase = baseId ? await read(baseId) : null;
    if (!mounted.current) return;
    setHistoryAvailable(Boolean(result.version));
    setNeedsSave(Boolean(result.needsSave));
    setMore(nextMore);
    setEntries(nextEntries);
    setSelected(target);
    setBase(nextBase);
  }
  async function selectVersion(entry: HistoryEntry, index: number) {
    let versions = entries;
    if (index === entries.length - 1 && more) {
      const page = (await capabilityHost.query('versions.list', {
        offset: entries.length,
      })) as HistoryPage;
      if (!mounted.current) return;
      versions = [...entries, ...page.commits];
      setEntries(versions);
      setMore(page.more);
    }
    const target = await read(entry.id);
    const older = versions[index + 1];
    const nextBase = older ? await read(older.id) : null;
    if (mounted.current) {
      setSelected(target);
      setBase(nextBase);
      setSelectedFile(null);
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (visible) void perform(() => load());
    // Reopening the retained window refreshes its destination-bound history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, fileId]);

  return (
    <Dialog
      title="Git"
      icon={<GitIcon size={16} />}
      className="independent-window project-history-dialog"
      open={visible}
      onClose={() => {
        if (!composing.current) onClose();
      }}
    >
      <section className="project-history-view" aria-label="Git" aria-busy={busy}>
        {sourcePending && (
          <p className="history-notice">
            Apply or fix Source edits before creating or restoring a version.
          </p>
        )}
        {error && (
          <p className="history-error" role="alert">
            {error}
          </p>
        )}
        {needsSave ? (
          <div className="history-empty">
            <span>Save to start version history.</span>
            <button
              className="tool-button"
              aria-label="Save project"
              title="Save project"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const result = await onSave();
                  if (result instanceof Error) throw result;
                  if (result === 'saved') await load(false, true);
                })
              }
            >
              <Save size={17} />
            </button>
          </div>
        ) : (
          <div className="history-layout">
            <aside className="history-sidebar" aria-label="Git worktree and versions">
              <section className="history-changes" aria-label="Source control">
                <header className="history-section-heading">
                  <strong>Changes</strong>
                </header>
                <div className="history-create">
                  <input
                    aria-label="Commit message"
                    placeholder="Message"
                    aria-description="Ctrl+Enter creates a local version."
                    maxLength={240}
                    value={name}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={() => {
                      composing.current = false;
                    }}
                    onKeyDown={(event) => {
                      if (
                        composing.current ||
                        event.nativeEvent.isComposing ||
                        event.nativeEvent.keyCode === 229
                      ) {
                        event.stopPropagation();
                        if (
                          event.key === 'Escape' ||
                          event.key === 'Enter' ||
                          (isCommandModifier(event) && event.key.toLowerCase() === 's')
                        )
                          event.preventDefault();
                        return;
                      }
                      if (isCommandModifier(event) && event.key === 'Enter') {
                        event.preventDefault();
                        createVersion();
                      }
                    }}
                  />
                  <button
                    className="history-commit"
                    aria-label="Commit"
                    title="Create version"
                    disabled={busy || sourcePending || !name.trim() || !historyAvailable}
                    onClick={createVersion}
                  >
                    <Check size={16} aria-hidden="true" />
                    <span>Commit</span>
                  </button>
                </div>
                <nav className="history-file-list" aria-label="Changed files">
                  <header>
                    <span>Changed files</span>
                    <span className="history-count" aria-label={changes.length + ' changed files'}>
                      {changes.length}
                    </span>
                  </header>
                  {changes.map((change) => (
                    <div key={change.name} className="history-file-row" data-change={change.kind}>
                      <button
                        className={
                          'history-file-open' +
                          (display === 'source' && activeChange?.name === change.name
                            ? ' selected'
                            : '')
                        }
                        aria-label={changeLabel[change.kind] + ' · ' + change.name}
                        aria-current={
                          display === 'source' && activeChange?.name === change.name
                            ? 'true'
                            : undefined
                        }
                        title={change.name}
                        onClick={() => {
                          setSelectedFile(change.name);
                          showDisplay('source');
                        }}
                      >
                        <FileCode2 size={16} aria-hidden="true" />
                        <strong className="history-file-name">{change.name}</strong>
                        <span className="history-change-kind" aria-hidden="true">
                          {changeStatus[change.kind]}
                        </span>
                      </button>
                      {restoreVersion && restorable.has(change.name) && (
                        <button
                          className="tool-button history-file-restore"
                          aria-label={`Restore ${change.name}`}
                          title={`Restore ${change.name} from ${selected ? afterLabel : beforeLabel}`}
                          disabled={busy || sourcePending}
                          onClick={() => restoreFile(change.name)}
                        >
                          <RotateCcw size={15} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))}
                  {!changes.length && <p className="history-sidebar-empty">No changed files</p>}
                </nav>
              </section>
              <nav className="history-entries" aria-label="Project versions">
                <header>History</header>
                <button
                  className={!selected ? 'selected' : ''}
                  aria-current={!selected ? 'true' : undefined}
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const nextBase = entries[0] ? await read(entries[0].id) : null;
                      if (mounted.current) {
                        setSelected(null);
                        setBase(nextBase);
                        setSelectedFile(null);
                      }
                    })
                  }
                >
                  <GitIcon size={16} />
                  <strong>Worktree</strong>
                </button>
                {entries.map((entry, index) => {
                  const details = `${new Date(entry.date).toLocaleString()} · ${entry.id.slice(0, 8)}`;
                  return (
                    <button
                      key={entry.id}
                      className={selected?.id === entry.id ? 'selected' : ''}
                      disabled={busy}
                      aria-current={selected?.id === entry.id ? 'true' : undefined}
                      aria-description={details}
                      title={`${entry.message}\n${details}`}
                      onClick={() => void perform(() => selectVersion(entry, index))}
                    >
                      <span className="history-graph-node" aria-hidden="true">
                        <Circle size={12} />
                      </span>
                      <strong>{labels.get(entry.id)}</strong>
                    </button>
                  );
                })}
                {more && (
                  <button
                    className="tool-button history-older"
                    aria-label="Load older versions"
                    title="Older versions"
                    disabled={busy}
                    onClick={() => void perform(() => load(true))}
                  >
                    <ChevronDown size={17} />
                  </button>
                )}
                {!entries.length && !busy && !error && <p>No versions yet.</p>}
              </nav>
            </aside>
            <section className="history-comparison" aria-label="Version differences">
              <div className="history-compare-controls">
                <span>Compare from</span>
                <Select
                  active={visible}
                  label="Compare version with"
                  value={base?.id ?? 'current'}
                  disabled={busy}
                  options={[
                    { value: 'current', label: 'Worktree' },
                    ...entries.map((entry) => ({
                      value: entry.id,
                      label: labels.get(entry.id) ?? entry.id.slice(0, 8),
                    })),
                  ]}
                  onChange={(id) =>
                    void perform(async () => {
                      const next = id === 'current' ? null : await read(id);
                      if (mounted.current) {
                        setBase(next);
                        setSelectedFile(null);
                      }
                    })
                  }
                />
                <div className="history-display-actions" role="group" aria-label="Comparison view">
                  {previewModes.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      className={'tool-button' + (display === id ? ' active' : '')}
                      aria-label={`${label} comparison`}
                      title={`${label} comparison`}
                      aria-pressed={display === id}
                      onClick={() => showDisplay(id)}
                    >
                      <Icon size={17} />
                    </button>
                  ))}
                </div>
              </div>
              {openedDisplays
                .filter((mode) => mode !== 'source')
                .map((mode) => {
                  const Comparison = mode === 'schematic' ? SchematicComparison : LayoutComparison;
                  const props = {
                    active: visible && display === mode,
                    beforeSource: before,
                    afterSource: after,
                    beforeLabel,
                    afterLabel,
                  };
                  return (
                    <div className="history-preview" key={mode} hidden={display !== mode}>
                      <Suspense
                        fallback={<WorkspaceLoading panel label={`Loading ${mode} comparison`} />}
                      >
                        {mode === 'model' ? (
                          <ModelComparison {...props} fileId={fileId} />
                        ) : (
                          <Comparison {...props} />
                        )}
                      </Suspense>
                    </div>
                  );
                })}
              {openedDisplays.includes('source') && (
                <div className="history-preview" hidden={display !== 'source'}>
                  {activeChange ? (
                    <ProjectFileComparison
                      change={activeChange}
                      beforeLabel={beforeLabel}
                      afterLabel={afterLabel}
                    />
                  ) : (
                    <div className="history-empty-state" role="status">
                      <FileCheck2 size={32} aria-hidden="true" />
                      <strong>No file changes</strong>
                      <p>The selected versions have identical native files.</p>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
        <footer className="history-footer">
          <span role="status">{busy ? 'Loading version history…' : status}</span>
        </footer>
      </section>
    </Dialog>
  );
}
