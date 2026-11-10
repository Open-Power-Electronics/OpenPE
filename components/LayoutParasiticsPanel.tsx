import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { X } from 'lucide-react';
import type { CapabilityHost } from '@/api/capabilities';
import {
  PARASITICS_DEFAULTS,
  PARASITICS_THICKNESS_RANGE,
  type LayoutParasiticsResult,
} from '@/lib/layout-parasitics';
import type { PCB } from '@/lib/pcb';
import { padCopperLayers } from '@/lib/pcb-connectivity';
import { padPosition } from '@/lib/pcb-layout';
import QuantityInput from './QuantityInput';
import Select, { type SelectOption } from './Select';
import { readQuantity } from './quantity-units';

const { min, max } = PARASITICS_THICKNESS_RANGE;
const numberFormat = new Intl.NumberFormat('en', { maximumSignificantDigits: 6 });

function terminalOptions(board: PCB) {
  const byNet = new Map<string, SelectOption[]>();
  function add(netId: string, option: SelectOption) {
    const options = byNet.get(netId) ?? [];
    options.push(option);
    byNet.set(netId, options);
  }
  function location({ x, y }: { x: number; y: number }) {
    return `(${x.toFixed(3)}, ${y.toFixed(3)}) mm`;
  }
  for (const footprint of board.footprints) {
    for (const pad of footprint.pads) {
      if (!pad.netId || !padCopperLayers(board, footprint, pad).length) continue;
      add(pad.netId, {
        value: pad.id,
        label: `${footprint.reference || footprint.libraryId} pad ${pad.number} · ${location(padPosition(footprint, pad))}`,
      });
    }
  }
  for (const via of board.vias) {
    if (!via.netId) continue;
    add(via.netId, { value: via.id, label: `Via · ${location(via)}` });
  }
  for (const options of byNet.values())
    options.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  const nets = board.nets
    .filter(({ id }) => (byNet.get(id)?.length ?? 0) >= 2)
    .map(({ id, name }) => ({ value: id, label: name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  return { nets, byNet };
}

type Measurement = { board: PCB; revision: number } & (
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'complete'; result: LayoutParasiticsResult }
);

export default function LayoutParasiticsPanel({
  board,
  host,
  revision,
  onClose,
}: {
  board: PCB;
  host: CapabilityHost;
  revision: number;
  onClose: () => void;
}) {
  const { nets, byNet } = useMemo(() => terminalOptions(board), [board]);
  const [selection, setSelection] = useState({ netId: '', startId: '', endId: '' });
  const [copper, setCopper] = useState(String(PARASITICS_DEFAULTS.copperThicknessMm));
  const [plating, setPlating] = useState(String(PARASITICS_DEFAULTS.viaPlatingMm));
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    setMeasurement(null);
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [board, revision]);

  const netId = nets.some(({ value }) => value === selection.netId)
    ? selection.netId
    : nets.length === 1
      ? nets[0].value
      : '';
  const terminals = byNet.get(netId) ?? [];
  const startId = terminals.some(({ value }) => value === selection.startId)
    ? selection.startId
    : '';
  const endId = terminals.some(({ value }) => value === selection.endId) ? selection.endId : '';
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
        <p className="layout-parasitics-note">
          Estimate DC resistance between two terminals on the same net using straight tracks and
          through vias. The estimate assumes uniform copper at 20 °C and excludes planes, pours, pad
          spreading and AC effects.
        </p>
        {nets.length === 0 ? (
          <p className="layout-parasitics-note">
            Add two copper pads or vias assigned to the same net.
          </p>
        ) : (
          <>
            <div className="layout-field">
              <span>Net</span>
              <Select
                label="Net"
                value={netId}
                options={nets}
                placeholder="Choose a net"
                onChange={(value) => {
                  invalidate();
                  setSelection({ netId: value, startId: '', endId: '' });
                }}
              />
            </div>
            <div className="layout-field">
              <span>Start terminal</span>
              <Select
                label="Start terminal"
                value={startId}
                options={terminals.map((option) => ({
                  ...option,
                  disabled: option.value === endId,
                }))}
                disabled={!netId}
                placeholder="Choose a pad or via"
                onChange={(value) => {
                  invalidate();
                  setSelection({ netId, startId: value, endId });
                }}
              />
            </div>
            <div className="layout-field">
              <span>End terminal</span>
              <Select
                label="End terminal"
                value={endId}
                options={terminals.map((option) => ({
                  ...option,
                  disabled: option.value === startId,
                }))}
                disabled={!netId}
                placeholder="Choose a pad or via"
                onChange={(value) => {
                  invalidate();
                  setSelection({ netId, startId, endId: value });
                }}
              />
            </div>
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
          </>
        )}
      </div>
      {nets.length > 0 && (
        <footer className="layout-parasitics-actions">
          <button
            type="button"
            className="dialog-button primary analysis-run-button"
            disabled={!ready || pending}
            onClick={() => void measure()}
          >
            {pending ? 'Measuring…' : 'Measure'}
          </button>
        </footer>
      )}
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
