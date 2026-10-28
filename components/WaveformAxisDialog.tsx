'use client';
import { useState, type RefObject } from 'react';
import Dialog from './Dialog';
import {
  parseWaveformNumber,
  validWaveformAxis,
  validWaveformTime,
  type WaveformAxis,
} from '@/lib/waveform-view';

export default function WaveformAxisDialog({
  axis,
  unit,
  time,
  title,
  anchorRef,
  onApply,
  onClose,
}: {
  axis: WaveformAxis;
  unit: 's' | 'V' | 'A';
  time?: number[];
  title: string;
  anchorRef: RefObject<HTMLElement | null>;
  onApply: (axis: WaveformAxis | null) => void;
  onClose: () => void;
}) {
  const [min, setMin] = useState(String(Number(axis.min.toPrecision(12))));
  const [max, setMax] = useState(String(Number(axis.max.toPrecision(12))));
  const [step, setStep] = useState(axis.step === undefined ? '' : String(axis.step));
  const [error, setError] = useState('');
  function apply() {
    const next = {
      min: parseWaveformNumber(min, unit),
      max: parseWaveformNumber(max, unit),
      ...(step.trim() ? { step: parseWaveformNumber(step, unit) } : {}),
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
      anchorPlacement="inside"
      className="waveform-axis-dialog"
      footer={
        <>
          <button className="dialog-button secondary" onClick={() => onApply(null)}>
            Auto scale
          </button>
          <button className="dialog-button primary" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <form
        className="waveform-axis-fields"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label>
          Minimum ({unit})<input value={min} onChange={(event) => setMin(event.target.value)} />
        </label>
        <label>
          Maximum ({unit})<input value={max} onChange={(event) => setMax(event.target.value)} />
        </label>
        <label>
          Tick spacing ({unit})
          <input
            value={step}
            placeholder="Auto"
            onChange={(event) => setStep(event.target.value)}
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
