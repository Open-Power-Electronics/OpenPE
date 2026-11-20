import { FileText, LoaderCircle, Save, Trash2 } from 'lucide-react';
import Dialog from './Dialog';

export type ConfirmationKind = 'close' | 'close-project' | 'remove-schematic';

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
  const removingSchematic = kind === 'remove-schematic';
  return (
    <Dialog
      compact
      title={removingSchematic ? 'Remove schematic?' : 'Save changes?'}
      icon={removingSchematic ? <Trash2 size={20} /> : <Save size={20} />}
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
          {removingSchematic ? (
            <button
              className="dialog-button primary"
              disabled={busy}
              onClick={() => void onConfirm()}
            >
              {busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
              Remove
            </button>
          ) : (
            <div className="dialog-footer-actions">
              <button
                className="dialog-button quiet"
                disabled={busy}
                onClick={() => void onConfirm()}
              >
                Discard
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
          )}
        </>
      }
    >
      <div className="dialog-document">
        <FileText size={20} />
        <span>
          <strong>{documentTitle}</strong>
        </span>
      </div>
      {removingSchematic && <p>You can restore this schematic with Undo.</p>}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
