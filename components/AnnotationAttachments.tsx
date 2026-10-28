'use client';
import { useState } from 'react';
import { Clock3, Trash2, MessageSquareText } from 'lucide-react';
import type { AgentAnnotation } from '@/lib/agent-annotations';
import Dialog from './Dialog';
import AgentAnnotationDialog, { AnnotationPreview } from './AgentAnnotationDialog';

export default function AnnotationAttachments({
  annotations,
  onChange,
  basis,
  layoutBasis,
}: {
  annotations: AgentAnnotation[];
  onChange?: (next: AgentAnnotation[]) => void;
  basis?: string;
  layoutBasis?: string;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const selected = annotations.find((a) => a.id === opened);
  return (
    <div
      className={`annotation-attachments${onChange ? ' annotation-attachments-pending' : ''}`}
      aria-label={onChange ? 'Pending annotations' : 'Message annotations'}
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
                aria-label={`Remove annotation ${index + 1}`}
                title="Remove"
                aria-description="Remove annotation"
                onClick={() => onChange(annotations.filter((a) => a.id !== annotation.id))}
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
