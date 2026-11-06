'use client';

import { useId, useMemo, useRef, useState } from 'react';
import type { PCB } from '@/lib/pcb';
import { preparePCBRegionFillet, type PCBRegionTarget } from '@/lib/pcb-region-fillet';
import Dialog from './Dialog';
import QuantityInput from './QuantityInput';

export default function LayoutRegionFilletDialog({
  board,
  target,
  getRevision,
  onCommit,
  onClose,
}: {
  board: PCB;
  target: PCBRegionTarget;
  getRevision?: () => number;
  onCommit: (board: PCB) => boolean;
  onClose: () => void;
}) {
  const [basis] = useState(() => ({ board, revision: getRevision?.(), target: { ...target } }));
  const [radius, setRadius] = useState('1');
  const formId = useId();
  const [error, setError] = useState('');
  const composing = useRef(false);
  const focusRadius = useRef(radius);
  const stale = board !== basis.board || getRevision?.() !== basis.revision;
  const preview = useMemo(() => {
    try {
      const candidate = preparePCBRegionFillet(basis.board, basis.target, Number(radius.trim()));
      const zone = candidate.zones.find((item) => item.id === basis.target.id);
      const graphic = candidate.graphics.find((item) => item.id === basis.target.id);
      const points =
        basis.target.kind === 'zone'
          ? zone!.outline
          : [graphic!.start, ...(graphic!.points ?? []), graphic!.end];
      const xs = points.map((point) => point.x),
        ys = points.map((point) => point.y);
      const x = Math.min(...xs),
        y = Math.min(...ys);
      const width = Math.max(...xs) - x,
        height = Math.max(...ys) - y;
      const margin = Math.max(width, height) * 0.08;
      return {
        candidate,
        path:
          `M${points.map((point) => `${point.x},${point.y}`).join(' L')} Z` +
          (zone?.holes ?? [])
            .map((hole) => ` M${hole.map((p) => `${p.x},${p.y}`).join(' L')} Z`)
            .join(''),
        viewBox: `${x - margin} ${y - margin} ${width + margin * 2} ${height + margin * 2}`,
        error: '',
      };
    } catch (issue) {
      return { candidate: null, path: '', viewBox: '', error: (issue as Error).message };
    }
  }, [basis, radius]);
  const issue = stale
    ? 'The project changed. Close this dialog and select the region again.'
    : preview.error || error;
  function close() {
    if (!composing.current) onClose();
  }
  function apply() {
    if (composing.current || stale || !preview.candidate) return;
    if (getRevision?.() !== basis.revision) {
      setError('The project changed. Close this dialog and select the region again.');
      return;
    }
    if (onCommit(preview.candidate)) onClose();
    else setError('The region could not be changed. Check the project and try again.');
  }
  return (
    <Dialog
      title="Fillet corners"
      compact
      onClose={close}
      footer={
        <div
          className="layout-region-fillet-actions"
          onKeyDown={(event) => {
            if (
              composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyUp={(event) => {
            if (
              composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <button type="button" className="dialog-button" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="dialog-button primary"
            disabled={stale || !preview.candidate}
          >
            Apply
          </button>
        </div>
      }
    >
      <form
        id={formId}
        className="layout-region-fillet-form"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          ) {
            if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
            event.stopPropagation();
          } else if (event.key === 'Escape' && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            event.stopPropagation();
            setRadius(focusRadius.current);
            setError('');
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label className="layout-region-fillet-radius">
          <span>Radius</span>
          <QuantityInput
            unit="mm"
            aria-label="Radius (mm)"
            aria-description="Round all convex corners with a maximum polygon chord error of 0.01 mm."
            value={radius}
            disabled={stale}
            aria-invalid={Boolean(preview.error)}
            autoFocus
            onFocus={() => {
              focusRadius.current = radius;
            }}
            onValueChange={(value) => {
              setRadius(value);
              setError('');
            }}
          />
        </label>
        {preview.candidate && !stale && (
          <svg
            className="layout-region-fillet-preview"
            viewBox={preview.viewBox}
            role="img"
            aria-label="Rounded region preview"
          >
            <path d={preview.path} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        {issue && (
          <p className="dialog-error" role="alert">
            {issue}
          </p>
        )}
      </form>
    </Dialog>
  );
}
