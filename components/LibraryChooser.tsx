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
import { propertyValue, unitGraphics, type LibraryEntry, type SymbolDetail } from '@/lib/library';
import { children, val, type SExpr } from '@/lib/sexpr';
import Dialog from './Dialog';
import Select from './Select';
import LibrarySourceSelect from './LibrarySourceSelect';
import SymbolPreview from './SymbolPreview';
import FootprintPreview from './FootprintPreview';
import WorkspaceLoading from './WorkspaceLoading';
const ModelPreview = lazy(() => import('./ModelPreview'));
export type FootprintDetail = LibraryEntry & {
  footprint: SExpr;
  pads: string[];
  models: { path: string }[];
};
type Detail = SymbolDetail | FootprintDetail;
function LibraryInfoSection({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section
      className={`library-info-section${wide ? ' library-info-wide' : ''}`}
      aria-label={title}
    >
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function LibraryInfoRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="library-detail-attributes">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LibraryInformation({ detail, unit }: { detail: Detail; unit: number }) {
  const symbol = 'symbol' in detail ? detail : null;
  const footprint = symbol
    ? symbol.footprint || propertyValue(symbol.symbol, 'Footprint')
    : detail.id;
  const datasheet = symbol ? propertyValue(symbol.symbol, 'Datasheet') : '';
  const descriptionRows: [string, ReactNode][] = [];
  if (detail.keywords) descriptionRows.push(['Keywords', detail.keywords]);
  if (datasheet && datasheet !== '~') descriptionRows.push(['Datasheet', datasheet]);
  const pins = symbol
    ? new Set(
        unitGraphics(symbol.symbol, unit).flatMap((node) =>
          children(node, 'pin').map((pin) => val(children(pin, 'number')[0])),
        ),
      ).size
    : 0;
  return (
    <div className="library-detail-sections">
      <LibraryInfoSection title="Basic information">
        <LibraryInfoRows
          rows={[
            ['Source', detail.library === 'NextPCB' ? 'NextPCB' : 'KiCad'],
            ['Library', detail.library],
            ...(detail.manufacturer
              ? [['Manufacturer', detail.manufacturer] as [string, ReactNode]]
              : []),
          ]}
        />
      </LibraryInfoSection>
      {symbol && (
        <LibraryInfoSection title="Symbol details">
          <LibraryInfoRows
            rows={[
              ['Units', symbol.units],
              [symbol.units > 1 ? 'Pins in unit' : 'Pins', pins],
              ['Reference prefix', propertyValue(symbol.symbol, 'Reference') || 'Not provided'],
            ]}
          />
        </LibraryInfoSection>
      )}
      <LibraryInfoSection title="Package" wide={Boolean(symbol)}>
        <LibraryInfoRows
          rows={[
            ...(detail.package ? [['Package', detail.package] as [string, ReactNode]] : []),
            ['Footprint', footprint || 'Not assigned'],
            ...(!('symbol' in detail) ? [['Pads', detail.pads.length] as [string, ReactNode]] : []),
          ]}
        />
      </LibraryInfoSection>
      {!('symbol' in detail) && (
        <LibraryInfoSection title="3D models" wide>
          <LibraryInfoRows
            rows={[
              ['Available models', detail.models.length],
              ...detail.models.map((model, index): [string, ReactNode] => [
                `Model ${index + 1}`,
                model.path,
              ]),
            ]}
          />
        </LibraryInfoSection>
      )}
      {(detail.description || descriptionRows.length > 0) && (
        <LibraryInfoSection title="Description" wide>
          {detail.description && <p>{detail.description}</p>}
          {descriptionRows.length > 0 && <LibraryInfoRows rows={descriptionRows} />}
        </LibraryInfoSection>
      )}
    </div>
  );
}
type BrowseSnapshot = {
  ready: boolean;
  query: string;
  submittedQuery: string | null;
  library: string;
  category: string;
  entries: LibraryEntry[];
  total: number;
  offset: number;
  nextOffset: number;
  selected: string;
  detail: Detail | null;
  unit: number;
  tab: '2d' | '3d';
  model: number;
};
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
  const [category, setCategory] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(initialSearch);
  const [entries, setEntries] = useState<LibraryEntry[]>([]),
    [libraries, setLibraries] = useState<string[]>([]);
  const [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const [nextOffset, setNextOffset] = useState(0);
  const [resultsError, setResultsError] = useState('');
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null),
    [unit, setUnit] = useState(1);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [tab, setTab] = useState<'2d' | '3d'>('2d'),
    [model, setModel] = useState(0);
  const results = useRef<HTMLDivElement>(null);
  const chosen = useRef(false);
  const composing = useRef(false);
  const sourceSnapshots = useRef(new Map<string, BrowseSnapshot>());
  const restoredSearch = useRef(false);
  const restoredDetail = useRef<BrowseSnapshot | null>(null);
  const awaitingSearch =
    library === 'NextPCB' && (submittedQuery === null || (!submittedQuery.trim() && !category));
  function invalidate() {
    setBusy(true);
    setResultsError('');
    setEntries([]);
    setTotal(0);
    setNextOffset(0);
    setSelected('');
    setDetail(null);
    chosen.current = false;
  }
  function loadMore() {
    if (busy || resultsError || nextOffset >= total) return;
    setBusy(true);
    setOffset(nextOffset);
  }
  function selectEntry(id: string) {
    if (id === selected) return;
    setDetail(null);
    setSelected(id);
    chosen.current = false;
  }
  function submitSearch() {
    if (composing.current) return;
    invalidate();
    setSubmittedQuery(query);
    setOffset(0);
    setRetry((value) => value + 1);
  }
  function changeLibrary(nextLibrary: string, nextCategory: string) {
    const source = library === 'NextPCB' ? 'NextPCB' : 'KiCad';
    const nextSource = nextLibrary === 'NextPCB' ? 'NextPCB' : 'KiCad';
    if (source !== nextSource)
      sourceSnapshots.current.set(source, {
        ready: !busy && !resultsError,
        query,
        submittedQuery,
        library,
        category,
        entries,
        total,
        offset,
        nextOffset,
        selected,
        detail,
        unit,
        tab,
        model,
      });
    const previous = source !== nextSource ? sourceSnapshots.current.get(nextSource) : undefined;
    if (previous) {
      nextLibrary = previous.library;
      nextCategory = previous.category;
    }
    invalidate();
    setLibrary(nextLibrary);
    setCategory(nextCategory);
    setOffset(0);
    if (source !== nextSource) {
      setQuery(previous?.query ?? '');
      setSubmittedQuery(previous ? previous.submittedQuery : '');
    } else setSubmittedQuery(query);
    if (previous?.ready && previous.library === nextLibrary && previous.category === nextCategory) {
      restoredSearch.current = true;
      restoredDetail.current = previous;
      setSubmittedQuery(previous.submittedQuery);
      setEntries(previous.entries);
      setTotal(previous.total);
      setOffset(previous.offset);
      setNextOffset(previous.nextOffset);
      setSelected(previous.selected);
      setDetail(previous.detail);
      setUnit(previous.unit);
      setTab(previous.tab);
      setModel(previous.model);
      setBusy(false);
    }
  }
  useEffect(() => {
    if (restoredSearch.current) {
      restoredSearch.current = false;
      return;
    }
    const control = new AbortController();
    if (awaitingSearch) {
      setBusy(false);
      return () => control.abort();
    }
    setBusy(true);
    setResultsError('');
    if (offset === 0) {
      setError('');
      setEntries([]);
      setTotal(0);
      setNextOffset(0);
      setSelected('');
      setDetail(null);
    }
    const timer = setTimeout(
      () =>
        void (
          capabilityHost
            ? capabilityHost
                .query(
                  'library.search',
                  {
                    kind,
                    query: library === 'NextPCB' ? submittedQuery : query,
                    library,
                    offset,
                    ...(category ? { category } : {}),
                  },
                  { signal: control.signal },
                )
                .then((data) => ({ json: async () => data }))
            : api(
                `libraries/${kind}?q=${encodeURIComponent(library === 'NextPCB' ? (submittedQuery ?? '') : query)}&library=${encodeURIComponent(library)}&offset=${offset}${category ? `&category=${encodeURIComponent(category)}` : ''}`,
                { signal: control.signal },
              )
        )
          .then((r) => r.json())
          .then((data) => {
            if (control.signal.aborted) return;
            const incoming = data.entries as LibraryEntry[];
            setEntries((current) => {
              const combined: LibraryEntry[] = offset === 0 ? [] : [...current];
              const ids = new Set(combined.map((entry) => entry.id));
              for (const entry of incoming) {
                if (ids.has(entry.id)) continue;
                ids.add(entry.id);
                combined.push(entry);
              }
              return combined;
            });
            // Remote pages can overlap. Paging follows consumed provider rows,
            // independently of the unique entries displayed in the chooser.
            setNextOffset(offset + incoming.length);
            if (library !== 'NextPCB') setLibraries(data.libraries);
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
  }, [
    kind,
    query,
    submittedQuery,
    library,
    category,
    offset,
    retry,
    capabilityHost,
    awaitingSearch,
  ]);
  useEffect(() => {
    const restored = restoredDetail.current;
    restoredDetail.current = null;
    if (restored?.selected === selected && restored.detail) {
      setError('');
      return;
    }
    setDetail(null);
    setError('');
    setUnit(1);
    setTab(initialPreview);
    setModel(0);
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
        <div className="library-filter">
          <LibrarySourceSelect
            kind={kind}
            library={library}
            category={category}
            libraries={libraries}
            capabilityHost={capabilityHost}
            browseOnEmpty={query.trim() === ''}
            onChange={changeLibrary}
          />
          <span className="library-result-status" role="status">
            {awaitingSearch
              ? 'Ready to search'
              : busy
                ? offset
                  ? 'Loading…'
                  : 'Searching…'
                : resultsError && !entries.length
                  ? 'Unavailable'
                  : `${total.toLocaleString()} results`}
          </span>
        </div>
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
              if (library === 'NextPCB') {
                setSubmittedQuery(e.target.value.trim() ? null : '');
                setBusy(false);
                setTotal(0);
              }
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !composing.current &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) submitSearch();
              } else navigate(event, false);
            }}
          />
          <button className="dialog-button library-search-submit" onClick={submitSearch}>
            Search
          </button>
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
            className={`library-results${kind === 'symbols' ? ' library-component-results' : ''}`}
            aria-label="Library results"
            aria-busy={busy}
            onKeyDown={(event) => navigate(event, true)}
            onScroll={(event) => {
              const list = event.currentTarget;
              if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) loadMore();
            }}
          >
            {kind === 'symbols' && (
              <div className="library-result-columns" aria-hidden="true">
                <span>
                  {library === 'NextPCB' ? 'Model / Manufacturer' : 'Component / Library'}
                </span>
                <span>Package</span>
              </div>
            )}
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
                {kind === 'symbols' ? (
                  <>
                    <span className="library-result-identity">
                      <strong title={entry.name}>{entry.name}</strong>
                      <small title={entry.manufacturer || entry.library}>
                        {entry.manufacturer || entry.library}
                      </small>
                    </span>
                    <span
                      className="library-result-package"
                      title={entry.package || entry.footprint || ''}
                    >
                      {entry.package || entry.footprint?.split(':').at(-1) || '—'}
                    </span>
                  </>
                ) : (
                  <>
                    <strong>{entry.name}</strong>
                    <small>{entry.library}</small>
                  </>
                )}
              </button>
            ))}
            {!busy && !entries.length && !error && !resultsError && (
              <p>
                {awaitingSearch ? 'Enter a model or keyword, then search.' : `No matching ${kind}.`}
              </p>
            )}
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
                    <div className="symbol-detail-preview">
                      <SymbolPreview library={detail.symbol} unit={unit} />
                    </div>
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
                    {detail.warning && <p role="status">{detail.warning}</p>}
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
                        <Suspense fallback={<WorkspaceLoading panel label="Loading 3D model" />}>
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
                  </>
                )}
                <LibraryInformation detail={detail} unit={unit} />
                {invalid && (
                  <p className="dialog-error" role="alert">
                    {invalid}
                  </p>
                )}
              </>
            ) : selected ? (
              <WorkspaceLoading panel label="Loading preview" />
            ) : (
              <p>Select a library entry.</p>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
