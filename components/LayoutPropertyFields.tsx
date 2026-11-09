import QuantityInput from './QuantityInput';
import { quantityUnitFromLabel, quantityLabel } from './quantity-units';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Select from './Select';

export function PropertySelect({
  displayLabel,
  ...props
}: React.ComponentProps<typeof Select> & { displayLabel?: string }) {
  return (
    <div className="layout-property-select">
      <span>{displayLabel ?? props.label}</span>
      <Select {...props} />
    </div>
  );
}

export function NumberField({
  label,
  value,
  min = -10000,
  max = 10000,
  onCommit,
  normalize,
  onCancel,
  step = 'any',
  disabled = false,
  active = true,
  resetKey = true,
  accessibleLabel = label,
  format = String,
  decimalPlaces = step === '1' ? undefined : 2,
  onRequestSave,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: string;
  disabled?: boolean;
  active?: boolean;
  resetKey?: boolean;
  accessibleLabel?: string;
  format?: (value: number) => string;
  decimalPlaces?: number;
  onRequestSave?: (saveAs: boolean) => void;
  onCommit: (value: number) => boolean | void;
  normalize?: (value: number) => number;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(format(value));
  const [invalid, setInvalid] = useState(false);
  const cancelling = useRef(false);
  const composing = useRef(false);
  useLayoutEffect(() => {
    setDraft(format(value));
    setInvalid(false);
  }, [value, resetKey, format]);
  function commit() {
    if (disabled || !active || cancelling.current || composing.current) return false;
    const number = Number(draft);
    // Accepted native values can lie outside the range offered for new edits.
    // Merely visiting the field must retain that exact accepted value.
    if (draft === format(value) || (draft.trim() && Number.isFinite(number) && number === value)) {
      setInvalid(false);
      setDraft(format(value));
      return true;
    }
    if (!draft.trim() || !Number.isFinite(number) || number < min || number > max) {
      setInvalid(true);
      return false;
    }
    setInvalid(false);
    const canonical = normalize ? normalize(number) : number;
    if (canonical === value) {
      setDraft(String(canonical));
      return true;
    }
    const accepted = onCommit(canonical);
    // A snapped no-op and an accepted edit display the same canonical value.
    // Rejected proposals retain their entered draft for correction or retry.
    if (accepted === false) setInvalid(true);
    else if (normalize && accepted === true) setDraft(String(canonical));
    return accepted !== false;
  }
  return (
    <label className="layout-field">
      <span>{quantityLabel(label)}</span>
      <QuantityInput
        decimalPlaces={decimalPlaces}
        unit={quantityUnitFromLabel(label)}
        type="number"
        disabled={disabled || !active}
        aria-label={accessibleLabel}
        value={draft}
        min={min}
        max={max}
        step={step}
        aria-invalid={invalid || undefined}
        aria-description={invalid ? `Enter a number from ${min} to ${max}.` : undefined}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onValueChange={(inputValue) => {
          if (!active) return;
          setDraft(inputValue);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || !commit()) {
              e.preventDefault();
              e.stopPropagation();
            } else if (onRequestSave) {
              e.preventDefault();
              e.stopPropagation();
              onRequestSave(e.shiftKey);
            }
            return;
          }
          if (!active || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDraft(format(value));
            setInvalid(false);
            if (onCancel) {
              // Focus changes blur synchronously, before this controlled draft
              // renders. Never apply the discarded value through that blur.
              cancelling.current = true;
              try {
                onCancel();
              } finally {
                cancelling.current = false;
              }
            }
          }
        }}
      />
    </label>
  );
}

export function TextField({
  label,
  value,
  onCommit,
  active = true,
  resetKey = true,
  multiline = false,
  placeholder,
  disabled = false,
  decimalPlaces,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => boolean | void;
  active?: boolean;
  resetKey?: boolean;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  decimalPlaces?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const composing = useRef(false);
  useLayoutEffect(() => {
    setDraft(value);
    setInvalid(false);
  }, [value, resetKey]);
  function commit() {
    if (!active || disabled || composing.current) return false;
    if (draft === value) return true;
    const accepted = onCommit(draft) !== false;
    setInvalid(!accepted);
    return accepted;
  }
  const props = {
    'aria-label': label,
    'aria-invalid': invalid || undefined,
    disabled: disabled || !active,
    value: draft,
    placeholder,
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      setInvalid(false);
    },
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !commit()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (
        !active ||
        composing.current ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDraft(value);
        setInvalid(false);
      } else if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        commit();
      }
    },
  };
  return (
    <label className="layout-field">
      <span>{label}</span>
      {multiline ? (
        <textarea {...props} rows={2} />
      ) : quantityUnitFromLabel(label) || decimalPlaces !== undefined ? (
        <QuantityInput
          {...props}
          decimalPlaces={decimalPlaces ?? 2}
          unit={quantityUnitFromLabel(label)}
          onValueChange={(value) => {
            setDraft(value);
            setInvalid(false);
          }}
        />
      ) : (
        <input {...props} type="text" />
      )}
    </label>
  );
}

export function OptionalNumberField({
  value,
  onCommit,
  min = -10000,
  max = 10000,
  ...props
}: {
  label: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => boolean | void;
  min?: number;
  max?: number;
  active?: boolean;
  resetKey?: boolean;
}) {
  return (
    <TextField
      {...props}
      decimalPlaces={2}
      value={value === undefined ? '' : String(value)}
      placeholder="Inherit"
      onCommit={(draft) => {
        if (!draft.trim()) return value === undefined || onCommit(undefined);
        const number = Number(draft);
        if (!Number.isFinite(number) || number < min || number > max) return false;
        if (number === value) return true;
        return onCommit(number);
      }}
    />
  );
}

export function PropertyRow({
  label,
  value,
  description,
  singleLine = false,
}: {
  label: string;
  value: ReactNode;
  description?: string;
  singleLine?: boolean;
}) {
  return (
    <div className="layout-property-readout" data-single-line={singleLine || undefined}>
      <span>{label}</span>
      <output aria-description={description}>{value}</output>
    </div>
  );
}

export function PropertySection({
  title,
  children,
  actions,
  showTitle = true,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  showTitle?: boolean;
}) {
  return (
    <section className="layout-property-section" aria-label={title}>
      {actions ? (
        <div className="layout-property-section-title">
          {showTitle && <h3>{title}</h3>}
          {actions}
        </div>
      ) : (
        showTitle && <h3>{title}</h3>
      )}
      {children}
    </section>
  );
}

export function PropertyGrid({ columns = 2, children }: { columns?: 2 | 3; children: ReactNode }) {
  return (
    <div className="layout-property-grid" data-columns={columns}>
      {children}
    </div>
  );
}

export function PropertyToggle({
  label,
  checked,
  onChange,
  active = true,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="layout-property-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={!active || disabled}
        onChange={(event) => {
          if (active && !disabled) onChange(event.target.checked);
        }}
      />
    </label>
  );
}
