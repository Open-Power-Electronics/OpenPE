'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { ChevronLeft, ChevronRight, FileText, Maximize, Minus, Plus } from 'lucide-react';
import { readLibraryDatasheet, type DatasheetPage } from '@/lib/library-references';
import type { LibraryDatasheetSource } from '@/lib/library';
import Dialog from './Dialog';
import Select from './Select';
import WorkspaceLoading from './WorkspaceLoading';

const inset = 8;
const zoomSteps = [25, 33, 50, 67, 75, 100, 125, 150, 200, 300, 400];
const zoomOptions = [
  { value: 'fit-width', label: 'Fit width' },
  { value: 'fit-page', label: 'Fit page' },
  ...zoomSteps.map((value) => ({ value: String(value), label: value + '%' })),
];
const zoomLabels = zoomOptions.map(({ label }) => label);
const sourceLabels = { huaqiu: 'HQ Online', jlcpcb: 'JLCPCB' };
const initialPosition = () => ({ x: 0.5, y: 0 });
type Position = ReturnType<typeof initialPosition>;
type LibraryKind = 'symbols' | 'footprints';

function usePdfDocument(
  id: string,
  kind: LibraryKind,
  source: LibraryDatasheetSource,
  active: boolean,
) {
  const [request, setRequest] = useState({ page: 1 });
  const [pages, setPages] = useState<DatasheetPage[]>([]);
  const [issue, setIssue] = useState<{ request: typeof request; kind: 'error' | 'empty' }>();
  const position = useRef(initialPosition());
  const result = pages.find(({ page }) => page === request.page);
  const count = pages[0]?.pageCount ?? 0;
  const currentIssue = issue?.request === request ? issue.kind : undefined;

  useEffect(() => {
    if (!active || result || currentIssue) return;
    const control = new AbortController();
    void (async () => {
      try {
        const value = await readLibraryDatasheet(
          { id, kind, source, page: request.page },
          control.signal,
        );
        if (control.signal.aborted) return;
        if (value === null) setIssue({ request, kind: 'empty' });
        else setPages((previous) => [value, ...previous].slice(0, 2));
      } catch {
        if (!control.signal.aborted) setIssue({ request, kind: 'error' });
      }
    })();
    return () => control.abort();
  }, [active, id, kind, source, request, result, currentIssue]);

  return { request, setRequest, count, result, currentIssue, position };
}

export default function LibraryDatasheet({
  id,
  kind,
  name,
  active,
  canOperate,
  source,
}: {
  id: string;
  kind: LibraryKind;
  name: string;
  active: boolean;
  canOperate: () => boolean;
  source: LibraryDatasheetSource;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pageDraft, setPageDraft] = useState<string>();
  const [zoom, setZoom] = useState('fit-width');
  const [fitScale, setFitScale] = useState(100);
  const composing = useRef(false);
  const { request, setRequest, count, result, currentIssue, position } = usePdfDocument(
    id,
    kind,
    source,
    active,
  );
  const percent = zoom === 'fit-width' || zoom === 'fit-page' ? fitScale : Number(zoom);

  function allowed(event?: KeyboardEvent) {
    return (
      canOperate() &&
      !composing.current &&
      (!event || (!event.nativeEvent.isComposing && event.keyCode !== 229))
    );
  }

  function goTo(page: number) {
    if (!allowed()) return;
    setPageDraft(undefined);
    if (Number.isInteger(page) && page >= 1 && page <= count && page !== request.page) {
      position.current = initialPosition();
      setRequest({ page });
    }
  }

  function stepZoom(direction: -1 | 1) {
    if (!allowed() || !result) return;
    const choices = direction > 0 ? zoomSteps : [...zoomSteps].reverse();
    const next = choices.find((step) => direction * (step - percent) > 0.5);
    if (next !== undefined) setZoom(String(next));
  }

  function viewportKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!allowed(event)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    switch (event.key) {
      case 'PageUp':
        goTo(request.page - 1);
        break;
      case 'PageDown':
        goTo(request.page + 1);
        break;
      case 'Home':
        goTo(1);
        break;
      case 'End':
        goTo(count);
        break;
      case '+':
      case '=':
        stepZoom(1);
        break;
      case '-':
        stepZoom(-1);
        break;
      case '0':
        setZoom('fit-width');
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
  function blockComposingControls(event: KeyboardEvent<HTMLDivElement>) {
    if (!allowed(event) && event.target instanceof HTMLButtonElement) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  const pageControls = (
    <div className="library-pdf-controls" role="group" aria-label="Page navigation">
      <button
        type="button"
        className="icon-button"
        aria-label="Previous page"
        title="Previous page"
        disabled={request.page === 1}
        onClick={() => goTo(request.page - 1)}
      >
        <ChevronLeft size={16} />
      </button>
      <label className="library-pdf-counter" title="Go to page">
        <input
          className="library-pdf-page-input"
          style={{ width: `calc(${String(count).length}ch + 8px)` }}
          aria-label="Page number"
          value={pageDraft ?? String(request.page)}
          inputMode="numeric"
          maxLength={5}
          onChange={(event) => setPageDraft(event.target.value)}
          onBlur={() => {
            setPageDraft(undefined);
            composing.current = false;
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && (event.key !== 'Escape' || pageDraft === undefined))
              return;
            event.preventDefault();
            event.stopPropagation();
            if (!allowed(event) || event.repeat) return;
            if (event.key === 'Escape') setPageDraft(undefined);
            else {
              const value = pageDraft?.trim() ?? String(request.page);
              goTo(/^[0-9]+$/.test(value) ? Number(value) : NaN);
            }
          }}
        />
        <span className="library-pdf-total">/ {count}</span>
      </label>
      <button
        type="button"
        className="icon-button"
        aria-label="Next page"
        title="Next page"
        disabled={request.page >= count}
        onClick={() => goTo(request.page + 1)}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
  const zoomControls = (
    <div className="library-pdf-controls" role="group" aria-label="Magnification">
      <button
        type="button"
        className="icon-button"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={!result || percent <= zoomSteps[0]}
        onClick={() => stepZoom(-1)}
      >
        <Minus size={16} />
      </button>
      <Select
        label="Zoom"
        value={zoom}
        options={zoomOptions}
        fitLabels={zoomLabels}
        popupMatchWidth="content"
        onBeforeOpen={allowed}
        onChange={(value) => {
          if (allowed()) setZoom(value);
        }}
      />
      <button
        type="button"
        className="icon-button"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={!result || percent >= zoomSteps.at(-1)!}
        onClick={() => stepZoom(1)}
      >
        <Plus size={16} />
      </button>
    </div>
  );
  const readingControls = count > 0 && (
    <div className="library-pdf-reading-controls">
      {pageControls}
      {zoomControls}
    </div>
  );
  const surface = result ? (
    <PdfPage
      key={result.page}
      result={result}
      name={name}
      zoom={zoom}
      position={position}
      onFitScale={setFitScale}
      onKeyDown={viewportKey}
    />
  ) : (
    <div className="library-pdf-status">
      {currentIssue === 'error' ? (
        <>
          <p className="dialog-error" role="alert">
            Could not load the PDF.
          </p>
          <button
            type="button"
            className="dialog-button secondary"
            onClick={() => {
              if (allowed()) setRequest({ page: request.page });
            }}
          >
            Retry
          </button>
        </>
      ) : currentIssue === 'empty' ? (
        <p role="status">No PDF is available from {sourceLabels[source]} for this component.</p>
      ) : (
        <WorkspaceLoading panel label="Loading PDF" />
      )}
    </div>
  );
  if (!active) return null;
  return (
    <>
      <div className="library-pdf-inline" data-agent-private>
        {!expanded && surface}
        <div className="library-pdf-toolbar" onKeyDownCapture={blockComposingControls}>
          {!expanded && readingControls}
          <button
            type="button"
            className="icon-button library-pdf-open"
            aria-label="Open PDF in window"
            title="Open in window"
            onKeyDown={(event) => {
              if (!allowed(event)) event.preventDefault();
            }}
            onClick={() => {
              if (allowed()) setExpanded(true);
            }}
          >
            <Maximize size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      {expanded && (
        <Dialog
          title={name}
          icon={<FileText size={20} />}
          onClose={() => setExpanded(false)}
          footer={
            readingControls && (
              <div
                className="library-pdf-toolbar"
                data-agent-private
                onKeyDownCapture={blockComposingControls}
              >
                {readingControls}
              </div>
            )
          }
        >
          <div className="library-pdf-expanded" data-agent-private>
            {surface}
          </div>
        </Dialog>
      )}
    </>
  );
}

function PdfPage({
  result,
  name,
  zoom,
  position,
  onFitScale,
  onKeyDown,
}: {
  result: DatasheetPage;
  name: string;
  zoom: string;
  position: RefObject<Position>;
  onFitScale: (percent: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const widthScale = Math.max(1, size.width - 2 * inset) / result.image.width;
  const pageScale = Math.max(1, size.height - 2 * inset) / result.image.height;
  const scale =
    zoom === 'fit-width'
      ? widthScale
      : zoom === 'fit-page'
        ? Math.min(widthScale, pageScale)
        : Number(zoom) / 100;

  useLayoutEffect(() => {
    const node = viewport.current!;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = node;
      if (width && height)
        setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const node = viewport.current!;
    if (!size.width || !node.clientWidth) return;
    const frame = node.getBoundingClientRect();
    const sheet = image.current!.getBoundingClientRect();
    node.scrollTo(
      node.scrollLeft +
        sheet.left -
        frame.left +
        sheet.width * position.current.x -
        node.clientWidth / 2,
      node.scrollTop + sheet.top - frame.top + sheet.height * position.current.y - inset,
    );
    if (zoom.startsWith('fit-')) onFitScale(scale * 100);
  }, [size, scale, zoom, position, onFitScale]);

  return (
    <div
      className="library-pdf-viewport"
      ref={viewport}
      tabIndex={0}
      role="region"
      data-autofocus
      aria-label={`PDF preview, page ${result.page} of ${result.pageCount}`}
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        if (!image.current || !size.width) return;
        const node = event.currentTarget;
        const frame = node.getBoundingClientRect();
        const sheet = image.current.getBoundingClientRect();
        if (sheet.width && sheet.height)
          position.current = {
            x: Math.max(
              0,
              Math.min(1, (frame.left + node.clientWidth / 2 - sheet.left) / sheet.width),
            ),
            y: Math.max(0, Math.min(1, (frame.top + inset - sheet.top) / sheet.height)),
          };
      }}
    >
      <div className="library-pdf-sheet">
        <img
          ref={image}
          src={`data:${result.image.mimeType};base64,${result.image.data}`}
          width={result.image.width}
          height={result.image.height}
          style={{ width: Math.max(1, result.image.width * scale), height: 'auto' }}
          alt={`${name}, page ${result.page}`}
          draggable={false}
        />
      </div>
    </div>
  );
}
