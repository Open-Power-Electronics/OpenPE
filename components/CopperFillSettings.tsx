'use client';

import { useRef, useState } from 'react';
import { X } from 'lucide-react';

export default function CopperFillSettings({
  clearance,
  active,
  onFill,
  onClose,
  onCancelField,
}: {
  clearance: number;
  active: boolean;
  onFill: (clearance: number) => Promise<boolean>;
  onClose: () => void;
  onCancelField: () => void;
}) {
  const [draft, setDraft] = useState(String(clearance));
  const [busy, setBusy] = useState(false);
  const filling = useRef(false);
  return (
    <aside
      className="layout-tool-settings layout-tool-settings-fill editor-tool-sheet"
      aria-label="Copper fill settings"
      onKeyDown={(event) => {
        if (!active || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <strong>Fill copper zones</strong>
      </header>
      <form
        className="layout-tool-settings-content"
        onSubmit={async (event) => {
          event.preventDefault();
          const value = Number(draft);
          if (
            !active ||
            filling.current ||
            !draft.trim() ||
            !Number.isFinite(value) ||
            value < 0.0001 ||
            value > 1000
          )
            return;
          filling.current = true;
          setBusy(true);
          try {
            await onFill(value);
          } finally {
            filling.current = false;
            setBusy(false);
          }
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          )
            event.preventDefault();
        }}
      >
        <label className="layout-field">
          <span>Minimum clearance (mm)</span>
          <input
            type="number"
            aria-label="Minimum clearance (mm)"
            aria-description="Minimum gap to other nets. Larger zone clearances are retained."
            value={draft}
            min={0.0001}
            max={1000}
            step="any"
            required
            disabled={!active || busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (!active || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                return;
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setDraft(String(clearance));
                onCancelField();
              }
            }}
          />
        </label>
        <button type="submit" className="dialog-button primary" disabled={!active || busy}>
          Fill zones
        </button>
      </form>
      <button
        className="layout-tool-settings-close"
        aria-label="Close tool settings"
        title="Close"
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </aside>
  );
}
