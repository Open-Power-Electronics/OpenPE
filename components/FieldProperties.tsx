'use client';
import QuantityInput from './QuantityInput';

import { useLayoutEffect, useState } from 'react';
import { fmt, snap, type Point } from '@/lib/circuit';
import type { SelectableField } from '@/lib/schematic-edit';

export default function FieldProperties({
  field,
  text,
  position,
  onText,
  onPosition,
  onRequestSave,
  active = true,
}: {
  field: SelectableField;
  text: string;
  position: Point;
  onText: (text: string) => boolean;
  onPosition: (position: Point) => boolean;
  onRequestSave?: (saveAs: boolean) => void;
  active?: boolean;
}) {
  const snapshot = JSON.stringify([field, text, position.x, position.y]);
  const [basis, setBasis] = useState(snapshot);
  const [draft, setDraft] = useState(text);
  const [coordinates, setCoordinates] = useState({ x: fmt(position.x), y: fmt(position.y) });
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    setBasis(snapshot);
    setDraft(text);
    setCoordinates({ x: fmt(position.x), y: fmt(position.y) });
    setError('');
  }, [snapshot]);

  function saveText(): boolean {
    if (!active || basis !== snapshot) return false;
    if (draft === text) return true;
    if (!draft.trim()) {
      setError(`Enter a ${field.toLowerCase()}.`);
      return false;
    }
    try {
      if (onText(draft)) {
        setError('');
        return true;
      }
      setError(`The ${field.toLowerCase()} could not be applied.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : `Invalid ${field.toLowerCase()}.`);
    }
    return false;
  }
  function savePosition(axis: 'x' | 'y'): boolean {
    if (!active || basis !== snapshot) return false;
    const input = coordinates[axis];
    // Display rounding must never snap or materialize an untouched text field.
    if (input === fmt(position[axis])) return true;
    const value = Number(input);
    if (
      !input.trim() ||
      !Number.isFinite(value) ||
      Math.abs(value) > 100000 ||
      Math.abs(snap(value)) > 100000
    ) {
      setError('Position must be between -100000 and 100000 mm.');
      return false;
    }
    if (value === Number(fmt(position[axis]))) {
      setCoordinates((current) => ({ ...current, [axis]: fmt(position[axis]) }));
      setError('');
      return true;
    }
    if (onPosition({ ...position, [axis]: value })) {
      setCoordinates((current) => ({ ...current, [axis]: fmt(snap(value)) }));
      setError('');
      return true;
    } else setError('The text position could not be applied.');
    return false;
  }

  return (
    <div className="field-properties">
      <label>
        {field}
        <input
          aria-label={`${field} text`}
          value={draft}
          disabled={!active}
          onChange={(event) => {
            if (active) setDraft(event.target.value);
          }}
          onBlur={saveText}
          onKeyDown={(event) => {
            if (!active || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              event.stopPropagation();
              return;
            }
            if (
              onRequestSave &&
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === 's'
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (saveText()) onRequestSave(event.shiftKey);
              return;
            }
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDraft(text);
              setError('');
            }
          }}
        />
      </label>
      <div className="geometry-fields text-geometry">
        {(['x', 'y'] as const).map((axis) => (
          <label key={axis}>
            {axis.toUpperCase()}
            <QuantityInput
              decimalPlaces={2}
              unit={'mm'}
              aria-label={`Text ${axis.toUpperCase()} position`}
              type="number"
              step="1.27"
              min={-100000}
              max={100000}
              value={coordinates[axis]}
              disabled={!active}
              onValueChange={(inputValue) => {
                if (active) setCoordinates({ ...coordinates, [axis]: inputValue });
              }}
              onBlur={() => savePosition(axis)}
              onKeyDown={(event) => {
                if (!active || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                  event.stopPropagation();
                  return;
                }
                if (
                  onRequestSave &&
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === 's'
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (savePosition(axis)) onRequestSave(event.shiftKey);
                  return;
                }
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setCoordinates({ ...coordinates, [axis]: fmt(position[axis]) });
                  setError('');
                }
              }}
            />
          </label>
        ))}
      </div>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
