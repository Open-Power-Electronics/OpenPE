import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { LoaderCircle, RotateCcw, Ruler, X } from 'lucide-react';
import type { CapabilityHost } from '@/api/capabilities';
import type { Circuit } from '@/lib/circuit';
import {
  PARASITICS_DEFAULTS,
  PARASITICS_THICKNESS_RANGE,
  type LayoutParasiticsResult,
} from '@/lib/layout-parasitics';
import type { PCB } from '@/lib/pcb';
import QuantityInput from './QuantityInput';
import { readQuantity } from './quantity-units';

const { min, max } = PARASITICS_THICKNESS_RANGE;
const numberFormat = new Intl.NumberFormat('en', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

type Measurement = { board: PCB; revision: number } & (
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'complete'; result: LayoutParasiticsResult }
);

function describeTerminal(board: PCB, schematic: Circuit, id?: string) {
  if (!id) return;
  const via = board.vias.find((item) => item.id === id);
  if (via)
    return {
      label: `Via · X ${numberFormat.format(via.x)}, Y ${numberFormat.format(via.y)} mm`,
      netId: via.netId,
    };
  for (const footprint of board.footprints) {
    const pad = footprint.pads.find((item) => item.id === id);
    if (!pad) continue;
    const reference =
      schematic.parts.find((part) => part.id === footprint.symbolId)?.ref ??
      footprint.reference ??
      footprint.libraryId;
    return { label: `${reference} · Pad ${pad.number || '—'}`, netId: pad.netId };
  }
}

export default function LayoutParasiticsPanel({
  board,
  schematic,
  host,
  revision,
  startId,
  endId,
  composing,
  onReset,
  onClose,
}: {
  board: PCB;
  schematic: Circuit;
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
  const start = describeTerminal(board, schematic, startId);
  const end = describeTerminal(board, schematic, endId);
  const netName = start && board.nets.find((net) => net.id === start.netId)?.name;
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
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
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
        <div className="layout-property-section">
          <h3>Geometry</h3>
          <div className="layout-property-grid layout-parasitics-settings">
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
          </div>
          {(!copperValid || !platingValid) && (
            <p className="dialog-error" role="alert">
              Enter thicknesses from {min} to {max} mm.
            </p>
          )}
        </div>
        <div className="layout-property-section">
          <h3>Terminals</h3>
          <dl className="layout-parasitics-readout layout-parasitics-terminals">
            <div>
              <dt>
                Terminal{' '}
                <span className="layout-parasitics-badge" data-picked={!!start}>
                  1
                </span>
              </dt>
              <dd>{start?.label ?? '—'}</dd>
            </div>
            <div>
              <dt>
                Terminal{' '}
                <span className="layout-parasitics-badge" data-picked={!!end}>
                  2
                </span>
              </dt>
              <dd>{end?.label ?? '—'}</dd>
            </div>
            <div>
              <dt>Net</dt>
              <dd>{netName ?? '—'}</dd>
            </div>
          </dl>
        </div>
        <ParasiticsResult result={current?.status === 'complete' ? current.result : undefined} />
        {current?.status === 'error' && (
          <p className="dialog-error" role="alert">
            {current.message}
          </p>
        )}
      </div>
      <footer className="layout-parasitics-actions">
        <button
          type="button"
          className="dialog-button quiet analysis-footer-button"
          aria-label="Reset"
          title="Reset"
          disabled={!startId}
          onClick={onReset}
        >
          <RotateCcw aria-hidden="true" />
        </button>
        <button
          type="button"
          className="dialog-button quiet analysis-footer-button"
          aria-label={pending ? 'Measuring…' : 'Measure'}
          title={pending ? 'Measuring…' : 'Measure'}
          disabled={!ready || pending}
          onClick={() => void measure()}
        >
          {pending ? (
            <LoaderCircle className="spin" aria-hidden="true" />
          ) : (
            <Ruler aria-hidden="true" />
          )}
        </button>
      </footer>
    </section>
  );
}

function ParasiticsResult({ result }: { result?: LayoutParasiticsResult }) {
  const inductance = result?.shortestPartialInductanceNh;
  return (
    <div className="layout-property-section" role="status">
      <h3>Results</h3>
      <dl className="layout-parasitics-readout layout-parasitics-results">
        <div>
          <dt title="Shortest route length">Distance</dt>
          <dd>{result ? `${numberFormat.format(result.shortestLengthMm)} mm` : '—'}</dd>
        </div>
        <div>
          <dt title="Equivalent DC resistance">Resistance</dt>
          <dd>
            {result ? `${numberFormat.format(result.equivalentResistanceOhm * 1000)} mΩ` : '—'}
          </dd>
        </div>
        <div>
          <dt title="Shortest-route estimate excluding the return path">Partial inductance</dt>
          <dd>
            {inductance === undefined
              ? '—'
              : inductance === null
                ? 'Outside model'
                : `${numberFormat.format(inductance)} nH`}
          </dd>
        </div>
      </dl>
    </div>
  );
}
