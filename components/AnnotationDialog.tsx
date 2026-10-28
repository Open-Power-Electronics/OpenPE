'use client';
import { useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import Dialog from './Dialog';

export default function AnnotationDialog({
  initialText,
  editing,
  onSave,
  onClose,
}: {
  initialText: string;
  editing: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState('');
  return (
    <Dialog
      title={editing ? 'Edit annotation' : 'Add annotation'}
      icon={<MessageSquareText size={20} />}
      compact
      onClose={onClose}
      footer={
        <>
          <button className="dialog-button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="dialog-button primary"
            disabled={!text.trim()}
            onClick={() => {
              try {
                onSave(text);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {editing ? 'Apply' : 'Add'}
          </button>
        </>
      }
    >
      <label className="annotation-input">
        Text
        <textarea
          data-autofocus
          aria-label="Annotation text"
          value={text}
          maxLength={4096}
          rows={5}
          onChange={(e) => {
            setText(e.target.value);
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
