'use client';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  CircleAlert,
  Search,
  SearchX,
  Library,
  RotateCw,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Square,
  SquareCheck,
} from 'lucide-react';
import { api } from '@/lib/bridge';
import type { CapabilityHost } from '@/api/capabilities';
import {
  catalogSource,
  footprintSearchTerm,
  isLibraryAssetUnavailable,
  isLibraryPriceSource,
  isOnlineLibrary,
  libraryPriceSources,
  onlineFootprintLibrary,
  propertyValue,
  unitGraphics,
  type LibraryEntry,
  type LibraryPrice,
  type LibraryPriceSource,
  type SymbolDetail,
} from '@/lib/library';
import {
  isLibrarySearchProgress,
  readLibrarySearch,
  type LibrarySearchPage,
  type LibrarySearchProgress,
} from '@/lib/library-search';
import { child, children, val, type SExpr } from '@/lib/sexpr';
import { parseProject } from '@/lib/project';
import { projectFootprintSource } from '@/lib/library-project-assets';
import { footprintModels } from '@/lib/pcb-models';
import { previewProjectComponentModel } from '@/lib/pcb-preview-cache';
import { modelReferenceKey } from '@/lib/example-model-paths';
import Dialog from './Dialog';
import Select from './Select';
import LibrarySourceSelect, {
  type LibraryCategoryReload,
  type LibraryCategoryStatus,
} from './LibrarySourceSelect';
import SymbolPreview from './SymbolPreview';
import FootprintPreview, { canPreviewFootprint } from './FootprintPreview';
import WorkspaceLoading, { LoadingProgress } from './WorkspaceLoading';
const ModelPreview = lazy(() => import('./ModelPreview'));
export type FootprintDetail = Omit<LibraryEntry, 'footprint'> & {
  footprint: SExpr;
  pads: string[];
  models: { path: string }[];
  projectAssets?: true;
};
type Detail = SymbolDetail | FootprintDetail;

function readProjectFootprint(source: string, id: string): FootprintDetail | undefined {
  const library = onlineFootprintLibrary(id);
  if (!library) return;
  const local = projectFootprintSource(parseProject(source), id);
  if (!local) return;
  return {
    id,
    library,
    name: footprintSearchTerm(id),
    description: val(child(local.footprint, 'descr')),
    keywords: val(child(local.footprint, 'tags')),
    footprint: local.footprint,
    pads: [...new Set(children(local.footprint, 'pad').map((pad) => val(pad)).filter(Boolean))],
    models: footprintModels(local.footprint),
    projectAssets: true,
  };
}
const symbolColumns = [
  ['name', 'Name'],
  ['package', 'Package'],
  ['footprint', 'Footprint'],
  ['model', 'Model'],
] as const;
type SymbolColumn = (typeof symbolColumns)[number][0];
type SymbolSort = { column: SymbolColumn; direction: 'ascending' | 'descending' };
type AssetStatus = 'yes' | 'no' | 'unknown';
type SymbolAssets = { footprint: AssetStatus; model: AssetStatus };
const symbolAssetStates: Record<
  NonNullable<LibraryEntry['footprintPreview']> | 'unknown',
  SymbolAssets
> = {
  unavailable: { footprint: 'no', model: 'no' },
  '2d': { footprint: 'yes', model: 'no' },
  '2d-and-3d': { footprint: 'yes', model: 'yes' },
  unknown: { footprint: 'unknown', model: 'unknown' },
};
const assetRank: Record<AssetStatus, number> = { yes: 1, no: 0, unknown: 0 };
const assetLabels: Record<AssetStatus, string> = {
  yes: 'Available',
  no: 'Unavailable',
  unknown: 'Unknown',
};
const catalogCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function symbolPackage(entry: LibraryEntry) {
  return entry.package || entry.footprint?.split(':').at(-1) || '';
}

function listedSymbolAssets(entry: LibraryEntry) {
  return symbolAssetStates[entry.footprintPreview ?? 'unknown'];
}

function compareSymbolRows(
  first: LibraryEntry,
  second: LibraryEntry,
  { column, direction }: SymbolSort,
) {
  const sign = direction === 'ascending' ? 1 : -1;
  if (column === 'name') return sign * catalogCollator.compare(first.name, second.name);
  if (column === 'package') {
    const firstPackage = symbolPackage(first);
    const secondPackage = symbolPackage(second);
    return (
      Number(!firstPackage) - Number(!secondPackage) ||
      sign * catalogCollator.compare(firstPackage, secondPackage)
    );
  }
  const firstAsset = listedSymbolAssets(first)[column];
  const secondAsset = listedSymbolAssets(second)[column];
  return (
    Number(firstAsset === 'unknown') - Number(secondAsset === 'unknown') ||
    sign * (assetRank[firstAsset] - assetRank[secondAsset])
  );
}

const noModel = 'This footprint has no 3D model.';
const noFootprintPreview = 'This footprint has no supported 2D preview.';
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

function LibraryModelSelect({
  models,
  index,
  unavailable,
  onChange,
}: {
  models: FootprintDetail['models'];
  index: number;
  unavailable?: Record<number, string>;
  onChange: (index: number) => void;
}) {
  return (
    <Select
      label="3D model"
      value={String(index)}
      options={models.map(({ path }, i) => ({
        value: String(i),
        label: path.split('/').at(-1)!,
        disabled: !!unavailable?.[i],
        description: unavailable?.[i],
      }))}
      onChange={(value) => onChange(Number(value))}
    />
  );
}

const previewTabs = ['symbol', 'footprint', '3d'] as const;
type PreviewTab = (typeof previewTabs)[number];

function LibraryPreviewStage({
  active,
  className,
  previews,
  fallback,
}: {
  active: PreviewTab;
  className: string;
  previews: Partial<Record<PreviewTab, ReactNode>>;
  fallback?: ReactNode;
}) {
  const [visited, setVisited] = useState(() => new Set([active]));
  if (!visited.has(active)) setVisited(new Set([...visited, active]));
  return (
    <div className={className}>
      {previewTabs.map((tab) =>
        visited.has(tab) && previews[tab] ? (
          <div key={tab} className="library-preview-pane" hidden={tab !== active}>
            {previews[tab]}
          </div>
        ) : null,
      )}
      {fallback}
    </div>
  );
}

function LibrarySymbolPreview({
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
  const [tab, setTab] = useState<PreviewTab>('symbol');
  const [footprint, setFootprint] = useState<FootprintDetail | null>(null);
  const [packageUnavailable, setPackageUnavailable] = useState('');
  const [modelIndex, setModelIndex] = useState(0);
  const [unavailableModels, setUnavailableModels] = useState<Record<number, string>>({});
  const identity = (detail.footprint || propertyValue(detail.symbol, 'Footprint')).trim();
  const packageReason =
    packageUnavailable ||
    (detail.footprintPreview === 'unavailable' ? detail.warning || noFootprintPreview : '') ||
    (!identity ? 'This symbol has no linked footprint.' : '');
  const footprintReason =
    packageReason ||
    (footprint && !canPreviewFootprint(footprint.footprint) ? noFootprintPreview : '');
  const hasNoModel = footprint ? !footprint.models.length : detail.footprintPreview === '2d';
  const modelUnavailable = unavailableModels[modelIndex];
  const allModelsUnavailable = !!footprint?.models.every((_, index) => unavailableModels[index]);
  const modelReason =
    packageReason || (hasNoModel ? noModel : allModelsUnavailable ? modelUnavailable : '');
  let activeTab = tab;
  if (activeTab === '3d' && modelReason) activeTab = 'footprint';
  if (activeTab === 'footprint' && footprintReason) activeTab = 'symbol';
  const showPackage = activeTab !== 'symbol';
  const previewNotice =
    modelUnavailable ||
    (tab === '3d' && hasNoModel && noModel) ||
    (!packageReason && !footprint && detail.warning);
  useEffect(() => {
    if (!showPackage || !identity || footprint || packageReason) return;
    const control = new AbortController();
    onError('');
    void readLibraryDetail('footprints', identity, control.signal, host)
      .then((loaded) => {
        if (!('pads' in loaded) || loaded.id !== identity)
          throw new Error('The footprint preview is unavailable.');
        if (!control.signal.aborted) setFootprint(loaded);
      })
      .catch((error) => {
        if (control.signal.aborted) return;
        if (isLibraryAssetUnavailable(error)) setPackageUnavailable(error.message);
        else onError(error.message);
      });
    return () => control.abort();
  }, [showPackage, identity, footprint, packageReason, retry, host, onError]);
  return (
    <>
      <div className="preview-tabs">
        <button
          aria-pressed={activeTab === 'symbol'}
          onClick={() => {
            onError('');
            setTab('symbol');
          }}
        >
          Symbol
        </button>
        <button
          aria-pressed={activeTab === 'footprint'}
          disabled={!!footprintReason}
          title={footprintReason || undefined}
          onClick={() => setTab('footprint')}
        >
          Footprint
        </button>
        <button
          aria-pressed={activeTab === '3d'}
          disabled={!!modelReason}
          title={modelReason || undefined}
          onClick={() => setTab('3d')}
        >
          3D model
        </button>
      </div>
      <LibraryPreviewStage
        active={activeTab}
        className="symbol-detail-preview"
        previews={{
          symbol: <SymbolPreview library={detail.symbol} unit={unit} interactive />,
          footprint: footprint && <FootprintPreview footprint={footprint.footprint} />,
          '3d': footprint && !modelReason && !modelUnavailable && (
            <Suspense fallback={<WorkspaceLoading panel label="Loading 3D model" />}>
              <ModelPreview
                key={modelIndex}
                id={footprint.id}
                index={modelIndex}
                active={activeTab === '3d'}
                onUnavailable={(message) =>
                  setUnavailableModels((current) => ({ ...current, [modelIndex]: message }))
                }
              />
            </Suspense>
          ),
        }}
        fallback={
          showPackage &&
          !error &&
          !footprint && <WorkspaceLoading panel label="Loading footprint preview" />
        }
      />
      {activeTab === '3d' && footprint && footprint.models.length > 1 && (
        <LibraryModelSelect
          models={footprint.models}
          index={modelIndex}
          unavailable={unavailableModels}
          onChange={setModelIndex}
        />
      )}
      {previewNotice && <p role="status">{previewNotice}</p>}
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

function isLibraryPrice(value: unknown, source: LibraryPriceSource): value is LibraryPrice {
  const quote = value as Partial<LibraryPrice> | null;
  return (
    quote?.source === source &&
    quote.currency === 'USD' &&
    typeof quote.checkedAt === 'number' &&
    Number.isSafeInteger(quote.checkedAt) &&
    quote.checkedAt > 0 &&
    quote.checkedAt <= 8.64e15 &&
    Array.isArray(quote.offers) &&
    quote.offers.length <= 4 &&
    quote.offers.every(
      (offer) =>
        offer &&
        typeof offer.sku === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(offer.sku) &&
        (offer.manufacturer === null ||
          (typeof offer.manufacturer === 'string' &&
            offer.manufacturer.trim().length > 0 &&
            offer.manufacturer.length <= 200)) &&
        (offer.stock === undefined || (Number.isSafeInteger(offer.stock) && offer.stock >= 0)) &&
        Array.isArray(offer.tiers) &&
        offer.tiers.length > 0 &&
        offer.tiers.length <= 32 &&
        offer.tiers.every(
          (tier: LibraryPrice['offers'][number]['tiers'][number]) =>
            tier &&
            Number.isSafeInteger(tier.quantity) &&
            tier.quantity > 0 &&
            Number.isFinite(tier.unitPrice) &&
            tier.unitPrice > 0,
        ),
    )
  );
}

const priceCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 8,
});
const priceQuantity = new Intl.NumberFormat('en-US');
const priceSourceLabels = { lcsc: 'LCSC Electronics', huaqiu: 'HQ Online' };
const priceSourceOptions = libraryPriceSources.map((value) => ({
  value,
  label: priceSourceLabels[value],
}));
const priceSourceNames = priceSourceOptions.map(({ label }) => label);

function LibraryPricing({
  id,
  kind,
  source,
  onSourceChange,
  composing,
  onKeyDown,
}: {
  id: string;
  kind: 'symbols' | 'footprints';
  source: LibraryPriceSource;
  onSourceChange: (source: LibraryPriceSource) => void;
  composing: () => boolean;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const pending = useRef<AbortController | null>(null);
  const [quotes, setQuotes] = useState<Partial<Record<LibraryPriceSource, LibraryPrice>>>({});
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<'service' | 'quote' | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const quote = quotes[source];
  const sourceLabel = priceSourceLabels[source];

  function changeSource(value: string) {
    if (composing() || !isLibraryPriceSource(value) || value === source) return;
    pending.current?.abort();
    pending.current = null;
    setLoading(false);
    setFailure(null);
    onSourceChange(value);
  }

  async function refresh() {
    if (pending.current || composing()) return;
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    setFailure(null);
    try {
      const query = new URLSearchParams({ id, kind, source });
      const response = await api(`library-price?${query}`, {
        signal: request.signal,
        cache: 'no-store',
      });
      const mediaType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== 'application/json') {
        if (!request.signal.aborted) setFailure('service');
        return;
      }
      const data: unknown = await response.json();
      if (request.signal.aborted) return;
      if (isLibraryPrice(data, source)) setQuotes((previous) => ({ ...previous, [source]: data }));
      else setFailure('quote');
    } catch {
      if (!request.signal.aborted) setFailure('quote');
    } finally {
      if (pending.current === request) {
        pending.current = null;
        if (!request.signal.aborted) setLoading(false);
      }
    }
  }

  const checkedAt = quote ? new Date(quote.checkedAt) : null;
  const hasPrices = Boolean(quote?.offers.length);
  const checkedTime = checkedAt && (hasPrices || (!loading && !failure)) && (
    <span className="library-price-checked">
      {failure || loading ? 'Last checked ' : 'Checked '}
      <time dateTime={checkedAt.toISOString()} title={checkedAt.toLocaleString('en-US')}>
        {checkedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
      </time>
    </span>
  );
  const priceActionLabel = failure ? 'Retry price check' : quote ? 'Refresh price' : 'Check price';
  let status = '';
  if (loading) status = `Checking ${sourceLabel}…`;
  else if (failure === 'service')
    status = window.openpe
      ? 'Price service unavailable. Restart OpenPE and try again.'
      : 'Price service unavailable. Reload the browser preview and try again.';
  else if (failure) status = 'Could not check prices. Try again.';
  else if (quote && !hasPrices) status = `No USD quote from ${sourceLabel} for this component.`;
  return (
    <section className="library-info-section library-pricing" aria-label="Price">
      <div className="library-pricing-heading">
        <h3>Price</h3>
        <div className="library-price-controls">
          <Select
            compact
            label="Price source"
            value={source}
            options={priceSourceOptions}
            fitLabels={priceSourceNames}
            onBeforeOpen={() => !composing()}
            onChange={changeSource}
            popupMatchWidth="content"
          />
          <button
            type="button"
            className="icon-button"
            aria-label={priceActionLabel}
            title={priceActionLabel}
            aria-disabled={loading}
            onClick={() => void refresh()}
            onKeyDown={onKeyDown}
          >
            <RotateCw size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className="library-price-status" role="status" data-error={Boolean(failure)}>
        {failure && <CircleAlert size={15} aria-hidden="true" />}
        {status && <span>{status}</span>}
      </p>
      {quote && hasPrices && (
        <div className="library-price-offers">
          {quote.offers.map(({ sku, manufacturer, stock, tiers }, index) => {
            const offerCheckedTime = index === quote.offers.length - 1 ? checkedTime : null;
            return (
              <table className="library-price-table" key={sku}>
                {manufacturer !== null && <caption>{manufacturer}</caption>}
                <thead>
                  <tr>
                    <th scope="col">Quantity</th>
                    <th scope="col">Unit price (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tier) => (
                    <tr key={tier.quantity}>
                      <td>{priceQuantity.format(tier.quantity)}+</td>
                      <td>{priceCurrency.format(tier.unitPrice)}</td>
                    </tr>
                  ))}
                </tbody>
                {(stock !== undefined || offerCheckedTime) && (
                  <tfoot>
                    <tr>
                      <td colSpan={2}>
                        <div className="library-price-footer">
                          {offerCheckedTime}
                          {stock !== undefined && <span>Stock {priceQuantity.format(stock)}</span>}
                        </div>
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            );
          })}
        </div>
      )}
      {!hasPrices && checkedTime && <div className="library-price-footer">{checkedTime}</div>}
    </section>
  );
}

function LibraryInformation({ detail, unit }: { detail: Detail; unit: number }) {
  const symbol = 'symbol' in detail ? detail : null;
  const footprint = symbol
    ? symbol.footprint || propertyValue(symbol.symbol, 'Footprint')
    : detail.id;
  const datasheet = symbol ? propertyValue(symbol.symbol, 'Datasheet') : '';
  const hasDatasheet = datasheet !== '' && datasheet !== '~';
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
              ['Prefix', propertyValue(symbol.symbol, 'Reference') || 'Not provided'],
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
      {(detail.description || hasDatasheet) && (
        <LibraryInfoSection title="Description" wide>
          {detail.description && <p>{detail.description}</p>}
          {hasDatasheet && <LibraryInfoRows rows={[['Datasheet', datasheet]]} />}
        </LibraryInfoSection>
      )}
    </div>
  );
}
type ModelAvailability = { detail: FootprintDetail; unavailable: Record<number, string> };

const symbolBatchSize = 16;

type BrowseSnapshot = {
  ready: boolean;
  query: string;
  submittedQuery: string;
  library: string;
  category: string;
  entries: LibraryEntry[];
  symbolResultLimit: number;
  total: number;
  offset: number;
  nextOffset: number | null;
  selected: string;
  detail: Detail | null;
  unit: number;
  tab: '2d' | '3d';
  model: number;
  modelAvailability: ModelAvailability | null;
  exactFootprint: boolean;
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
  requireModel = false,
  initialModelPath,
  initialFootprintId,
  projectSource,
  fileId,
}: {
  kind: 'symbols' | 'footprints';
  onClose: () => void;
  onChoose: (detail: Detail, unit: number, modelIndex: number) => void | Promise<void>;
  initialSearch?: string;
  initialLibrary?: string;
  capabilityHost?: CapabilityHost;
  title?: string;
  label?: string;
  actionLabel?: string;
  header?: ReactNode;
  canChoose?: boolean;
  requireModel?: boolean;
  initialModelPath?: string;
  initialFootprintId?: string;
  projectSource?: string;
  fileId?: string;
}) {
  const [query, setQuery] = useState(initialSearch),
    [library, setLibrary] = useState(initialLibrary);
  const [category, setCategory] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState(initialSearch);
  const [priceSource, setPriceSource] = useState<LibraryPriceSource>('huaqiu');
  const [symbolSort, setSymbolSort] = useState<SymbolSort | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]),
    [libraries, setLibraries] = useState<string[]>([]);
  const [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState(initialFootprintId ?? '');
  const [exactFootprint, setExactFootprint] = useState(Boolean(initialFootprintId));
  const [symbolResultLimit, setSymbolResultLimit] = useState(symbolBatchSize);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [resultsError, setResultsError] = useState('');
  const [batchProgress, setBatchProgress] = useState<LibrarySearchProgress | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [packagePreviewError, setPackagePreviewError] = useState('');
  const [packagePreviewRetry, setPackagePreviewRetry] = useState(0);
  const [footprintUnavailable, setFootprintUnavailable] = useState(false);
  const [modelAvailability, setModelAvailability] = useState<ModelAvailability | null>(null);
  const [verifiedModel, setVerifiedModel] = useState<{ detail: FootprintDetail; index: number }>();
  const [confirming, setConfirming] = useState(false);
  const [confirmationError, setConfirmationError] = useState('');
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
  const [busy, setBusy] = useState(!initialFootprintId),
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
  const displayedEntries = useMemo<LibraryEntry[]>(() => {
    if (exactFootprint && detail) {
      const { footprint: _footprint, ...entry } = detail;
      return [entry];
    }
    if (kind !== 'symbols') return entries;
    const visible = entries.slice(0, symbolResultLimit);
    return symbolSort
      ? visible.toSorted((first, second) => compareSymbolRows(first, second, symbolSort))
      : visible;
  }, [detail, entries, exactFootprint, kind, symbolResultLimit, symbolSort]);
  const selectedEntry =
    detail?.id === selected ? detail : entries.find((entry) => entry.id === selected);
  const failedPreviewEntry = error ? selectedEntry : undefined;
  const detailHeading =
    detail?.id === selected || selectedEntry?.library === 'NextPCB'
      ? selectedEntry
      : failedPreviewEntry;
  const failedCategories = categoryStatus.source === librarySource && Boolean(categoryStatus.error);
  const retryingCategories = categoryReload?.source === librarySource;
  const needsSymbolPage =
    kind === 'symbols' &&
    entries.length < symbolResultLimit &&
    !resultsError &&
    nextOffset !== null &&
    nextOffset > offset;
  const loadingDefaultPages =
    kind === 'symbols' && symbolResultLimit === symbolBatchSize && offset > 0;
  const resultsLoading = busy || needsSymbolPage;
  const loadingInitial = !error && !resultsError && resultsLoading;
  const visibleCount = displayedEntries.length;
  const hasEntries = visibleCount > 0;
  const canLoadMore =
    (online || kind === 'symbols') &&
    (nextOffset !== null || visibleCount < entries.length) &&
    !resultsError;
  const chooseLabel = actionLabel ?? (kind === 'symbols' ? 'Place' : 'Assign');
  const loadingPreview = !!selected && !detail && !error;
  const retryDisabled = confirming || resultsLoading || retryingCategories || loadingPreview;
  function blockComposingActivation(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function sortSymbols(column: SymbolColumn) {
    if (composing.current) return;
    setSymbolSort((previous) => {
      const first = column === 'footprint' || column === 'model' ? 'descending' : 'ascending';
      if (previous?.column !== column) return { column, direction: first };
      if (previous.direction !== first) return null;
      return { column, direction: first === 'ascending' ? 'descending' : 'ascending' };
    });
  }
  function invalidate() {
    if (results.current) results.current.scrollTop = 0;
    setBusy(true);
    setExactFootprint(false);
    setBatchProgress(null);
    setResultsError('');
    setPackagePreviewError('');
    setFootprintUnavailable(false);
    setModelAvailability(null);
    setEntries([]);
    setSymbolResultLimit(symbolBatchSize);
    setTotal(0);
    setNextOffset(null);
    setSelected('');
    setDetail(null);
    setConfirmationError('');
    chosen.current = false;
  }
  function loadMore() {
    if (resultsLoading || resultsError || (nextOffset === null && visibleCount === entries.length))
      return;
    if (kind === 'symbols') setSymbolResultLimit(symbolResultLimit + symbolBatchSize);
    else if (nextOffset !== null) {
      setBusy(true);
      setOffset(nextOffset);
    }
  }
  function selectEntry(id: string) {
    if (id === selected) return;
    setPackagePreviewError('');
    setFootprintUnavailable(false);
    setModelAvailability(null);
    setDetail(null);
    setSelected(id);
    setConfirmationError('');
    chosen.current = false;
  }
  function submitSearch() {
    if (composing.current) return;
    invalidate();
    setSubmittedQuery(query);
    setOffset(0);
    setRetry((value) => value + 1);
  }
  function retryLibraryRequest() {
    if (composing.current || retryDisabled) return;
    if (resultsError) {
      setResultsError('');
      setBusy(true);
      setRetry((value) => value + 1);
      return;
    }
    if (error && selected && !footprintUnavailable) {
      setError('');
      setPreviewRetry((value) => value + 1);
      return;
    }
    if (packagePreviewError) {
      setPackagePreviewRetry((value) => value + 1);
      return;
    }
    if (failedCategories) {
      setCategoryReload({ source: librarySource, serial: ++categoryReloadSerial.current });
    }
  }
  function changeLibrary(nextLibrary: string, nextCategory: string) {
    if (nextLibrary === library && nextCategory === category) return;
    setCategoryReload(null);
    const source = librarySource;
    const nextSource = catalogSource(nextLibrary);
    if (source !== nextSource)
      sourceSnapshots.current.set(source, {
        ready: !resultsLoading && !resultsError,
        query,
        submittedQuery,
        library,
        category,
        entries,
        symbolResultLimit,
        total,
        offset,
        nextOffset,
        selected,
        detail,
        unit,
        tab,
        model,
        modelAvailability,
        exactFootprint,
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
      setSymbolResultLimit(previous.symbolResultLimit);
      setTotal(previous.total);
      setOffset(previous.offset);
      setNextOffset(previous.nextOffset);
      setSelected(previous.selected);
      setDetail(previous.detail);
      setUnit(previous.unit);
      setTab(previous.tab);
      setModel(previous.model);
      setModelAvailability(previous.modelAvailability);
      setExactFootprint(previous.exactFootprint);
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
  }, [categoryReload, librarySource, categoryStatus]);
  useEffect(() => {
    if (restoredSearch.current) {
      restoredSearch.current = false;
      return;
    }
    if (exactFootprint) return;
    const control = new AbortController();
    setBusy(true);
    setBatchProgress(null);
    setResultsError('');
    if (offset === 0) {
      setError('');
      setEntries([]);
      setTotal(0);
      setNextOffset(null);
      setSelected('');
      setDetail(null);
    }
    const input = {
      kind,
      query: submittedQuery,
      library,
      offset,
      ...(kind === 'symbols' ? { includeAssetStatus: true } : {}),
      ...(category ? { category } : {}),
    };
    const onProgress = (value: unknown) => {
      if (!control.signal.aborted && isLibrarySearchProgress(value)) setBatchProgress(value);
    };
    const search = capabilityHost
      ? (capabilityHost.query('library.search', input, {
          signal: control.signal,
          onProgress,
        }) as Promise<LibrarySearchPage>)
      : readLibrarySearch(input, control.signal, onProgress);
    void search
      .then((data) => {
        if (control.signal.aborted) return;
        const incoming = data.entries;
        setEntries((current) => {
          const combined = offset === 0 ? [] : [...current];
          const ids = new Set(combined.map((entry) => entry.id));
          for (const entry of incoming) {
            if (ids.has(entry.id)) continue;
            ids.add(entry.id);
            combined.push(entry);
          }
          return combined;
        });
        const consumed = offset + incoming.length;
        const next: number | null =
          isOnlineLibrary(library) || kind === 'symbols'
            ? (data.nextOffset ?? null)
            : incoming.length && consumed < data.total
              ? consumed
              : null;
        setNextOffset(next);
        if (!isOnlineLibrary(library)) {
          setLibraries(data.libraries);
          setTotal(data.total);
        }
        if (incoming.length) setSelected((current) => current || incoming[0].id);
        setBatchProgress(null);
        setBusy(false);
      })
      .catch((e) => {
        if (!control.signal.aborted) {
          setResultsError(e.message);
          setBatchProgress(null);
          setBusy(false);
        }
      });
    return () => control.abort();
  }, [kind, submittedQuery, library, category, offset, retry, capabilityHost, exactFootprint]);
  useEffect(() => {
    if (busy || !needsSymbolPage || nextOffset === null) return;
    setBusy(true);
    setOffset(nextOffset);
  }, [busy, needsSymbolPage, nextOffset]);
  useEffect(() => {
    const restored = restoredDetail.current;
    restoredDetail.current = null;
    if (restored?.selected === selected && restored.detail) {
      setError('');
      return;
    }
    setDetail(null);
    setError('');
    setFootprintUnavailable(false);
    setModelAvailability(null);
    setUnit(1);
    setTab(requireModel ? '3d' : '2d');
    setModel(0);
    if (!selected) return;
    const control = new AbortController();
    void Promise.resolve()
      .then(() => {
        control.signal.throwIfAborted();
        return (
          (kind === 'footprints' && projectSource && readProjectFootprint(projectSource, selected)) ||
          readLibraryDetail(kind, selected, control.signal, capabilityHost)
        );
      })
      .then((value) => {
        const data = value as Detail;
        if (control.signal.aborted) return;
        setDetail(data);
        if (initialModelPath && 'models' in data) {
          const key = modelReferenceKey(initialModelPath);
          const index = data.models.findIndex(({ path }) => modelReferenceKey(path) === key);
          if (index >= 0) setModel(index);
        }
        const { id, footprintPreview } = data;
        if ('symbol' in data && data.library === 'JLCPCB' && footprintPreview)
          setEntries((current) =>
            current.map((entry) => (entry.id === id ? { ...entry, footprintPreview } : entry)),
          );
      })
      .catch((e) => {
        if (!control.signal.aborted) {
          setError(e.message);
          if (kind === 'footprints') setFootprintUnavailable(isLibraryAssetUnavailable(e));
        }
      });
    return () => control.abort();
  }, [kind, selected, capabilityHost, initialModelPath, previewRetry, projectSource, requireModel]);
  const footprintDetail = detail && 'models' in detail ? detail : null;
  const projectLibraryId = footprintDetail?.projectAssets ? footprintDetail.id : undefined;
  const loadProjectModel = useCallback(
    (signal: AbortSignal) =>
      previewProjectComponentModel(projectSource!, fileId, { libraryId: projectLibraryId! }, model, signal),
    [fileId, model, projectLibraryId, projectSource],
  );
  const projectModel = footprintDetail?.projectAssets
    ? footprintModels(footprintDetail.footprint)[model]
    : undefined;
  const modelErrors =
    modelAvailability?.detail === footprintDetail ? modelAvailability.unavailable : undefined;
  const modelError = modelErrors?.[model];
  const hasPreviewableModel = footprintDetail?.models.some((_, index) => !modelErrors?.[index]);
  const modelReason = hasPreviewableModel ? undefined : modelError || noModel;
  const selectedModelIssue = modelError || modelReason;
  const show3d = tab === '3d' && !modelReason;
  const footprintReason =
    footprintDetail && !canPreviewFootprint(footprintDetail.footprint) ? noFootprintPreview : '';
  const invalid =
    detail && 'error' in detail && detail.error
      ? detail.error
      : requireModel && footprintDetail
        ? selectedModelIssue
        : '';
  const ready =
    canChoose &&
    !confirming &&
    (!resultsLoading || loadingDefaultPages) &&
    !error &&
    detail?.id === selected &&
    !!detail &&
    !invalid &&
    (!requireModel || (verifiedModel?.detail === footprintDetail && verifiedModel.index === model));
  const footerError =
    confirmationError ||
    resultsError ||
    (!footprintUnavailable && error) ||
    packagePreviewError ||
    (!requireModel && invalid) ||
    (failedCategories && categoryStatus.error);
  const retryLabel = resultsError
    ? 'Retry loading results'
    : (error && selected && !footprintUnavailable) || packagePreviewError
      ? 'Retry loading preview'
      : !invalid && failedCategories
        ? 'Retry categories'
        : '';
  const choose = () => {
    if (ready && detail && !chosen.current && !composing.current) {
      chosen.current = true;
      const confirmation = onChoose(detail, unit, model);
      if (!confirmation) return;
      setConfirming(true);
      setConfirmationError('');
      void confirmation.catch((error: Error) => {
        chosen.current = false;
        setConfirming(false);
        setConfirmationError(error.message);
      });
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
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || (resultsLoading && !loadingDefaultPages))
      return;
    event.preventDefault();
    const index = displayedEntries.findIndex((entry) => entry.id === selected);
    const nextIndex = Math.max(
      0,
      Math.min(displayedEntries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    const next = displayedEntries[nextIndex];
    if (!next) return;
    selectEntry(next.id);
    const row = results.current?.querySelector<HTMLButtonElement>(`[data-index="${nextIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    if (focusResult) row?.focus({ preventScroll: true });
    if (event.key === 'ArrowDown' && nextIndex >= displayedEntries.length - 5) loadMore();
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
              <div className="library-footer-feedback">
                <p role="alert">{footerError}</p>
                {retryLabel && !confirmationError && (
                  <button
                    type="button"
                    className="dialog-button secondary"
                    aria-label={retryLabel}
                    disabled={retryDisabled}
                    onClick={retryLibraryRequest}
                    onKeyDown={blockComposingActivation}
                  >
                    Retry
                  </button>
                )}
              </div>
            )}
            <button
              className="dialog-button primary"
              aria-label={chooseLabel}
              title={chooseLabel}
              disabled={!ready}
              onClick={choose}
              onKeyDown={blockComposingActivation}
            >
              {chooseLabel}
            </button>
          </>
        }
      >
        {header}
        <div className="library-filter" inert={confirming}>
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
            {exactFootprint
              ? detail ? '1 result' : loadingPreview ? 'Loading…' : 'Unavailable'
              : resultsLoading
              ? offset
                ? 'Loading…'
                : 'Searching…'
              : resultsError && !entries.length
                ? 'Unavailable'
                : isOnlineLibrary(library)
                  ? `${visibleCount.toLocaleString()} ${visibleCount === 1 ? 'result' : 'results'} loaded`
                  : `${total.toLocaleString()} results`}
          </span>
        </div>
        <div className="library-search-row" inert={confirming}>
          <div className="library-search">
            <Search size={16} aria-hidden="true" />
            <input
              autoFocus
              aria-label={
                requireModel ? 'Search models' : kind === 'symbols' ? 'Search components' : 'Search footprints'
              }
              placeholder="Search by model, keyword or part number…"
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
          </div>
          <button
            type="button"
            className="dialog-button secondary"
            onClick={submitSearch}
            onKeyDown={blockComposingActivation}
          >
            Search
          </button>
        </div>
        <div
          className={`library-browser${kind === 'footprints' ? ' assignment-browser' : ''}${hasEntries ? '' : ' library-browser-empty'}`}
          inert={confirming}
        >
          <div
            ref={results}
            className={`library-results${kind === 'symbols' ? ' library-component-results' : ''}`}
            aria-label="Library results"
            aria-busy={resultsLoading}
            onScroll={(event) => {
              const list = event.currentTarget;
              if (
                list.scrollTop > 0 &&
                list.scrollHeight - list.scrollTop - list.clientHeight < 120
              )
                loadMore();
            }}
          >
            {hasEntries && kind === 'symbols' && (
              <div
                className="library-result-columns"
                role="group"
                aria-label="Sort library results"
              >
                {symbolColumns.map(([column, label]) => {
                  const direction = symbolSort?.column === column ? symbolSort.direction : null;
                  const SortIcon = direction === 'ascending' ? ChevronUp : ChevronDown;
                  return (
                    <button
                      key={column}
                      type="button"
                      data-asset-column={column === 'footprint' || column === 'model' || undefined}
                      aria-label={`Sort by ${label}`}
                      aria-pressed={!!direction}
                      aria-description={direction ? `Sorted ${direction}` : undefined}
                      title={direction ? `${label}: sorted ${direction}` : `Sort by ${label}`}
                      onPointerDown={(event) => {
                        if (composing.current) event.preventDefault();
                      }}
                      onKeyDown={(event) => {
                        blockComposingActivation(event);
                        if (event.repeat && (event.key === 'Enter' || event.key === ' '))
                          event.preventDefault();
                      }}
                      onClick={() => sortSymbols(column)}
                    >
                      <span>{label}</span>
                      <SortIcon size={12} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            )}
            {displayedEntries.map((entry, i) => {
              const assets = kind === 'symbols' ? listedSymbolAssets(entry) : null;
              const packageLabel = assets ? symbolPackage(entry) : '';
              return (
                <button
                  key={entry.id}
                  data-index={i}
                  className={selected === entry.id ? 'selected' : ''}
                  aria-label={
                    assets
                      ? `${entry.name}${packageLabel ? `, ${packageLabel}` : ''}, Footprint: ${assetLabels[assets.footprint]}, Model: ${assetLabels[assets.model]}`
                      : undefined
                  }
                  aria-description={entry.id}
                  tabIndex={selected === entry.id ? 0 : -1}
                  aria-pressed={selected === entry.id}
                  onKeyDown={(event) => navigate(event, true)}
                  onFocus={() => selectEntry(entry.id)}
                  onClick={() => selectEntry(entry.id)}
                  onDoubleClick={() => {
                    if (detail?.id === entry.id) choose();
                  }}
                >
                  {assets ? (
                    <>
                      <strong title={entry.name}>{entry.name}</strong>
                      <span
                        className="library-result-package"
                        title={entry.package || entry.footprint || ''}
                      >
                        {packageLabel || '—'}
                      </span>
                      {(['footprint', 'model'] as const).map((asset) => {
                        const status = assets[asset];
                        const StatusIcon = status === 'yes' ? SquareCheck : Square;
                        return (
                          <span
                            key={asset}
                            className="library-result-asset"
                            data-status={status}
                            title={`${asset === 'footprint' ? 'Footprint' : 'Model'}: ${assetLabels[status]}`}
                          >
                            <StatusIcon size={14} aria-hidden="true" />
                          </span>
                        );
                      })}
                    </>
                  ) : (
                    <>
                      <strong title={entry.name}>{entry.name}</strong>
                      <small title={entry.library}>{entry.library}</small>
                    </>
                  )}
                </button>
              );
            })}
            {!hasEntries && loadingInitial && (
              <WorkspaceLoading panel progress={batchProgress} label="Loading library" />
            )}
            {!resultsLoading && !loadingPreview && !hasEntries && !error && !resultsError && (
              <div className="library-empty-state">
                <span className="library-empty-icon">
                  <SearchX size={20} aria-hidden="true" />
                </span>
                <h3>{`No matching ${requireModel ? 'models' : kind}${canLoadMore ? ' in this batch' : ''}.`}</h3>
                {!canLoadMore && <p>Try another keyword or category.</p>}
              </div>
            )}
            {hasEntries && resultsLoading && batchProgress ? (
              <div className="library-page-progress">
                <LoadingProgress label="Loading more components" progress={batchProgress} />
              </div>
            ) : canLoadMore ? (
              <button
                className={`library-load-more${hasEntries ? '' : ' dialog-button secondary'}`}
                disabled={resultsLoading}
                onClick={loadMore}
                onKeyDown={(event) => {
                  blockComposingActivation(event);
                  if (event.key === 'Enter') {
                    event.stopPropagation();
                    if (event.repeat || composing.current) event.preventDefault();
                  }
                }}
              >
                {hasEntries && resultsLoading ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
          </div>
          <div className={`library-detail${kind === 'footprints' ? ' assignment-detail' : ''}`}>
            {detailHeading && (
              <div className="library-detail-heading">
                <strong className="library-detail-title">{detailHeading.name}</strong>
                <small className="library-detail-id" title={detailHeading.id}>
                  {detailHeading.id}
                </small>
              </div>
            )}
            {detail ? (
              <>
                {'symbol' in detail ? (
                  <>
                    <LibrarySymbolPreview
                      key={detail.id}
                      detail={detail}
                      unit={unit}
                      host={capabilityHost}
                      error={packagePreviewError}
                      onError={setPackagePreviewError}
                      retry={packagePreviewRetry}
                    />
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
                  </>
                ) : (
                  <>
                    <div className="preview-tabs">
                      <button
                        aria-pressed={!show3d && !footprintReason}
                        disabled={!!footprintReason}
                        title={footprintReason || undefined}
                        onClick={() => setTab('2d')}
                      >
                        Footprint
                      </button>
                      <button
                        aria-pressed={show3d}
                        disabled={!!modelReason}
                        title={modelReason}
                        onClick={() => setTab('3d')}
                      >
                        3D model
                      </button>
                    </div>
                    <LibraryPreviewStage
                      key={detail.id}
                      active={show3d ? '3d' : 'footprint'}
                      className="library-preview-stage assignment-preview-stage"
                      previews={{
                        footprint: <FootprintPreview footprint={detail.footprint} />,
                        '3d': !selectedModelIssue && (
                          <Suspense fallback={<WorkspaceLoading panel label="Loading 3D model" />}>
                            <ModelPreview
                              key={model}
                              id={detail.id}
                              index={model}
                              load={projectLibraryId ? loadProjectModel : undefined}
                              model={projectModel}
                              active={show3d}
                              onReady={
                                requireModel
                                  ? () => setVerifiedModel({ detail, index: model })
                                  : undefined
                              }
                              onUnavailable={(message) =>
                                setModelAvailability((current) => ({
                                  detail,
                                  unavailable: {
                                    ...(current?.detail === detail
                                      ? current.unavailable
                                      : undefined),
                                    [model]: message,
                                  },
                                }))
                              }
                            />
                          </Suspense>
                        ),
                      }}
                    />
                    {modelError && <p role="status">{modelError}</p>}
                    {show3d && detail.models.length > 1 && (
                      <LibraryModelSelect
                        models={detail.models}
                        index={model}
                        unavailable={modelErrors}
                        onChange={(index) => {
                          setConfirmationError('');
                          setModel(index);
                        }}
                      />
                    )}
                  </>
                )}
                <LibraryInformation detail={detail} unit={unit} />
                {detail.library === 'JLCPCB' && detail.attribution && (
                  <JlcpcbAttribution key={detail.id} notice={detail.attribution.notice} />
                )}
              </>
            ) : failedPreviewEntry ? (
              <>
                {footprintUnavailable && (
                  <div className="preview-tabs">
                    <button disabled title={error}>
                      Footprint
                    </button>
                    <button disabled title={error}>
                      3D model
                    </button>
                  </div>
                )}
                <div className="library-detail-sections">
                  <LibraryInfoSection title="Basic information" wide>
                    <LibraryInfoRows
                      rows={[
                        ['Source', librarySource],
                        ...(failedPreviewEntry.manufacturer
                          ? [
                              ['Manufacturer', failedPreviewEntry.manufacturer] as [
                                string,
                                ReactNode,
                              ],
                            ]
                          : []),
                        ...(failedPreviewEntry.package
                          ? [['Package', failedPreviewEntry.package] as [string, ReactNode]]
                          : []),
                      ]}
                    />
                  </LibraryInfoSection>
                  {failedPreviewEntry.description && (
                    <LibraryInfoSection title="Description" wide>
                      <p>{failedPreviewEntry.description}</p>
                    </LibraryInfoSection>
                  )}
                </div>
              </>
            ) : !error && selected ? (
              <WorkspaceLoading panel label="Loading preview" />
            ) : null}
            {selectedEntry && (
              <LibraryPricing
                key={`${kind}:${selectedEntry.id}`}
                id={selectedEntry.id}
                kind={kind}
                source={priceSource}
                onSourceChange={setPriceSource}
                composing={() => composing.current}
                onKeyDown={blockComposingActivation}
              />
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
