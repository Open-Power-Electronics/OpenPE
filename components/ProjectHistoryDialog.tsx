'use client';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, ChevronDown, Info, Plus, RefreshCw, RotateCcw, Save } from 'lucide-react';
import Dialog, { type DialogSizeProps } from './Dialog';
import Select from './Select';
import { compareProjectVersions, type HistoryEntry, type HistoryPage } from '@/lib/project-history';
import type { CapabilityHost } from '@/api/capabilities';
import { parseProject, serializeProject } from '@/lib/project';
import '@/lib/bridge';

const SchematicCompareDialog = lazy(() => import('./SchematicCompareDialog'));

export default function ProjectHistoryDialog({
  fileId,
  source,
  sourcePending,
  onSave,
  onRestore,
  onClose,
  size,
  onResize,
  capabilityHost,
}: {
  fileId?: string;
  source: string;
  sourcePending: boolean;
  onSave: () => Promise<'saved' | 'cancelled' | Error>;
  onRestore: (source: string) => void | Promise<void>;
  onClose: () => void;
  capabilityHost?: CapabilityHost;
} & DialogSizeProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  const [needsSave, setNeedsSave] = useState(false);
  const [version, setVersion] = useState('');
  const [selected, setSelected] = useState<{ id: string; source: string } | null>(null);
  const [comparison, setComparison] = useState<{ id: string; source: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const pending = useRef(false);
  const composing = useRef(false);
  const mounted = useRef(true);
  const changes = useMemo(
    () => (selected ? compareProjectVersions(selected.source, comparison?.source ?? source) : null),
    [selected, comparison, source],
  );
  const restoredAlready = selected?.source === source;

  function bridge() {
    if (capabilityHost)
      return {
        list: ({ offset }: { fileId: string; offset?: number }) =>
          capabilityHost.query('versions.list', { offset: offset ?? 0 }) as Promise<HistoryPage>,
        read: async ({ id }: { fileId: string; id: string }) =>
          ((await capabilityHost.query('versions.read', { id })) as { source: string }).source,
        create: ({ message }: { fileId: string; source: string; message: string }) =>
          capabilityHost.execute('versions.create', { message }),
      };
    const api = window.openpe;
    if (!api) throw new Error('Open the desktop app to use local Git version history.');
    if (!fileId) throw new Error('Reopen this project to grant access to version history.');
    return { list: api.historyList, read: api.historyRead, create: api.historyCreate };
  }
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
  async function read(id: string) {
    const raw = await bridge().read({ fileId: fileId!, id });
    return { id, source: serializeProject(parseProject(raw)) };
  }
  async function load(append = false) {
    const result = await bridge().list({ fileId: fileId!, offset: append ? entries.length : 0 });
    if (!mounted.current) return;
    setVersion(result.version);
    setNeedsSave(Boolean(result.needsSave));
    setMore(result.more);
    setEntries((current) => (append ? [...current, ...result.commits] : result.commits));
    if (!append) {
      setSelected(null);
      setComparison(null);
      if (result.commits[0]) {
        const next = await read(result.commits[0].id);
        if (mounted.current) setSelected(next);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void perform(() => load());
    return () => {
      mounted.current = false;
    };
    // One history dialog is bound to one mounted project and its native grant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const label = (id: string) => entries.find((entry) => entry.id === id)?.message ?? id.slice(0, 8);
  return (
    <Dialog
      title="Version history"
      busy={busy}
      onClose={() => {
        if (showCompare) setShowCompare(false);
        else onClose();
      }}
      className="independent-window project-history-dialog"
      resizable
      resizeCorner="bottom-right"
      size={size}
      onResize={onResize}
      minWidth={480}
      footer={
        (version || selected) && (
          <>
            <span className="history-version">{version}</span>
            {selected && (
              <>
                <button
                  className="tool-button"
                  aria-label="Restore details"
                  title="Restore details"
                  aria-expanded={showHelp}
                  onClick={() => setShowHelp(!showHelp)}
                >
                  <Info size={17} />
                </button>
                <button
                  className="tool-button"
                  aria-label="Restore version"
                  title="Restore version"
                  disabled={busy || !selected || sourcePending || restoredAlready}
                  onClick={async () => {
                    if (selected) await perform(async () => onRestore(selected.source));
                  }}
                >
                  <RotateCcw size={17} />
                </button>
              </>
            )}
          </>
        )
      }
    >
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
                if (result === 'saved') await load();
              })
            }
          >
            <Save size={17} />
          </button>
        </div>
      ) : (
        <div className="history-create">
          <input
            data-autofocus
            aria-label="Version name"
            placeholder="Version name"
            maxLength={240}
            value={name}
            disabled={busy || needsSave}
            onChange={(e) => setName(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                (event.key === 'Enter' || event.key === 'Escape') &&
                (composing.current ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229)
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          />
          <button
            className="tool-button"
            aria-label="Create version"
            title="Create version"
            disabled={busy || needsSave || sourcePending || !name.trim() || !version}
            onClick={() =>
              void perform(async () => {
                await bridge().create({ fileId: fileId!, source, message: name });
                if (!mounted.current) return;
                setName('');
                await load();
                setStatus('Version created.');
              })
            }
          >
            <Plus size={17} />
          </button>
          <button
            className="tool-button"
            aria-label="Refresh version history"
            title="Refresh history"
            disabled={busy}
            onClick={() => void perform(() => load())}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      )}
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
      <p className="history-status" role="status">
        {busy ? 'Loading version history…' : status}
      </p>
      {!needsSave && !entries.length && !busy && !error && <p>No versions yet.</p>}
      {entries.length > 0 && (
        <div className="history-layout">
          <nav className="history-entries" aria-label="Project versions">
            {entries.map((entry) => (
              <button
                key={entry.id}
                className={selected?.id === entry.id ? 'selected' : ''}
                disabled={busy}
                aria-current={selected?.id === entry.id ? 'true' : undefined}
                aria-description={`${entry.message}\n${new Date(entry.date).toLocaleString()} · ${entry.id.slice(0, 8)}`}
                onClick={() =>
                  void perform(async () => {
                    const next = await read(entry.id);
                    if (mounted.current) setSelected(next);
                  })
                }
              >
                <strong>{entry.message}</strong>
                <span>
                  {new Date(entry.date).toLocaleString()} · {entry.id.slice(0, 8)}
                </span>
              </button>
            ))}
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
          </nav>
          <section className="history-comparison" aria-label="Version differences">
            <div className="history-compare-controls">
              <span>Compare with</span>
              <Select
                label="Compare version with"
                value={comparison?.id ?? 'current'}
                disabled={busy}
                options={[
                  { value: 'current', label: 'Current project' },
                  ...entries.map((entry) => ({
                    value: entry.id,
                    label: `${entry.message} · ${entry.id.slice(0, 8)}`,
                  })),
                ]}
                onChange={(id) =>
                  void perform(async () => {
                    const next = id === 'current' ? null : await read(id);
                    if (mounted.current) setComparison(next);
                  })
                }
              />
              <button
                className="tool-button"
                aria-label="Compare schematics"
                title="Compare schematics"
                disabled={busy || !selected}
                onClick={() => setShowCompare(true)}
              >
                <Columns2 size={17} />
              </button>
            </div>
            {selected && (
              <p className="history-comparison-label">
                {label(selected.id)} → {comparison ? label(comparison.id) : 'Current project'}
              </p>
            )}
            {changes && (
              <>
                <p>
                  {changes.differences.length}
                  {changes.truncated ? '+' : ''} changes
                </p>
                {changes.differences.map((change, i) => (
                  <article className="history-change" key={i}>
                    <strong aria-description={change.path}>
                      {change.kind === 'added'
                        ? 'Added'
                        : change.kind === 'removed'
                          ? 'Removed'
                          : 'Changed'}{' '}
                      ·{' '}
                      {change.path
                        .replace(/ \([0-9a-f-]{36}\)/gi, '')
                        .replace(/^\//, '')
                        .replaceAll('/', ' / ')}
                    </strong>
                    <div className="history-change-values">
                      <div>
                        <span>Before</span>
                        <pre>
                          {change.before.slice(0, 12000)}
                          {change.before.length > 12000 ? '\n… Preview truncated' : ''}
                        </pre>
                      </div>
                      <div>
                        <span>After</span>
                        <pre>
                          {change.after.slice(0, 12000)}
                          {change.after.length > 12000 ? '\n… Preview truncated' : ''}
                        </pre>
                      </div>
                    </div>
                  </article>
                ))}
                {changes.truncated && (
                  <p>Showing the first 300 changes. Restoring includes the complete project.</p>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {selected && showHelp && (
        <p className="history-notice">
          Restoring replaces the complete editor project and can be undone. Save to write it to
          disk. Create a version first to keep current edits in Git history.
        </p>
      )}
      {selected && showCompare && (
        <Suspense fallback={<p role="status">Loading schematic comparison…</p>}>
          <SchematicCompareDialog
            beforeSource={selected.source}
            afterSource={comparison?.source ?? source}
            beforeLabel={`${label(selected.id)} · ${selected.id.slice(0, 8)}`}
            afterLabel={
              comparison
                ? `${label(comparison.id)} · ${comparison.id.slice(0, 8)}`
                : 'Current project'
            }
            onClose={() => setShowCompare(false)}
          />
        </Suspense>
      )}
    </Dialog>
  );
}
