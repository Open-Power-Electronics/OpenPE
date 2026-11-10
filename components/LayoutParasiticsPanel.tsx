import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { X } from 'lucide-react';
import type { CapabilityHost } from '@/api/capabilities';
import {
  PARASITICS_DEFAULTS,
  PARASITICS_THICKNESS_RANGE,
  type LayoutParasiticsResult,
} from '@/lib/layout-parasitics';
import type { PCB } from '@/lib/pcb';
import QuantityInput from './QuantityInput';
import { readQuantity } from './quantity-units';

const { min, max } = PARASITICS_THICKNESS_RANGE;
const numberFormat = new Intl.NumberFormat('en', { maximumSignificantDigits: 6 });

type Measurement = { board: PCB; revision: number } & (
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'complete'; result: LayoutParasiticsResult }
);

export default function LayoutParasiticsPanel({
  board,
  host,
  revision,
  startId,
  endId,
  composing,
  onReset,
  onClose,
}: {
  board: PCB;
  host: CapabilityHost;
  revision: number;
  startId?: string;
  endId?: string;
  composing: RefObject<boolean>;
  onReset: () => void;
  onClose: () => void;
}) {
  const [copper, setCopper] = useState(String(PARASITICS_DEFAULTS.copperThicknessMm));
  const [plating, setPlating] = useState(String(PARASITICS_DEFAULTS.viaPlatingMm));
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      composing.current = false;
    },
    [composing],
  );
  useLayoutEffect(() => {
    setMeasurement(null);
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [board, revision, startId, endId]);
  const copperThicknessMm = readQuantity(copper, 'mm');
  const viaPlatingMm = readQuantity(plating, 'mm');
  const copperValid = copperThicknessMm >= min && copperThicknessMm <= max;
  const platingValid = viaPlatingMm >= min && viaPlatingMm <= max;
  const current =
    measurement?.board === board && measurement.revision === revision ? measurement : null;
  const pending = current?.status === 'pending';
  const ready = !!startId && !!endId && startId !== endId && copperValid && platingValid;

  function invalidate() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setMeasurement(null);
  }
  async function measure() {
    if (!ready || activeRequest.current || composing.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const basis = { board, revision };
    setMeasurement({ ...basis, status: 'pending' });
    try {
      const result = (await host.query(
        'parasitics.measure',
        { boardId: board.id, startId, endId, copperThicknessMm, viaPlatingMm },
        { signal: controller.signal, expectedRevision: String(revision) },
      )) as LayoutParasiticsResult;
      if (!controller.signal.aborted) setMeasurement({ ...basis, status: 'complete', result });
    } catch (error) {
      if (!controller.signal.aborted)
        setMeasurement({ ...basis, status: 'error', message: (error as Error).message });
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function guardComposingButton(event: MouseEvent) {
    if (composing.current && event.target instanceof Element && event.target.closest('button')) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  return (
    <section
      className="layout-parasitics-panel"
      data-docked
      aria-label="Layout Parasitics"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onPointerDownCapture={guardComposingButton}
      onClickCapture={guardComposingButton}
      onKeyDownCapture={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          if (event.target instanceof HTMLButtonElement) event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <header className="editor-dock-header">
        <h2>Layout Parasitics</h2>
        <button
          type="button"
          className="tool-button"
          aria-label="Close Layout Parasitics"
          title="Close"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="layout-parasitics-body">
        <p className="layout-parasitics-status" role="status">
          {endId
            ? 'Two terminals selected'
            : startId
              ? 'Click a second terminal on the same net'
              : 'Click a pad or via on the board'}
        </p>
        <label className="layout-field">
          <span>Copper thickness</span>
          <QuantityInput
            unit="mm"
            aria-label="Copper thickness"
            aria-invalid={!copperValid}
            value={copper}
            onValueChange={(value) => {
              invalidate();
              setCopper(value);
            }}
          />
        </label>
        <label className="layout-field">
          <span>Via plating thickness</span>
          <QuantityInput
            unit="mm"
            aria-label="Via plating thickness"
            aria-invalid={!platingValid}
            value={plating}
            onValueChange={(value) => {
              invalidate();
              setPlating(value);
            }}
          />
        </label>
        {(!copperValid || !platingValid) && (
          <p className="dialog-error" role="alert">
            Enter thicknesses from {min} to {max} mm.
          </p>
        )}
        {current?.status === 'error' && (
          <p className="dialog-error" role="alert">
            {current.message}
          </p>
        )}
        {current?.status === 'complete' && <ParasiticsResult result={current.result} />}
      </div>
      <footer className="layout-parasitics-actions">
        <button type="button" className="dialog-button" disabled={!startId} onClick={onReset}>
          Reset
        </button>
        <button
          type="button"
          className="dialog-button primary analysis-run-button"
          disabled={!ready || pending}
          onClick={() => void measure()}
        >
          {pending ? 'Measuring…' : 'Measure'}
        </button>
      </footer>
    </section>
  );
}

function ParasiticsResult({ result }: { result: LayoutParasiticsResult }) {
  return (
    <div role="status">
      <dl className="layout-parasitics-results">
        <div>
          <dt>Equivalent DC resistance</dt>
          <dd>{numberFormat.format(result.equivalentResistanceOhm * 1000)} mΩ</dd>
        </div>
        <div>
          <dt>Shortest route length</dt>
          <dd>{numberFormat.format(result.shortestLengthMm)} mm</dd>
        </div>
        <div>
          <dt>Resistance on shortest route</dt>
          <dd>{numberFormat.format(result.shortestResistanceOhm * 1000)} mΩ</dd>
        </div>
        <div>
          <dt>Start and end layers</dt>
          <dd>
            {result.startLayer} → {result.endLayer}
          </dd>
        </div>
      </dl>
    </div>
  );
}
