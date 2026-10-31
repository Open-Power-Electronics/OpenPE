'use client';
import { useRef, useState, type InputHTMLAttributes } from 'react';
import Select from './Select';
import {
  convertQuantity,
  preferredQuantityUnit,
  quantityUnits,
  readQuantity,
} from './quantity-units';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string | number;
  unit?: string;
  onValueChange: (value: string) => void;
  autoScale?: boolean;
  precision?: number;
};

export default function QuantityInput({
  value,
  unit,
  onValueChange,
  autoScale = false,
  precision = autoScale ? 5 : undefined,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  min,
  max,
  step,
  ...props
}: Props) {
  const source = String(value);
  const [chosen, setChosen] = useState(() =>
    unit && autoScale ? preferredQuantityUnit(source, unit) : unit,
  );
  const [edit, setEdit] = useState<{ source: string; unit: string; display: string } | null>(null);
  const composing = useRef(false);
  const container = useRef<HTMLSpanElement>(null);
  const options = unit ? quantityUnits(unit) : [];
  const canonical = options.find((entry) => entry.label === unit);
  const selected = options.find((entry) => entry.label === chosen) ?? canonical;
  const number = unit ? readQuantity(source, unit) : Number(source);
  function displayNumber(number: number) {
    return String(Number(number.toPrecision(precision ?? 8)));
  }
  const display =
    selected && canonical && Number.isFinite(number)
      ? selected.label === unit && precision === undefined && Number.isFinite(Number(source))
        ? source
        : displayNumber(convertQuantity(number, canonical, selected))
      : source;
  const bound = (value: string | number | undefined) => {
    if (value === undefined || !selected || !canonical || !Number.isFinite(Number(value)))
      return value;
    return convertQuantity(Number(value), canonical, selected);
  };
  const input = (
    <input
      {...props}
      inputMode={props.inputMode ?? (unit ? 'decimal' : undefined)}
      value={
        edit && edit.source === source && edit.unit === selected?.label ? edit.display : display
      }
      min={bound(min)}
      max={bound(max)}
      step={
        step === 'any' || step === undefined
          ? step
          : selected && canonical
            ? (Number(step) * canonical.factor) / selected.factor
            : step
      }
      onCompositionStart={(event) => {
        composing.current = true;
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        onCompositionEnd?.(event);
      }}
      onChange={(event) => {
        const raw = event.target.value;
        const parsed = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())
          ? Number(raw)
          : NaN;
        const next =
          selected && canonical && Number.isFinite(parsed)
            ? String(convertQuantity(parsed, selected, canonical))
            : raw;
        setEdit({ source: next, unit: selected?.label ?? '', display: raw });
        onValueChange(next);
      }}
      onBlur={(event) => {
        if (container.current?.contains(event.relatedTarget as Node | null)) {
          event.stopPropagation();
          return;
        }
        onBlur?.(event);
      }}
    />
  );
  if (!unit || !selected) return input;
  const label = props['aria-label'] ?? 'Value';
  return (
    <span
      className="quantity-input"
      ref={container}
      onPointerDownCapture={(event) => {
        if (
          composing.current &&
          event.target instanceof Element &&
          event.target.closest('button')
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClickCapture={(event) => {
        if (
          composing.current &&
          event.target instanceof Element &&
          event.target.closest('button')
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          if (event.target instanceof HTMLButtonElement) event.preventDefault();
          if (event.target instanceof HTMLButtonElement) event.stopPropagation();
        }
      }}
    >
      {input}
      <Select
        compact
        label={`${label} unit`}
        value={selected.label}
        disabled={props.disabled || props.readOnly || options.length === 1 || composing.current}
        options={options.map((entry) => ({ value: entry.label, label: entry.label }))}
        onChange={(next) => {
          if (!composing.current) {
            setChosen(next);
            setEdit(null);
          }
        }}
      />
    </span>
  );
}
