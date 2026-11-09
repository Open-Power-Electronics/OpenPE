'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { Clock3, Trash2, MessageSquareText } from 'lucide-react';
import type { AgentAnnotation } from '@/lib/agent-annotations';
import Dialog from './Dialog';
import AgentAnnotationDialog, { AnnotationPreview } from './AgentAnnotationDialog';

export default function AnnotationAttachments({
  annotations,
  onChange,
  basis,
  layoutBasis,
  onFocusInput,
}: {
  annotations: AgentAnnotation[];
  onChange?: (next: AgentAnnotation[]) => void;
  basis?: string;
  layoutBasis?: string;
  onFocusInput?: () => void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const tray = useRef<HTMLDivElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRemove = useRef<{ id: string; index: number } | null>(null);
  useLayoutEffect(() => {
    const request = focusAfterRemove.current;
    if (!request || annotations.some((item) => item.id === request.id)) return;
    focusAfterRemove.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const container = tray.current;
    if (!container?.getClientRects().length) return;
    const target = annotations[Math.min(request.index, annotations.length - 1)];
    const button = target ? removeButtons.current.get(target.id) : undefined;
    if (!button?.getClientRects().length) return;
    button.focus({ preventScroll: true });
    const bounds = container.getBoundingClientRect();
    const row = button.getBoundingClientRect();
    if (row.top < bounds.top) container.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom;
  }, [annotations]);
  const selected = annotations.find((a) => a.id === opened);
  return (
    <div
      ref={tray}
      className={`annotation-attachments${onChange ? ' annotation-attachments-pending' : ''}`}
      aria-label={onChange ? 'Pending annotations' : 'Message annotations'}
      onKeyDown={(event) => {
        if (
          (event.nativeEvent.isComposing || event.keyCode === 229) &&
          event.target instanceof Element &&
          event.currentTarget.contains(event.target) &&
          event.target.closest('button')
        )
          event.preventDefault();
      }}
    >
      {annotations.map((annotation, index) => {
        const name =
          annotation.elements.map((element) => element.label).join(', ') ||
          (annotation.markup?.kind === 'freehand' ? 'Drawing' : 'Area');
        const stale = annotation.target
          ? layoutBasis && annotation.basis !== layoutBasis
          : basis && annotation.basis !== basis;
        return (
          <div className="annotation-attachment" key={annotation.id}>
            <button
              type="button"
              className="annotation-attachment-preview"
              aria-label={`Preview annotation ${index + 1}`}
              aria-description={`${name}. ${annotation.comment}${stale ? ' Captured before latest edits.' : ''}`}
              onClick={() => setOpened(annotation.id)}
            >
              <img
                src={annotation.image.dataUrl}
                width={annotation.image.width}
                height={annotation.image.height}
                alt=""
              />
              {onChange ? (
                <span>
                  <strong>{annotation.comment || name}</strong>
                  {stale && (
                    <small
                      className="annotation-attachment-stale"
                      aria-description="Captured before latest edits"
                    >
                      <Clock3 size={12} aria-hidden="true" />
                      Earlier capture
                    </small>
                  )}
                </span>
              ) : (
                <span>
                  <strong>
                    <MessageSquareText size={13} />
                    {index + 1}.{' '}
                    {annotation.target === 'object'
                      ? 'Model · '
                      : annotation.target === 'layout'
                        ? 'Layout · '
                        : ''}
                    {name}
                  </strong>
                  <span>{annotation.comment}</span>
                  {stale && <small>Captured before latest edits</small>}
                </span>
              )}
            </button>
            {onChange && (
              <button
                type="button"
                className="icon-button annotation-attachment-remove"
                ref={(button) => {
                  if (button) removeButtons.current.set(annotation.id, button);
                  else removeButtons.current.delete(annotation.id);
                }}
                aria-label={`Remove annotation ${index + 1}`}
                title="Remove"
                aria-description="Remove annotation"
                onClick={(event) => {
                  if (event.currentTarget === document.activeElement) {
                    if (annotations.length === 1) onFocusInput?.();
                    else focusAfterRemove.current = { id: annotation.id, index };
                  }
                  onChange(annotations.filter((a) => a.id !== annotation.id));
                }}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
      {selected &&
        (onChange ? (
          <AgentAnnotationDialog
            key={selected.id}
            annotation={selected}
            editing
            onClose={() => setOpened(null)}
            onSave={(next) => {
              onChange(annotations.map((a) => (a.id === next.id ? next : a)));
              setOpened(null);
            }}
          />
        ) : (
          <Dialog title="Annotation" onClose={() => setOpened(null)}>
            <AnnotationPreview annotation={selected} />
            <p className="annotation-comment">{selected.comment}</p>
          </Dialog>
        ))}
    </div>
  );
}
