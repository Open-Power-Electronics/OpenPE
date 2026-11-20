'use client';
import { useRef, useState, type RefObject } from 'react';
import Dialog from './Dialog';
import QuantityInput from './QuantityInput';
import {
  parseWaveformNumber,
  validWaveformAxis,
  validWaveformTime,
  type WaveformAxis,
} from '@/plugins/spice-simulation/domain/waveform-view';

export default function WaveformAxisDialog({
  axis,
  unit,
  time,
  title,
  anchorRef,
  anchorPoint,
  onApply,
  onClose,
}: {
  axis: WaveformAxis;
  unit: 's' | 'V' | 'A';
  time?: number[];
  title: string;
  anchorRef: RefObject<HTMLElement | null>;
  anchorPoint: { x: number; y: number };
  onApply: (axis: WaveformAxis | null) => void;
  onClose: () => void;
}) {
  const composing = useRef(false);
  const digits = Math.min(
    12,
    Math.max(
      5,
      Math.ceil(
        Math.log10(Math.max(Math.abs(axis.min), Math.abs(axis.max)) / (axis.max - axis.min)),
      ) + 3,
    ),
  );
  const initialMin = String(axis.min);
  const initialMax = String(axis.max);
  const initialStep = axis.step === undefined ? '' : String(axis.step);
  const [min, setMin] = useState(initialMin);
  const [max, setMax] = useState(initialMax);
  const [step, setStep] = useState(initialStep);
  const [error, setError] = useState('');
  function apply() {
    if (composing.current) return;
    const next = {
      min: min === initialMin ? axis.min : parseWaveformNumber(min, unit),
      max: max === initialMax ? axis.max : parseWaveformNumber(max, unit),
      ...(step.trim()
        ? { step: step === initialStep ? axis.step! : parseWaveformNumber(step, unit) }
        : {}),
    };
    if (!validWaveformAxis(next)) {
      setError(
        'Enter finite limits with maximum above minimum. Tick spacing must be positive and produce 1–100 divisions.',
      );
      return;
    }
    if (time && !validWaveformTime(time, next)) {
      setError('Choose a time range within the recorded duration containing at least two samples.');
      return;
    }
    onApply(next);
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      compact
      modal={false}
      anchorRef={anchorRef}
      anchorPlacement="near"
      anchorPoint={anchorPoint}
      className="waveform-axis-dialog"
      footer={
        <>
          <button
            className="dialog-button secondary"
            onClick={() => {
              if (!composing.current) onApply(null);
            }}
          >
            Autoscale
          </button>
          <button className="dialog-button primary" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <form
        className="waveform-axis-fields"
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
            event.stopPropagation();
            if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label>
          Min
          <QuantityInput
            unit={unit}
            autoScale
            precision={digits}
            aria-label={`Minimum (${unit})`}
            value={min}
            onValueChange={setMin}
          />
        </label>
        <label>
          Max
          <QuantityInput
            unit={unit}
            autoScale
            precision={digits}
            aria-label={`Maximum (${unit})`}
            value={max}
            onValueChange={setMax}
          />
        </label>
        <label>
          Step
          <QuantityInput
            unit={unit}
            autoScale
            precision={digits}
            aria-label={`Tick spacing (${unit})`}
            value={step}
            placeholder="Auto"
            onValueChange={setStep}
          />
        </label>
        <button type="submit" hidden />
      </form>
      {error && (
        <p className="simulation-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
