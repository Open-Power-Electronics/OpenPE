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
import { Search, SearchX, Library, RotateCw, Check, ChevronRight } from 'lucide-react';
import { api } from '@/lib/bridge';
import type { CapabilityHost } from '@/api/capabilities';
import {
  catalogSource,
  isOnlineLibrary,
  propertyValue,
  unitGraphics,
  type LibraryEntry,
  type SymbolDetail,
} from '@/lib/library';
import { children, val, type SExpr } from '@/lib/sexpr';
import Dialog from './Dialog';
import Select from './Select';
import LibrarySourceSelect, {
  type LibraryCategoryReload,
  type LibraryCategoryStatus,
} from './LibrarySourceSelect';
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
function readLibraryDetail(
  kind: 'symbols' | 'footprints',
  id: string,
  signal: AbortSignal,
  host?: CapabilityHost,
) {
  return (
    host
      ? host.query('library.detail', { kind, id }, { signal })
      : api(`libraries/${kind}?id=${encodeURIComponent(id)}`, { signal }).then((r) => r.json())
  ) as Promise<Detail>;
}

function OnlineSymbolPreview({
  detail,
  unit,
  host,
  error,
  onError,
  retry,
}: {
  detail: SymbolDetail;
  unit: number;
  host?: CapabilityHost;
  error: string;
  onError: (message: string) => void;
  retry: number;
}) {
  const [tab, setTab] = useState<'symbol' | 'footprint' | '3d'>('symbol');
  const [footprint, setFootprint] = useState<FootprintDetail | null>(null);
  const showPackage = tab !== 'symbol';
  const identity = detail.footprint;
  useEffect(() => {
    if (!showPackage || !identity || footprint) return;
    const control = new AbortController();
    onError('');
    void readLibraryDetail('footprints', identity, control.signal, host)
      .then((loaded) => {
        if (!('pads' in loaded) || loaded.id !== identity)
          throw new Error('The footprint preview is unavailable.');
        if (!control.signal.aborted) setFootprint(loaded);
      })
      .catch((error) => {
        if (!control.signal.aborted) onError(error.message);
      });
    return () => control.abort();
  }, [showPackage, identity, footprint, retry, host, onError]);
  return (
    <>
      {identity && (
        <div className="preview-tabs">
          <button
            aria-pressed={tab === 'symbol'}
            onClick={() => {
              onError('');
              setTab('symbol');
            }}
          >
            Symbol
          </button>
          <button aria-pressed={tab === 'footprint'} onClick={() => setTab('footprint')}>
            Footprint
          </button>
          <button
            aria-pressed={tab === '3d'}
            disabled={footprint?.models.length === 0}
            onClick={() => setTab('3d')}
          >
            3D model
          </button>
        </div>
      )}
      <div className="symbol-detail-preview">
        {!showPackage ? (
          <SymbolPreview library={detail.symbol} unit={unit} />
        ) : error ? null : !footprint ? (
          <WorkspaceLoading panel label="Loading footprint preview" />
        ) : tab === 'footprint' ? (
          <FootprintPreview footprint={footprint.footprint} />
        ) : footprint.models.length ? (
          <Suspense fallback={<WorkspaceLoading panel label="Loading 3D model" />}>
            <ModelPreview id={footprint.id} />
          </Suspense>
        ) : (
          <p>This footprint has no 3D model.</p>
        )}
      </div>
    </>
  );
}
const libraryHomepages = [
  { id: 'jlceda', label: 'JLCEDA', domain: 'lceda.cn', href: 'https://lceda.cn/' },
  { id: 'easyeda', label: 'EasyEDA', domain: 'easyeda.com', href: 'https://easyeda.com/' },
] as const;

function englishNoticeSections(notice: string) {
  const [intro, ...sections] = notice.split(/【[^】/]+\/([A-Za-z][A-Za-z ]*)】/u);
  const parts = [{ heading: '', text: intro }];
  for (let i = 0; i < sections.length; i += 2)
    parts.push({ heading: sections[i], text: sections[i + 1] });
  const han = /\p{Script=Han}/u;
  return parts
    .map(({ heading, text }) => ({
      heading,
      text: han.test(text)
        ? text
            .split(/[\r\n。！？]+/u)
            .map((line) => line.trim())
            .filter((line) => /[A-Za-z]/.test(line) && !han.test(line))
            .join('\n')
        : text.trim(),
    }))
    .filter(({ text }) => text);
}

function JlcpcbAttribution({ notice }: { notice: string }) {
  const [linkError, setLinkError] = useState(false);
  const sections = englishNoticeSections(notice);
  function guardActivation(event: KeyboardEvent<HTMLElement>) {
    if (event.repeat || event.nativeEvent.isComposing || event.keyCode === 229)
      event.preventDefault();
  }
  return (
    <section className="library-info-section library-cad-source" aria-label="CAD source">
      <h3>JLCEDA/EasyEDA Official Library</h3>
      <div className="library-cad-source-links">
        {libraryHomepages.map(({ id, label, domain, href }) => (
          <a
            key={id}
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`${label} official website`}
            onKeyDown={guardActivation}
            onClick={(event) => {
              const desktop = window.openpe;
              if (!desktop) return;
              event.preventDefault();
              setLinkError(false);
              void desktop.openLibraryHomepage(id).catch(() => setLinkError(true));
            }}
          >
            {domain}
          </a>
        ))}
      </div>
      {sections.length > 0 && (
        <details className="library-cad-source-notice">
          <summary aria-label="Library terms" onKeyDown={guardActivation}>
            <ChevronRight size={16} aria-hidden="true" />
          </summary>
          <div className="library-cad-source-terms" lang="en" tabIndex={0}>
            {sections.map(({ heading, text }, index) => (
              <p key={index}>
                {heading && <strong>{heading}</strong>}
                {text}
              </p>
            ))}
          </div>
        </details>
      )}
      {linkError && <p role="status">Could not open the official website.</p>}
    </section>
  );
}

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
            ['Source', catalogSource(detail.library)],
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
  submittedQuery: string;
  library: string;
  category: string;
  entries: LibraryEntry[];
  total: number;
  offset: number;
  nextOffset: number | null;
  previewRequested: boolean;
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
  const [submittedQuery, setSubmittedQuery] = useState(initialSearch);
  const [entries, setEntries] = useState<LibraryEntry[]>([]),
    [libraries, setLibraries] = useState<string[]>([]);
  const [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState('');
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [resultsError, setResultsError] = useState('');
  const [previewRequested, setPreviewRequested] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [packagePreviewError, setPackagePreviewError] = useState('');
  const [packagePreviewRetry, setPackagePreviewRetry] = useState(0);
  const [retry, setRetry] = useState(0);
  const [categoryStatus, setCategoryStatus] = useState<LibraryCategoryStatus>({
    source: '',
    pending: false,
    error: '',
    reloadSerial: 0,
  });
  const [categoryReload, setCategoryReload] = useState<LibraryCategoryReload | null>(null);
  const categoryReloadSerial = useRef(0);
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
  const librarySource = catalogSource(library);
  const online = isOnlineLibrary(library);
  const previewEntry =
    online && !previewRequested ? entries.find((entry) => entry.id === selected) : undefined;
  const failedCategories = categoryStatus.source === librarySource && Boolean(categoryStatus.error);
  const retryingCategories = categoryReload?.source === librarySource;
  const suggestedCategoryId =
    library === 'NextPCB' && !category && !submittedQuery.trim()
      ? categoryStatus.browseCategoryId
      : undefined;
  const searchCategory = category || suggestedCategoryId || '';
  const awaitingSearch = librarySource === 'NextPCB' && !submittedQuery.trim() && !searchCategory;
  const waitingCategories =
    librarySource === 'NextPCB' &&
    !submittedQuery.trim() &&
    (categoryStatus.source !== librarySource || categoryStatus.pending);
  const loadingInitial =
    retryingCategories ||
    (!error && !resultsError && ((!awaitingSearch && busy) || waitingCategories));
  const hasEntries = entries.length > 0;
  const canLoadMore = isOnlineLibrary(library) && nextOffset !== null && !resultsError;
  const EmptyIcon = awaitingSearch ? Search : SearchX;
  const chooseLabel = actionLabel ?? (kind === 'symbols' ? 'Place' : 'Assign footprint');
  const refreshDisabled =
    busy || waitingCategories || retryingCategories || (awaitingSearch && !failedCategories);
  function blockComposingActivation(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function invalidate() {
    setBusy(true);
    setResultsError('');
    setPreviewRequested(false);
    setPackagePreviewError('');
    setEntries([]);
    setTotal(0);
    setNextOffset(null);
    setSelected('');
    setDetail(null);
    chosen.current = false;
  }
  function loadMore() {
    if (busy || resultsError || nextOffset === null) return;
    setBusy(true);
    setOffset(nextOffset);
  }
  function selectEntry(id: string) {
    if (online) setPreviewRequested(true);
    if (id === selected) return;
    setPackagePreviewError('');
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
  function refreshResults() {
    if (composing.current || refreshDisabled) return;
    if (resultsError) {
      setResultsError('');
      setBusy(true);
      setRetry((value) => value + 1);
      return;
    }
    if (error && selected) {
      setPreviewRetry((value) => value + 1);
      return;
    }
    if (packagePreviewError) {
      setPackagePreviewRetry((value) => value + 1);
      return;
    }
    if (failedCategories) {
      setCategoryReload({ source: librarySource, serial: ++categoryReloadSerial.current });
      return;
    }
    invalidate();
    setOffset(0);
    setRetry((value) => value + 1);
  }
  function changeLibrary(nextLibrary: string, nextCategory: string) {
    if (nextLibrary === library && nextCategory === category) return;
    setCategoryReload(null);
    const source = librarySource;
    const nextSource = catalogSource(nextLibrary);
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
        previewRequested,
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
      setPreviewRequested(previous.previewRequested);
      setSelected(previous.selected);
      setDetail(previous.detail);
      setUnit(previous.unit);
      setTab(previous.tab);
      setModel(previous.model);
      setBusy(false);
    }
  }
  useEffect(() => {
    if (
      !categoryReload ||
      categoryReload.source !== librarySource ||
      categoryStatus.source !== librarySource ||
      categoryStatus.reloadSerial !== categoryReload.serial ||
      categoryStatus.pending
    )
      return;
    setCategoryReload(null);
    if (!categoryStatus.error && !awaitingSearch) {
      invalidate();
      setOffset(0);
      setRetry((value) => value + 1);
    }
  }, [categoryReload, librarySource, categoryStatus, awaitingSearch]);
  useEffect(() => {
    if (restoredSearch.current) {
      restoredSearch.current = false;
      return;
    }
    const control = new AbortController();
    if (awaitingSearch || retryingCategories) {
      if (!retryingCategories) setBusy(false);
      return () => control.abort();
    }
    setBusy(true);
    setResultsError('');
    if (offset === 0) {
      setError('');
      setPreviewRequested(false);
      setEntries([]);
      setTotal(0);
      setNextOffset(null);
      setSelected('');
      setDetail(null);
    }
    const start = () =>
      void (
        capabilityHost
          ? capabilityHost
              .query(
                'library.search',
                {
                  kind,
                  query: submittedQuery,
                  library,
                  offset,
                  ...(searchCategory ? { category: searchCategory } : {}),
                },
                { signal: control.signal },
              )
              .then((data) => ({ json: async () => data }))
          : api(
              `libraries/${kind}?q=${encodeURIComponent(submittedQuery)}&library=${encodeURIComponent(library)}&offset=${offset}${searchCategory ? `&category=${encodeURIComponent(searchCategory)}` : ''}`,
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
          if (isOnlineLibrary(library)) {
            setNextOffset(data.nextOffset);
          } else {
            const consumed = offset + incoming.length;
            setNextOffset(incoming.length && consumed < data.total ? consumed : null);
            setLibraries(data.libraries);
            setTotal(data.total);
          }
          if (incoming.length) setSelected((current) => current || incoming[0].id);
          setBusy(false);
        })
        .catch((e) => {
          if (!control.signal.aborted) {
            setResultsError(e.message);
            setBusy(false);
          }
        });
    start();
    return () => control.abort();
  }, [
    kind,
    submittedQuery,
    library,
    category,
    searchCategory,
    offset,
    retry,
    capabilityHost,
    awaitingSearch,
    retryingCategories,
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
    setTab(online ? '2d' : initialPreview);
    setModel(0);
    if (!selected || (online && !previewRequested)) return;
    const control = new AbortController();
    void readLibraryDetail(kind, selected, control.signal, capabilityHost)
      .then((value) => {
        const data = value as Detail;
        if (!control.signal.aborted) setDetail(data);
      })
      .catch((e) => {
        if (!control.signal.aborted) setError(e.message);
      });
    return () => control.abort();
  }, [kind, selected, capabilityHost, initialPreview, online, previewRequested, previewRetry]);
  const invalid =
    detail && 'error' in detail && detail.error
      ? detail.error
      : requireModel && detail && 'models' in detail && !detail.models.length
        ? 'This footprint has no 3D model.'
        : '';
  const ready = canChoose && !busy && !error && detail?.id === selected && !!detail && !invalid;
  const footerError =
    resultsError ||
    error ||
    packagePreviewError ||
    invalid ||
    (failedCategories && categoryStatus.error);
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
            {footerError && (
              <p className="library-footer-feedback" role="alert">
                {footerError}
              </p>
            )}
            <div className="dialog-footer-toolbar">
              <button
                className="icon-button dialog-footer-icon"
                aria-label={
                  resultsError
                    ? 'Retry loading results'
                    : error || packagePreviewError
                      ? 'Retry loading preview'
                      : 'Refresh library'
                }
                title={resultsError || error || packagePreviewError ? 'Retry' : 'Refresh'}
                disabled={refreshDisabled}
                onClick={refreshResults}
                onKeyDown={blockComposingActivation}
              >
                <RotateCw size={18} aria-hidden="true" />
              </button>
              <button
                className="dialog-button primary dialog-footer-icon"
                aria-label={chooseLabel}
                title={chooseLabel}
                disabled={!ready}
                onClick={choose}
                onKeyDown={blockComposingActivation}
              >
                <Check size={18} aria-hidden="true" />
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
            reload={categoryReload}
            onStatus={setCategoryStatus}
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
                  : isOnlineLibrary(library)
                    ? `${entries.length.toLocaleString()} ${entries.length === 1 ? 'result' : 'results'} loaded`
                    : `${total.toLocaleString()} results`}
          </span>
        </div>
        <div className="library-search">
          <Search size={16} />
          <input
            autoFocus
            aria-label={kind === 'symbols' ? 'Search components' : 'Search footprints'}
            placeholder={
              librarySource === 'JLCPCB'
                ? 'Search by model, keyword or part number…'
                : 'Search by name, description or keyword…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
          <button
            className="dialog-button library-search-submit"
            onClick={submitSearch}
            onKeyDown={blockComposingActivation}
          >
            Search
          </button>
        </div>
        <div
          className={`library-browser${kind === 'footprints' ? ' assignment-browser' : ''}${hasEntries ? '' : ' library-browser-empty'}`}
        >
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
            {hasEntries && kind === 'symbols' && (
              <div className="library-result-columns" aria-hidden="true">
                <span>{isOnlineLibrary(library) ? 'Model' : 'Component'}</span>
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
                    <strong title={entry.name}>{entry.name}</strong>
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
            {!hasEntries && loadingInitial && <WorkspaceLoading panel label="Loading library" />}
            {!busy &&
              !hasEntries &&
              !error &&
              !resultsError &&
              !loadingInitial &&
              !categoryStatus.error && (
                <div className="library-empty-state">
                  <span className="library-empty-icon">
                    <EmptyIcon size={20} aria-hidden="true" />
                  </span>
                  <h3>
                    {awaitingSearch
                      ? 'Search the library'
                      : canLoadMore
                        ? 'No matching footprints in this batch.'
                        : `No matching ${kind}.`}
                  </h3>
                  {awaitingSearch ? (
                    <p>Enter a model or keyword, then search.</p>
                  ) : (
                    !canLoadMore && <p>Try another keyword or category.</p>
                  )}
                </div>
              )}
            {canLoadMore && (
              <button
                className={`library-load-more${hasEntries ? '' : ' dialog-button secondary'}`}
                disabled={busy}
                onClick={loadMore}
                onKeyDown={(event) => {
                  blockComposingActivation(event);
                  if (event.key === 'Enter') {
                    event.stopPropagation();
                    if (event.repeat || composing.current) event.preventDefault();
                  }
                }}
              >
                Load more
              </button>
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
                    {online ? (
                      <OnlineSymbolPreview
                        key={detail.id}
                        detail={detail}
                        unit={unit}
                        host={capabilityHost}
                        error={packagePreviewError}
                        onError={setPackagePreviewError}
                        retry={packagePreviewRetry}
                      />
                    ) : (
                      <div className="symbol-detail-preview">
                        <SymbolPreview library={detail.symbol} unit={unit} />
                      </div>
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
                {detail.library === 'JLCPCB' && detail.attribution && (
                  <JlcpcbAttribution key={detail.id} notice={detail.attribution.notice} />
                )}
              </>
            ) : previewEntry ? (
              <>
                <div className="library-detail-heading">
                  <strong className="library-detail-title">{previewEntry.name}</strong>
                  <small className="library-detail-id">{previewEntry.id}</small>
                </div>
                <div className="library-detail-sections">
                  <LibraryInfoSection title="Basic information" wide>
                    <LibraryInfoRows
                      rows={[
                        ['Source', librarySource],
                        ...(previewEntry.manufacturer
                          ? [['Manufacturer', previewEntry.manufacturer] as [string, ReactNode]]
                          : []),
                        ...(previewEntry.package
                          ? [['Package', previewEntry.package] as [string, ReactNode]]
                          : []),
                      ]}
                    />
                  </LibraryInfoSection>
                  {previewEntry.description && (
                    <LibraryInfoSection title="Description" wide>
                      <p>{previewEntry.description}</p>
                    </LibraryInfoSection>
                  )}
                </div>
                <button
                  className="dialog-button secondary library-preview-action"
                  onClick={() => selectEntry(previewEntry.id)}
                  onKeyDown={blockComposingActivation}
                >
                  Preview
                </button>
              </>
            ) : !error && selected ? (
              <WorkspaceLoading panel label="Loading preview" />
            ) : null}
          </div>
        </div>
      </Dialog>
    </>
  );
}
