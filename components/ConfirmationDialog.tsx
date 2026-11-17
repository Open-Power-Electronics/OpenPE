import { FileText, LoaderCircle, Save } from 'lucide-react';
import Dialog from './Dialog';

export type ConfirmationKind = 'close' | 'close-project';

export default function ConfirmationDialog({
  documentTitle,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  documentTitle?: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (saveFirst?: boolean) => Promise<void>;
}) {
  return (
    <Dialog
      compact
      title="Save changes?"
      icon={<Save size={20} />}
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
              className="dialog-button quiet"
              disabled={busy}
              onClick={() => void onConfirm()}
            >
              Don't save
            </button>

            <button
              className="dialog-button primary"
              disabled={busy}
              onClick={() => void onConfirm(true)}
            >
              {busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
              Save
            </button>
          </div>
        </>
      }
    >
      <div className="dialog-document">
        <FileText size={20} />
        <span>
          <strong>{documentTitle}</strong>
        </span>
      </div>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
