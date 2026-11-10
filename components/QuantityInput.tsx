'use client';
import { useRef, useState, type InputHTMLAttributes, type MouseEvent } from 'react';
import Select from './Select';
import {
  convertQuantity,
  formatFixedQuantity,
  preferredQuantityUnit,
  quantityUnits,
  readQuantity,
} from './quantity-units';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'> & {
  value: string | number;
  unit?: string;
  onValueChange: (value: string) => void;
  onBlur?: () => void;
  autoScale?: boolean;
  precision?: number;
  decimalPlaces?: number;
};

export default function QuantityInput({
  value,
  unit,
  onValueChange,
  autoScale = false,
  precision = autoScale ? 5 : undefined,
  decimalPlaces,
  onFocus,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  min,
  max,
  step,
  ...props
}: Props) {
  const source = String(value);
  const [chosen, setChosen] = useState<string>();
  const [edit, setEdit] = useState<{ source: string; unit: string; display: string } | null>(null);
  const composing = useRef(false);
  const [focused, setFocused] = useState(false);
  const focusedUnit = useRef<string | undefined>(undefined);
  const options = unit ? quantityUnits(unit) : [];
  const canonical = options.find((entry) => entry.label === unit);
  const number = unit ? readQuantity(source, unit) : Number(source);
  const invalid =
    !Number.isFinite(number) || props['aria-invalid'] === true || props['aria-invalid'] === 'true';
  const retainedUnit =
    focused || composing.current
      ? focusedUnit.current
      : invalid && edit?.source === source
        ? edit.unit
        : undefined;
  const displayUnit =
    chosen ?? (unit && autoScale ? (retainedUnit ?? preferredQuantityUnit(source, unit)) : unit);
  const selected = options.find((entry) => entry.label === displayUnit) ?? canonical;
  const hasUnitPicker = Boolean(unit && selected);
  function displayNumber(number: number) {
    return String(Number(number.toPrecision(precision ?? 8)));
  }
  const displayedNumber =
    selected && canonical ? convertQuantity(number, canonical, selected) : number;
  const rawDisplay =
    selected && canonical && Number.isFinite(number)
      ? selected.label === unit && precision === undefined && Number.isFinite(Number(source))
        ? source
        : displayNumber(displayedNumber)
      : source;
  const display =
    decimalPlaces !== undefined && source.trim() && Number.isFinite(displayedNumber)
      ? formatFixedQuantity(displayedNumber, decimalPlaces)
      : rawDisplay;
  const bound = (value: string | number | undefined) => {
    if (value === undefined || !selected || !canonical || !Number.isFinite(Number(value)))
      return value;
    return convertQuantity(Number(value), canonical, selected);
  };
  function leaveField() {
    if (!composing.current) onBlur?.();
  }
  function guardUnitPointer(event: MouseEvent<HTMLSpanElement>) {
    if (composing.current && event.target instanceof Element && event.target.closest('button')) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  const input = (
    <input
      {...props}
      inputMode={props.inputMode ?? (unit ? 'decimal' : undefined)}
      value={
        edit &&
        edit.source === source &&
        edit.unit === (selected?.label ?? '') &&
        ((decimalPlaces === undefined && !autoScale) || focused || composing.current || invalid)
          ? edit.display
          : display
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
      onFocus={(event) => {
        if (autoScale || decimalPlaces !== undefined) {
          focusedUnit.current = selected?.label;
          setFocused(true);
        }
        onFocus?.(event);
      }}
      onCompositionStart={(event) => {
        composing.current = true;
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        onCompositionEnd?.(event);
      }}
      onKeyDown={(event) => {
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          if (
            event.key === 'Enter' ||
            event.key === 'Escape' ||
            ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')
          )
            event.preventDefault();
          event.stopPropagation();
          return;
        }
        onKeyDown?.(event);
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
      onBlur={() => {
        if (autoScale || decimalPlaces !== undefined) setFocused(false);
        if (!hasUnitPicker) leaveField();
      }}
    />
  );
  if (!unit || !selected) return input;
  const label = props['aria-label'] ?? 'Value';
  return (
    <span
      className="quantity-input"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) leaveField();
      }}
      onPointerDownCapture={guardUnitPointer}
      onClickCapture={guardUnitPointer}
      onKeyDownCapture={(event) => {
        if (
          event.target instanceof HTMLButtonElement &&
          (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {input}
      <Select
        compact
        showChevron={false}
        label={`${label} unit`}
        value={selected.label}
        disabled={props.disabled || props.readOnly || options.length === 1}
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
