'use client';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Eye, EyeOff, List, MousePointer2, Pencil, Scan, Trash2, X } from 'lucide-react';
import { flushSync } from 'react-dom';
import { circuitFingerprint, type Circuit } from '@/lib/circuit';
import {
  maxAnnotations,
  validateAnnotations,
  type AgentAnnotation,
  type AnnotationMarkup,
} from '@/lib/agent-annotations';
import { captureAnnotationSelection } from '@/lib/annotation-selection';
import { capturePCBAnnotationSelection, pcbAnnotationFingerprint } from '@/lib/pcb-annotations';
import type { PCB } from '@/lib/pcb';
import type { ModelCAD } from '@/lib/model-cad';
import { useAnnotationSelectionOutline } from './AnnotationSelectionOutline';
import {
  annotationSelectionBounds,
  captureAnnotationImage,
  markupBounds,
} from '@/lib/annotation-screenshot';

export type AnnotationMode = 'element' | 'rectangle' | 'freehand';
export type CanvasAnnotationsHandle = {
  select: (ids: string[], markup?: AnnotationMarkup) => void;
};
type Props = {
  svg: RefObject<SVGSVGElement | null>;
  doc: Circuit;
  board?: PCB;
  active: boolean;
  sessionId: string;
  annotations: AgentAnnotation[];
  onChange: (annotations: AgentAnnotation[]) => void;
  onAdd?: () => void;
  onSelection: (ids: string[]) => void;
  selectionIds?: readonly string[];
  selectableIds?: ReadonlySet<string>;
  view: { x: number; y: number; width: number };
  ratio: number;
  mode: AnnotationMode;
  onMode: (mode: AnnotationMode) => void;
  onExit: () => void;
  /** Model uses the same comment UI with a rendered WebGL capture. */
  objectView?: string;
  modelCad?: ModelCAD | null;
  captureImage?: typeof captureAnnotationImage;
};

/** Conversation overlays only. Never commit annotation geometry to design data. */
const CanvasAnnotations = forwardRef<CanvasAnnotationsHandle, Props>(
  function CanvasAnnotations(props, ref) {
    const {
      svg,
      doc,
      board,
      active,
      sessionId,
      annotations,
      onChange,
      onAdd,
      onSelection,
      selectableIds,
      view,
      ratio,
      mode,
      onMode,
      onExit,
      objectView,
      modelCad,
      captureImage = captureAnnotationImage,
    } = props;
    const [draft, setDraft] = useState<{
      annotation: AgentAnnotation;
      sessionId: string;
      saved: boolean;
    } | null>(null);
    const [hidden, setHidden] = useState(false);
    useAnnotationSelectionOutline(
      svg,
      props.selectionIds ?? [],
      active && !hidden && objectView === undefined,
      view,
    );
    const [listed, setListed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const input = useRef<HTMLTextAreaElement>(null);
    const latest = useRef(props);
    latest.current = props;
    const capture = useRef(0);
    const capturing = useRef(false);
    const composing = useRef(false);
    const acceptedDraft = useRef<typeof draft>(null);
    const current =
      draft?.sessionId === sessionId &&
      (!draft.saved || annotations.some((a) => a.id === draft.annotation.id))
        ? draft
        : null;
    const matchesSurface = (annotation: AgentAnnotation) =>
      annotation.circuitId === doc.id &&
      (board
        ? annotation.target === (objectView === undefined ? 'layout' : 'object') &&
          annotation.boardId === board.id
        : annotation.target === undefined);
    const needsPresentation = active || current !== null || annotations.some(matchesSurface);
    const basis = useMemo(
      () =>
        needsPresentation
          ? board
            ? pcbAnnotationFingerprint(board, doc)
            : circuitFingerprint(doc)
          : null,
      [board, doc, needsPresentation],
    );
    const matchesSnapshot = (annotation: AgentAnnotation) =>
      matchesSurface(annotation) &&
      annotation.basis === basis &&
      (objectView === undefined || annotation.viewBasis === objectView);
    useEffect(() => {
      composing.current = false;
      if (active) input.current?.focus({ preventScroll: true });
    }, [current?.annotation.id, active, sessionId]);
    useEffect(() => {
      capture.current++;
      capturing.current = false;
      setBusy(false);
    }, [active, sessionId, doc, board, objectView, modelCad, selectableIds]);
    useEffect(
      () => () => {
        capture.current++;
      },
      [],
    );

    function closeEditor() {
      if (composing.current) return false;
      setDraft(null);
      onSelection([]);
      setError('');
      return true;
    }
    useImperativeHandle(ref, () => ({
      async select(ids, markup) {
        if (selectableIds) ids = ids.filter((id) => selectableIds.has(id));
        if (!ids.length && (!markup || mode === 'element')) return;
        if (capturing.current || !active || !svg.current) return;
        if (!closeEditor()) return;
        if (annotations.length >= maxAnnotations) {
          setError(
            `Attach up to ${maxAnnotations} annotations per message. Send or remove an annotation first.`,
          );
          return;
        }
        const serial = ++capture.current;
        capturing.current = true;
        setBusy(true);
        setHidden(false);
        setListed(false);
        try {
          const snapshot = board
            ? capturePCBAnnotationSelection(
                board,
                doc,
                ids,
                markup,
                objectView === undefined ? undefined : { viewBasis: objectView, cad: modelCad },
              )
            : captureAnnotationSelection(doc, ids, markup);
          const bounds = markup
            ? markupBounds(markup)
            : annotationSelectionBounds(svg.current, ids);
          // Capture the same highlighted selection as the metadata, not the previous comment.
          flushSync(() => onSelection(ids));
          const image = await captureImage(svg.current, ids, bounds, markup);
          if (
            capture.current !== serial ||
            !latest.current.active ||
            latest.current.sessionId !== sessionId ||
            latest.current.doc !== doc ||
            latest.current.board !== board ||
            latest.current.objectView !== objectView ||
            latest.current.modelCad !== modelCad ||
            latest.current.selectableIds !== selectableIds
          )
            return;
          setDraft({
            annotation: {
              ...snapshot,
              bounds,
              image,
              comment: '',
            },
            sessionId,
            saved: false,
          });
        } catch (e) {
          if (
            capture.current === serial &&
            latest.current.sessionId === sessionId &&
            latest.current.active
          )
            setError((e as Error).message);
        } finally {
          if (capture.current === serial) {
            capturing.current = false;
            setBusy(false);
          }
        }
      },
    }));
    function edit(annotation: AgentAnnotation) {
      if (!closeEditor()) return;
      setDraft({ annotation, sessionId, saved: annotations.some((a) => a.id === annotation.id) });
      setHidden(false);
      setListed(false);
      if (matchesSnapshot(annotation))
        onSelection(
          annotation.elements
            .map((e) => e.id)
            .filter((id) => !selectableIds || selectableIds.has(id)),
        );
    }
    function changeComment(comment: string) {
      if (!current) return;
      setDraft({ ...current, annotation: { ...current.annotation, comment } });
      setError('');
    }
    function addAnnotation() {
      if (
        !current ||
        composing.current ||
        acceptedDraft.current === current ||
        !latest.current.active ||
        latest.current.sessionId !== current.sessionId ||
        capturing.current
      )
        return;
      const annotation = { ...current.annotation, comment: current.annotation.comment.trim() };
      const next = current.saved
        ? annotations.map((a) => (a.id === annotation.id ? annotation : a))
        : [...annotations, annotation];
      try {
        validateAnnotations(next);
        acceptedDraft.current = current;
        onChange(next);
        closeEditor();
        onAdd?.();
        svg.current?.focus();
      } catch (e) {
        acceptedDraft.current = null;
        setError((e as Error).message);
        input.current?.focus();
      }
    }
    function remove(id: string) {
      if (composing.current) return;
      if (annotations.some((a) => a.id === id)) onChange(annotations.filter((a) => a.id !== id));
      if (current?.annotation.id === id) {
        setDraft(null);
        onSelection([]);
      }
      setError('');
    }
    // Retain all capture/session hooks and drafts, but an unused empty overlay
    // needs neither a document fingerprint nor hidden annotation controls.
    if (!needsPresentation) return <div className="canvas-annotations" hidden />;
    const shown = [
      ...annotations,
      ...(current && !current.saved ? [current.annotation] : []),
    ].filter((a) => matchesSnapshot(a) && a.bounds);
    const bounds =
      current && matchesSnapshot(current.annotation) ? current.annotation.bounds : undefined;
    const px = bounds ? ((bounds.x + bounds.width - view.x) / view.width) * 100 : 50;
    const py = bounds ? ((bounds.y + bounds.height - view.y) / (view.width * ratio)) * 100 : 30;
    const height = svg.current?.clientHeight || 600;
    const editorTop =
      bounds && (py / 100) * height > height - 176
        ? `calc(${((bounds.y - view.y) / (view.width * ratio)) * 100}% - 72px)`
        : `calc(${py}% + 12px)`;
    const iconButton = (
      label: string,
      icon: React.ReactNode,
      action: () => void,
      pressed?: boolean,
      disabled = false,
    ) => (
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => {
          if (!composing.current) action();
        }}
      >
        {icon}
      </button>
    );
    return (
      <div className="canvas-annotations" hidden={!active}>
        {!hidden && (
          <>
            <svg
              className="annotation-marks"
              viewBox={`${view.x} ${view.y} ${view.width} ${view.width * ratio}`}
              aria-hidden="true"
            >
              {shown
                .filter((a) => a.markup)
                .map((a) =>
                  a.markup?.kind === 'freehand' ? (
                    <polyline
                      key={a.id}
                      points={a.markup.points.map((p) => `${p.x},${p.y}`).join(' ')}
                    />
                  ) : (
                    <rect
                      key={a.id}
                      x={a.bounds!.x}
                      y={a.bounds!.y}
                      width={a.bounds!.width}
                      height={a.bounds!.height}
                      className={current?.annotation.id === a.id ? 'is-current' : ''}
                    />
                  ),
                )}
            </svg>
            {shown.map((a) => {
              const number =
                annotations.findIndex((item) => item.id === a.id) + 1 || annotations.length + 1;
              const x = ((a.bounds!.x - view.x) / view.width) * 100;
              const y = ((a.bounds!.y - view.y) / (view.width * ratio)) * 100;
              if (x < 0 || x > 97 || y < 0 || y > 94) return null;
              return (
                <button
                  className="annotation-pin"
                  key={a.id}
                  style={{ left: `${x}%`, top: `${y}%` }}
                  aria-description={a.comment || 'New annotation'}
                  aria-label={`Edit canvas annotation ${number}`}
                  onClick={() => edit(a)}
                >
                  {number}
                </button>
              );
            })}
          </>
        )}
        {current && !hidden && (
          <div
            className="annotation-inline"
            role="group"
            aria-label="Annotation comment editor"
            style={{
              left: `clamp(8px, calc(${px}% - 300px), max(8px, calc(100% - 348px)))`,
              top: `clamp(8px, ${editorTop}, max(8px, calc(100% - 176px)))`,
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'Escape' &&
                !e.nativeEvent.isComposing &&
                e.nativeEvent.keyCode !== 229
              ) {
                e.preventDefault();
                e.stopPropagation();
                if (closeEditor()) svg.current?.focus();
              }
            }}
          >
            <textarea
              ref={input}
              aria-label="Annotation comment"
              placeholder="Add a comment…"
              rows={1}
              maxLength={4096}
              value={current.annotation.comment}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onChange={(e) => changeComment(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!e.repeat && current.annotation.comment.trim()) addAnnotation();
                }
              }}
            />
            {current.saved &&
              iconButton('Delete annotation', <Trash2 size={15} />, () =>
                remove(current.annotation.id),
              )}
            {iconButton('Cancel annotation', <X size={15} />, () => {
              if (closeEditor()) svg.current?.focus();
            })}
            <button
              type="button"
              className="annotation-add"
              disabled={busy || !current.annotation.comment.trim()}
              onClick={addAnnotation}
            >
              {current.saved ? 'Update' : 'Add'}
            </button>
          </div>
        )}
        {listed && (
          <div className="annotation-list" role="region" aria-label="Canvas annotations">
            {annotations.length === 0 && <span>No annotations</span>}
            {annotations.map((a, index) => (
              <div key={a.id}>
                <button onClick={() => edit(a)}>
                  <b>{index + 1}</b>
                  <span>
                    {a.comment}
                    {!matchesSnapshot(a) && (
                      <small>
                        {!matchesSurface(a)
                          ? a.title
                          : a.basis !== basis
                            ? 'Captured before latest edits'
                            : 'Captured from another view'}
                      </small>
                    )}
                  </span>
                </button>
                {iconButton(`Delete canvas annotation ${index + 1}`, <Trash2 size={15} />, () =>
                  remove(a.id),
                )}
              </div>
            ))}
          </div>
        )}
        {error && (
          <div className="annotation-error" role="alert">
            {error}
            {iconButton('Dismiss annotation error', <X size={14} />, () => setError(''))}
          </div>
        )}
        <div className="annotation-toolbar" role="toolbar" aria-label="Annotation tools">
          <span role="status">{busy ? 'Capturing…' : `Annotating · ${annotations.length}`}</span>
          {iconButton(
            'Select elements',
            <MousePointer2 size={17} />,
            () => onMode('element'),
            mode === 'element',
          )}
          {iconButton(
            'Draw rectangle',
            <Scan size={17} />,
            () => onMode('rectangle'),
            mode === 'rectangle',
          )}
          {iconButton(
            'Draw freehand',
            <Pencil size={17} />,
            () => onMode('freehand'),
            mode === 'freehand',
          )}
          <i />
          {iconButton(
            hidden ? 'Show annotations' : 'Hide annotations',
            hidden ? <EyeOff size={17} /> : <Eye size={17} />,
            () => setHidden(!hidden),
            !hidden,
          )}
          {iconButton('View annotations', <List size={17} />, () => setListed(!listed), listed)}
          {iconButton(
            'Clear annotations',
            <Trash2 size={17} />,
            () => {
              capture.current++;
              capturing.current = false;
              setBusy(false);
              if (annotations.length) onChange([]);
              setDraft(null);
              onSelection([]);
              setError('');
            },
            undefined,
            !annotations.length && !current,
          )}
          {iconButton('Exit annotation mode', <X size={17} />, () => {
            if (closeEditor()) onExit();
          })}
        </div>
      </div>
    );
  },
);
export default CanvasAnnotations;
