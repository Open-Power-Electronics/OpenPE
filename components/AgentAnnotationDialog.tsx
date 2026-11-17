'use client';
import { useState, type RefObject } from 'react';
import Dialog from './Dialog';
import { validateAnnotations, type AgentAnnotation } from '@/lib/agent-annotations';

export function AnnotationPreview({ annotation }: { annotation: AgentAnnotation }) {
  const surface =
    annotation.target === 'object'
      ? '3D board'
      : annotation.target === 'layout'
        ? 'layout'
        : 'schematic';
  return (
    <div className="agent-annotation-preview">
      <img
        src={annotation.image.dataUrl}
        width={annotation.image.width}
        height={annotation.image.height}
        alt={
          annotation.elements.length
            ? `Selected ${surface} elements: ${annotation.elements.map((e) => e.label).join(', ')}`
            : `Annotated ${surface} area`
        }
      />
      <details>
        <summary>
          {annotation.elements.length} selected{' '}
          {annotation.elements.length === 1 ? 'element' : 'elements'}
        </summary>
        {annotation.elements.map((element) => (
          <section key={element.id}>
            <strong>{element.label}</strong>
            <dl>
              <dt>ID</dt>
              <dd>{element.id}</dd>
              {Object.entries(element.properties).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </details>
    </div>
  );
}

export default function AgentAnnotationDialog({
  annotation,
  editing = false,
  anchorRef,
  onSave,
  onClose,
}: {
  annotation: AgentAnnotation;
  editing?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  onSave: (annotation: AgentAnnotation) => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState(annotation.comment);
  const [error, setError] = useState('');
  return (
    <Dialog
      title={editing ? 'Edit annotation' : 'Annotate selection'}
      anchorRef={anchorRef}
      className="agent-annotation-dialog"
      onClose={onClose}
      footer={
        <>
          <button className="dialog-button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="dialog-button primary"
            disabled={!comment.trim()}
            onClick={() => {
              try {
                const next = { ...annotation, comment: comment.trim() };
                validateAnnotations([next]);
                onSave(next);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {editing ? 'Update annotation' : 'Add to message'}
          </button>
        </>
      }
    >
      <AnnotationPreview annotation={annotation} />
      <label className="annotation-input">
        Comment
        <textarea
          data-autofocus
          aria-label="Annotation comment"
          value={comment}
          maxLength={4096}
          rows={3}
          placeholder="What should the agent change or explain?"
          onChange={(e) => {
            setComment(e.target.value);
            setError('');
          }}
        />
      </label>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
