import { FileText, LoaderCircle, Save, Trash2 } from 'lucide-react';
import Dialog from './Dialog';

export type ConfirmationKind = 'clear' | 'close' | 'close-project';

export default function ConfirmationDialog({
  kind,
  documentTitle,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  kind: ConfirmationKind;
  documentTitle?: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (saveFirst?: boolean) => Promise<void>;
}) {
  return (
    <Dialog
      compact
      title={kind === 'clear' ? 'Clear conversation?' : 'Save changes?'}
      icon={kind === 'clear' ? <Trash2 size={20} /> : <Save size={20} />}
      busy={busy}
      onClose={onCancel}
      footer={
        <>
          <button
            className="dialog-button secondary"
            data-autofocus
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <div className="dialog-footer-actions">
            <button
              className={`dialog-button ${kind === 'clear' ? 'primary' : 'quiet'}`}
              disabled={busy}
              onClick={() => void onConfirm()}
            >
              {kind === 'clear' ? 'Clear conversation' : "Don't save"}
            </button>
            {kind !== 'clear' && (
              <button
                className="dialog-button primary"
                disabled={busy}
                onClick={() => void onConfirm(true)}
              >
                {busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
                Save
              </button>
            )}
          </div>
        </>
      }
    >
      {kind === 'clear' && (
        <p className="modal-description">Removes messages and proposals; keeps the schematic.</p>
      )}
      {kind !== 'clear' && (
        <div className="dialog-document">
          <FileText size={20} />
          <span>
            <strong>{documentTitle}</strong>
          </span>
        </div>
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
