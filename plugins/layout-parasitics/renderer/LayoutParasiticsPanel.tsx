import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Eraser, FileInput, LoaderCircle, X } from 'lucide-react';
import type { CapabilityHost } from '@/api/capabilities';
import type { Circuit } from '@/lib/circuit';
import {
  PARASITICS_DEFAULTS,
  PARASITICS_THICKNESS_RANGE,
  type LayoutParasiticsResult,
} from '@/plugins/layout-parasitics/domain/analysis';
import type { PCB } from '@/lib/pcb';
import QuantityInput from '../../../components/QuantityInput';
import { readQuantity } from '../../../components/quantity-units';

const { min, max } = PARASITICS_THICKNESS_RANGE;
const numberFormat = new Intl.NumberFormat('en', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

type Measurement = {
  board: PCB;
  revision: number;
  startId: string;
  endId: string;
  copperThicknessMm: number;
  viaPlatingMm: number;
} & (
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
  schematicId,
  host,
  revision,
  startId,
  endId,
  composing,
  onReset,
  onClose,
  onAdded,
}: {
  board: PCB;
  schematic: Circuit;
  schematicId: string;
  host: CapabilityHost;
  revision: number;
  startId?: string;
  endId?: string;
  composing: RefObject<boolean>;
  onReset: () => void;
  onClose: () => void;
  onAdded: (schematicId: string) => void;
}) {
  const [copper, setCopper] = useState(String(PARASITICS_DEFAULTS.copperThicknessMm));
  const [plating, setPlating] = useState(String(PARASITICS_DEFAULTS.viaPlatingMm));
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState('');
  const creation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const selectionBasis = useRef({ board, revision });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      composing.current = false;
      creation.current?.abort();
    };
  }, [composing]);
  const copperThicknessMm = readQuantity(copper, 'mm');
  const viaPlatingMm = readQuantity(plating, 'mm');
  const copperValid = copperThicknessMm >= min && copperThicknessMm <= max;
  const platingValid = viaPlatingMm >= min && viaPlatingMm <= max;
  const current =
    !isComposing &&
    measurement?.board === board &&
    measurement.revision === revision &&
    measurement.startId === startId &&
    measurement.endId === endId &&
    measurement.copperThicknessMm === copperThicknessMm &&
    measurement.viaPlatingMm === viaPlatingMm
      ? measurement
      : null;
  const pending = current?.status === 'pending';
  const start = describeTerminal(board, schematic, startId);
  const end = describeTerminal(board, schematic, endId);
  const netName = start && board.nets.find((net) => net.id === start.netId)?.name;
  const ready =
    !!start &&
    !!end &&
    startId !== endId &&
    !!start.netId &&
    start.netId === end.netId &&
    copperValid &&
    platingValid;
  const completed = current?.status === 'complete' ? current.result : null;
  const canCreate =
    ready &&
    !!completed &&
    Number.isFinite(completed.equivalentResistanceOhm) &&
    completed.equivalentResistanceOhm > 0 &&
    (completed.shortestPartialInductanceNh === null ||
      (Number.isFinite(completed.shortestPartialInductanceNh) &&
        completed.shortestPartialInductanceNh > 0)) &&
    !creating;

  useLayoutEffect(() => {
    const changed =
      selectionBasis.current.board !== board || selectionBasis.current.revision !== revision;
    selectionBasis.current = { board, revision };
    setMeasurement(null);
    setCreationError('');
    // Workbench clears picks after a revision changes. Do not measure that
    // render's old terminal pair before the cleared selection reaches this dock.
    if (changed || !ready || !startId || !endId || isComposing || composing.current) return;
    const controller = new AbortController();
    const basis = { board, revision, startId, endId, copperThicknessMm, viaPlatingMm };
    setMeasurement({ ...basis, status: 'pending' });
    void (async () => {
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
      }
    })();
    return () => controller.abort();
  }, [
    host,
    board,
    revision,
    startId,
    endId,
    copperThicknessMm,
    viaPlatingMm,
    ready,
    isComposing,
    composing,
  ]);

  async function createStudy() {
    if (!canCreate || !startId || !endId || composing.current || creation.current) return;
    const controller = new AbortController();
    creation.current = controller;
    setCreating(true);
    setCreationError('');
    try {
      const result = (await host.execute(
        'parasitics.createStudy',
        { boardId: board.id, schematicId, startId, endId, copperThicknessMm, viaPlatingMm },
        { signal: controller.signal, expectedRevision: String(revision) },
      )) as { schematicId: string };
      if (!mounted.current || controller.signal.aborted || creation.current !== controller) return;
      onAdded(result.schematicId);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setCreationError(
          error instanceof Error ? error.message : 'Could not add parasitic components.',
        );
    } finally {
      if (creation.current === controller) {
        creation.current = null;
        if (mounted.current) setCreating(false);
      }
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
        setIsComposing(true);
      }}
      onCompositionEnd={() => {
        composing.current = false;
        setIsComposing(false);
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
          disabled={creating}
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
                disabled={creating}
                value={copper}
                onValueChange={(value) => {
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
                disabled={creating}
                value={plating}
                onValueChange={(value) => {
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
        <ParasiticsResult
          pending={pending}
          result={current?.status === 'complete' ? current.result : undefined}
        />
        {current?.status === 'error' && (
          <p className="dialog-error" role="alert">
            {current.message}
          </p>
        )}
        {creationError && (
          <p className="dialog-error" role="alert">
            {creationError}
          </p>
        )}
      </div>
      <footer className="layout-parasitics-actions">
        <button
          type="button"
          className="dialog-button quiet analysis-footer-button"
          aria-label="Add parasitic components"
          title="Add parasitic components"
          aria-busy={creating}
          disabled={!canCreate}
          onClick={() => void createStudy()}
        >
          {creating ? (
            <LoaderCircle className="spin" aria-hidden="true" />
          ) : (
            <FileInput aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="dialog-button quiet analysis-footer-button"
          aria-label="Clear selected terminals"
          title="Clear selected terminals"
          disabled={!startId || creating}
          onClick={onReset}
        >
          <Eraser aria-hidden="true" />
        </button>
      </footer>
    </section>
  );
}

function ParasiticsResult({
  result,
  pending,
}: {
  result?: LayoutParasiticsResult;
  pending: boolean;
}) {
  const inductance = result?.shortestPartialInductanceNh;
  return (
    <div className="layout-property-section" role="status" aria-busy={pending}>
      <div className="layout-property-section-title">
        <h3>Results</h3>
        {pending && <LoaderCircle className="spin" size={14} role="img" aria-label="Measuring…" />}
      </div>
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
