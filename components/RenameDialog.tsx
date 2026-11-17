'use client';
import { useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { displayName, MAX_DISPLAY_NAME_LENGTH } from '@/lib/display-name';
import Dialog from './Dialog';

export default function RenameDialog({
  kind,
  initialName,
  onRename,
  onClose,
}: {
  kind: 'project' | 'conversation';
  initialName: string;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState('');
  const composing = useRef(false);
  function submit() {
    try {
      onRename(displayName(name));
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <Dialog
      compact
      title={`Rename ${kind}`}
      icon={<Pencil size={20} />}
      onClose={onClose}
      footer={
        <>
          <button className="dialog-button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="dialog-button primary" disabled={!name.trim()} onClick={submit}>
            Rename
          </button>
        </>
      }
    >
      <label className="rename-input">
        Name
        <input
          data-autofocus
          value={name}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
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
