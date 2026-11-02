'use client';
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Search, Library, RotateCw } from 'lucide-react';
import { api } from '@/lib/bridge';
import type { CapabilityHost } from '@/api/capabilities';
import { searchLibrary, type LibraryEntry, type SymbolDetail } from '@/lib/library';
import { tiDcdcParts, tiPart } from '@/lib/ti-dcdc';
import type { SExpr } from '@/lib/sexpr';
import Dialog from './Dialog';
import Select from './Select';
import SymbolPreview from './SymbolPreview';
import FootprintPreview from './FootprintPreview';
const ModelPreview = lazy(() => import('./ModelPreview'));
export type FootprintDetail = LibraryEntry & {
  footprint: SExpr;
  pads: string[];
  models: { path: string }[];
};
type Detail = SymbolDetail | FootprintDetail;
export default function LibraryChooser({
  kind,
  onClose,
  onChoose,
  initialSearch = '',
  initialLibrary = '',
  capabilityHost,
  title,
  label,
  actionLabel,
  header,
  canChoose = true,
  initialPreview = '2d',
  requireModel = false,
}: {
  kind: 'symbols' | 'footprints';
  onClose: () => void;
  onChoose: (detail: Detail, unit: number, modelIndex: number) => void;
  initialSearch?: string;
  initialLibrary?: string;
  capabilityHost?: CapabilityHost;
  title?: string;
  label?: string;
  actionLabel?: string;
  header?: ReactNode;
  canChoose?: boolean;
  initialPreview?: '2d' | '3d';
  requireModel?: boolean;
}) {
  const [query, setQuery] = useState(initialSearch),
    [library, setLibrary] = useState(initialLibrary);
  const [entries, setEntries] = useState<LibraryEntry[]>([]),
    [libraries, setLibraries] = useState<string[]>([]);
  const [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const [resultsError, setResultsError] = useState('');
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null),
    [unit, setUnit] = useState(1);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [tab, setTab] = useState<'2d' | '3d'>('2d'),
    [model, setModel] = useState(0);
  const [tiPreview, setTiPreview] = useState('symbol');
  const [footprint, setFootprint] = useState<FootprintDetail | null>(null);
  const [footprintError, setFootprintError] = useState('');
  const ti = kind === 'symbols' ? tiPart(selected) : undefined;
  const results = useRef<HTMLDivElement>(null);
  const chosen = useRef(false);
  const composing = useRef(false);
  function invalidate() {
    setBusy(true);
    setResultsError('');
    setEntries([]);
    setSelected('');
    setDetail(null);
    chosen.current = false;
  }
  function loadMore() {
    if (busy || resultsError || entries.length >= total) return;
    setBusy(true);
    setOffset(entries.length);
  }
  function selectEntry(id: string) {
    if (id === selected) return;
    setDetail(null);
    setSelected(id);
    chosen.current = false;
  }
  useEffect(() => {
    const control = new AbortController();
    setBusy(true);
    setResultsError('');
    if (offset === 0) {
      setError('');
      setEntries([]);
      setSelected('');
      setDetail(null);
    }
    const timer = setTimeout(
      () =>
        void (
          kind === 'symbols' && library === 'ti-dcdc'
            ? Promise.resolve({
                json: async () => {
                  const matches = searchLibrary(tiDcdcParts, query);
                  return { entries: matches, total: matches.length, libraries };
                },
              })
            : capabilityHost
              ? capabilityHost
                  .query(
                    'library.search',
                    { kind, query, library, offset },
                    { signal: control.signal },
                  )
                  .then((data) => ({ json: async () => data }))
              : api(
                  `libraries/${kind}?q=${encodeURIComponent(query)}&library=${encodeURIComponent(library)}&offset=${offset}`,
                  { signal: control.signal },
                )
        )
          .then((r) => r.json())
          .then((data) => {
            if (control.signal.aborted) return;
            setEntries((current) => (offset === 0 ? data.entries : [...current, ...data.entries]));
            setLibraries(data.libraries);
            setTotal(data.entries.length ? data.total : offset);
            if (offset === 0) setSelected(data.entries[0]?.id || '');
            setBusy(false);
          })
          .catch((e) => {
            if (!control.signal.aborted) {
              setResultsError(e.message);
              setBusy(false);
            }
          }),
      180,
    );
    return () => {
      clearTimeout(timer);
      control.abort();
    };
  }, [kind, query, library, offset, retry, capabilityHost]);
  useEffect(() => {
    setDetail(null);
    setError('');
    setUnit(1);
    setTab(initialPreview);
    setModel(0);
    setTiPreview('symbol');
    if (!selected) return;
    const control = new AbortController();
    void (
      capabilityHost
        ? capabilityHost.query('library.detail', { kind, id: selected }, { signal: control.signal })
        : api(`libraries/${kind}?id=${encodeURIComponent(selected)}`, {
            signal: control.signal,
          }).then((r) => r.json())
    )
      .then((value) => {
        const data = value as Detail;
        if (!control.signal.aborted) setDetail(data);
      })
      .catch((e) => {
        if (!control.signal.aborted) setError(e.message);
      });
    return () => control.abort();
  }, [kind, selected, capabilityHost, initialPreview]);
  useEffect(() => {
    setFootprint(null);
    setFootprintError('');
    if (!ti) return;
    const control = new AbortController();
    void (
      capabilityHost
        ? capabilityHost.query(
            'library.detail',
            { kind: 'footprints', id: ti.footprint },
            { signal: control.signal },
          )
        : api(`libraries/footprints?id=${encodeURIComponent(ti.footprint)}`, {
            signal: control.signal,
          }).then((r) => r.json())
    )
      .then((value) => {
        const data = value as FootprintDetail;
        if (!control.signal.aborted) setFootprint(data);
      })
      .catch((e) => {
        if (!control.signal.aborted) setFootprintError(e.message);
      });
    return () => control.abort();
  }, [ti, capabilityHost]);
  const invalid =
    detail && 'error' in detail && detail.error
      ? detail.error
      : requireModel && detail && 'models' in detail && !detail.models.length
        ? 'This footprint has no 3D model.'
        : '';
  const ready = canChoose && !busy && !error && detail?.id === selected && !!detail && !invalid;
  const choose = () => {
    if (ready && detail && !chosen.current) {
      chosen.current = true;
      onChoose(detail, unit, model);
    }
  };
  function navigate(event: KeyboardEvent<HTMLElement>, focusResult: boolean) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) choose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || busy) return;
    event.preventDefault();
    const index = entries.findIndex((entry) => entry.id === selected);
    const nextIndex = Math.max(
      0,
      Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    const next = entries[nextIndex];
    if (!next) return;
    selectEntry(next.id);
    const row = results.current?.querySelector<HTMLButtonElement>(`[data-index="${nextIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    if (focusResult) row?.focus({ preventScroll: true });
    if (event.key === 'ArrowDown' && nextIndex >= entries.length - 5) loadMore();
  }
  return (
    <>
      <Dialog
        wide
        className={`library-chooser${kind === 'footprints' ? ' footprint-chooser assignment-dialog' : ''}`}
        title={title ?? (kind === 'symbols' ? 'Choose symbol' : 'Choose footprint')}
        label={label ?? (kind === 'symbols' ? 'Components' : 'Footprints')}
        icon={<Library size={20} />}
        onClose={onClose}
        footer={
          <>
            <div className="library-actions">
              <button className="dialog-button primary" disabled={!ready} onClick={choose}>
                {actionLabel ?? (kind === 'symbols' ? 'Place' : 'Assign footprint')}
              </button>
            </div>
          </>
        }
      >
        {header}
        <div className="library-search">
          <Search size={16} />
          <input
            autoFocus
            aria-label={kind === 'symbols' ? 'Search components' : 'Search footprints'}
            placeholder="Search by name, description or keyword…"
            value={query}
            onChange={(e) => {
              invalidate();
              setQuery(e.target.value);
              setOffset(0);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => navigate(event, false)}
          />
        </div>
        <div className="library-filter">
          <Select
            label="Library"
            popupMaxHeight={280}
            value={library}
            options={[
              { value: '', label: 'All libraries' },
              ...(kind === 'symbols'
                ? [{ value: 'ti-dcdc', label: 'Texas Instruments · DC/DC' }]
                : []),
              ...libraries.map((l) => ({ value: l, label: l })),
            ]}
            onChange={(v) => {
              invalidate();
              setLibrary(v);
              setOffset(0);
            }}
          />
          <span role="status">
            {busy ? (offset ? 'Loading…' : 'Searching…') : `${total.toLocaleString()} results`}
          </span>
        </div>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        {resultsError && (
          <div className="library-results-error" role="alert">
            <span>{resultsError}</span>
            <button
              className="icon-button"
              aria-label="Retry loading results"
              title="Retry"
              onClick={() => {
                setResultsError('');
                setBusy(true);
                setRetry((value) => value + 1);
              }}
            >
              <RotateCw size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className={`library-browser${kind === 'footprints' ? ' assignment-browser' : ''}`}>
          <div
            ref={results}
            className="library-results"
            aria-label="Library results"
            aria-busy={busy}
            onKeyDown={(event) => navigate(event, true)}
            onScroll={(event) => {
              const list = event.currentTarget;
              if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) loadMore();
            }}
          >
            {entries.map((entry, i) => (
              <button
                key={entry.id}
                data-index={i}
                className={selected === entry.id ? 'selected' : ''}
                aria-description={entry.id}
                tabIndex={selected === entry.id ? 0 : -1}
                aria-pressed={selected === entry.id}
                onFocus={() => selectEntry(entry.id)}
                onClick={() => selectEntry(entry.id)}
                onDoubleClick={() => {
                  if (detail?.id === entry.id) choose();
                }}
              >
                <strong>{entry.name}</strong>
                <small>{entry.library}</small>
              </button>
            ))}
            {!busy && !entries.length && !error && !resultsError && <p>No matching {kind}.</p>}
          </div>
          <div className={`library-detail${kind === 'footprints' ? ' assignment-detail' : ''}`}>
            {detail ? (
              <>
                <div className="library-detail-heading">
                  <strong className="library-detail-title">{detail.name}</strong>
                  <small className="library-detail-id" title={detail.id}>
                    {detail.id}
                  </small>
                </div>
                {'symbol' in detail ? (
                  <>
                    {ti && (
                      <div className="preview-tabs">
                        {[
                          ['symbol', 'Symbol'],
                          ['footprint', 'Footprint'],
                          ['3d', '3D model'],
                        ].map(([value, label]) => (
                          <button
                            key={value}
                            aria-pressed={tiPreview === value}
                            onClick={() => setTiPreview(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                    {!ti || tiPreview === 'symbol' ? (
                      <div className="symbol-detail-preview">
                        <SymbolPreview library={detail.symbol} unit={unit} />
                      </div>
                    ) : tiPreview === '3d' ? (
                      <Suspense fallback={<p role="status">Loading 3D model…</p>}>
                        <ModelPreview id={ti.footprint} index={0} />
                      </Suspense>
                    ) : footprint ? (
                      <FootprintPreview footprint={footprint.footprint} />
                    ) : (
                      <p role="status">{footprintError || 'Loading footprint…'}</p>
                    )}
                    {detail.units > 1 && (
                      <Select
                        label="Symbol unit"
                        value={String(unit)}
                        options={Array.from({ length: detail.units }, (_, i) => ({
                          value: String(i + 1),
                          label: `Unit ${i + 1}`,
                        }))}
                        onChange={(v) => setUnit(Number(v))}
                      />
                    )}
                    <p>{detail.description}</p>
                    <small>Footprint: {detail.footprint || 'Not assigned'}</small>
                  </>
                ) : (
                  <>
                    <div className="preview-tabs">
                      <button
                        aria-pressed={tab === '2d' || !detail.models.length}
                        onClick={() => setTab('2d')}
                      >
                        Footprint
                      </button>
                      <button
                        aria-pressed={tab === '3d' && !!detail.models.length}
                        disabled={!detail.models.length}
                        onClick={() => setTab('3d')}
                      >
                        3D model
                      </button>
                    </div>
                    <div className="library-preview-stage assignment-preview-stage">
                      {tab === '2d' || !detail.models.length ? (
                        <FootprintPreview footprint={detail.footprint} />
                      ) : (
                        <Suspense fallback={<p role="status">Loading 3D model…</p>}>
                          <ModelPreview id={detail.id} index={model} />
                        </Suspense>
                      )}
                    </div>
                    {tab === '3d' && detail.models.length > 1 && (
                      <Select
                        label="3D model"
                        value={String(model)}
                        options={detail.models.map((m, i) => ({
                          value: String(i),
                          label: m.path.split('/').at(-1)!,
                        }))}
                        onChange={(v) => setModel(Number(v))}
                      />
                    )}
                    <p>{detail.description}</p>
                    <small className="library-detail-meta">
                      {detail.pads.length} pads · {detail.models.length} 3D{' '}
                      {detail.models.length === 1 ? 'model' : 'models'}
                    </small>
                  </>
                )}
                {invalid && (
                  <p className="dialog-error" role="alert">
                    {invalid}
                  </p>
                )}
              </>
            ) : (
              <p>{selected ? 'Loading preview…' : 'Select a library entry.'}</p>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
