'use client';
import QuantityInput from './QuantityInput';
import type { ModelCadSketchExtrusion } from '@/lib/model-cad-sketch';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { uid } from '@/lib/circuit';
import {
  modelCadSelectableEdges,
  newModelCadBooleanObject,
  validateModelCadObject,
  type ModelCadObject,
} from '@/lib/model-cad';
import Select from './Select';
import { parseNumericInput } from './numeric-input';
import styles from './ModelCadFeaturePanel.module.css';

export type ModelCadFeatureMode = 'sketch' | 'chamfer' | 'fillet' | 'boolean';
export type ModelCadFeatureAction =
  | { kind: 'solid'; object: ModelCadObject }
  | { kind: 'sketch'; sketch: ModelCadSketchExtrusion }
  | {
      kind: 'boolean';
      operation: 'union' | 'difference' | 'intersection';
      targetId: string;
      toolId: string;
      resultId: string;
    };

export default function ModelCadFeaturePanel({
  mode,
  object,
  objects,
  disabled,
  revision,
  baseRevision,
  selectedEdges,
  onSelectedEdgesChange,
  booleanOperands,
  onBooleanOperandsChange,
  booleanSelectionError,
  booleanSelectionOwners = [],
  onClose,
  onPreview,
  onApply,
}: {
  mode: Exclude<ModelCadFeatureMode, 'sketch'>;
  object: ModelCadObject | null;
  objects: readonly ModelCadObject[];
  disabled: boolean;
  revision: string;
  baseRevision: string;
  selectedEdges: readonly string[];
  onSelectedEdgesChange: (edges: string[]) => void;
  booleanOperands: readonly string[];
  onBooleanOperandsChange: (ids: string[]) => void;
  booleanSelectionError?: string;
  booleanSelectionOwners?: readonly string[];
  onClose: () => void;
  onPreview: (object: ModelCadObject | null, replacedIds?: readonly string[]) => void;
  onApply: (action: ModelCadFeatureAction) => Promise<void>;
}) {
  const [distance, setDistance] = useState(String(object?.edgeTreatment?.distanceMm ?? 0.5));
  const [operation, setOperation] = useState<'union' | 'difference' | 'intersection'>('union');
  const [targetId = '', toolId = ''] = booleanOperands;
  const [resultId] = useState(uid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const composition = useRef(false);
  const focusDistance = useRef(distance);
  const stale = revision !== baseRevision;
  const selectableEdges = useMemo(() => (object ? modelCadSelectableEdges(object) : []), [object]);
  const parsed = useMemo(() => {
    try {
      if (mode === 'boolean') {
        if (booleanSelectionError) throw new Error(booleanSelectionError);
        if (booleanOperands.length < 2) return { object: null, error: '' };
        if (booleanOperands.length !== 2) throw new Error('Select exactly two different solids.');
        const target = objects.find((body) => body.id === targetId);
        const tool = objects.find((body) => body.id === toolId);
        if (!target || !tool || target.id === tool.id)
          throw new Error('Select two different available solids.');
        return { object: newModelCadBooleanObject(target, tool, operation, resultId), error: '' };
      }
      if (!object) throw new Error('Select a solid.');
      if (!selectedEdges.length) return { object: null, error: '' };
      return {
        object: validateModelCadObject({
          ...object,
          edgeTreatment: {
            kind: mode,
            distanceMm: parseNumericInput(distance, mode === 'fillet' ? 'Radius' : 'Distance'),
            edges: [...selectedEdges],
          },
        }),
        error: '',
      };
    } catch (cause) {
      return { object: null, error: (cause as Error).message };
    }
  }, [
    mode,
    object,
    objects,
    targetId,
    toolId,
    booleanOperands.length,
    booleanSelectionError,
    operation,
    resultId,
    distance,
    selectedEdges,
  ]);
  useEffect(() => {
    onPreview(
      stale ? null : parsed.object,
      stale || !parsed.object
        ? []
        : mode === 'boolean'
          ? [targetId, toolId]
          : object
            ? [object.id]
            : [],
    );
  }, [parsed.object, stale, onPreview, mode, targetId, toolId, object]);
  useEffect(() => () => onPreview(null), [onPreview]);
  useEffect(() => setError(''), [targetId, toolId, booleanSelectionError]);
  const title = mode === 'boolean' ? 'Boolean' : mode === 'chamfer' ? 'Chamfer' : 'Fillet';
  const canSwap =
    booleanOperands.length === 2 &&
    targetId !== toolId &&
    [targetId, toolId].every((id) => objects.some((body) => body.id === id));
  async function apply() {
    if (disabled || stale || busy || !parsed.object || composition.current) return;
    setBusy(true);
    setError('');
    try {
      await onApply(
        mode === 'boolean'
          ? { kind: 'boolean', operation, targetId, toolId, resultId }
          : { kind: 'solid', object: parsed.object },
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside
      className={`${styles.panel} editor-tool-sheet`}
      aria-label={`${title} settings`}
      onCompositionStart={() => {
        composition.current = true;
      }}
      onCompositionEnd={() => {
        composition.current = false;
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.defaultPrevented) return;
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          composition.current
        ) {
          if (event.key === 'Enter') event.preventDefault();
          return;
        }
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          if (event.target instanceof HTMLInputElement) {
            setDistance(focusDistance.current);
            setError('');
            return;
          }
          onClose();
        }
      }}
    >
      <header className={styles.header}>
        <h2>{mode === 'boolean' ? 'Operation' : mode === 'fillet' ? 'Radius' : 'Distance'}</h2>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!composition.current) void apply();
        }}
      >
        <div className={styles.parameters}>
          <div className={styles.fields}>
            {mode === 'boolean' ? (
              <>
                <label>
                  <span>Operation</span>
                  <Select
                    label="Boolean operation"
                    value={operation}
                    options={[
                      { value: 'union', label: 'Union' },
                      { value: 'difference', label: 'Difference' },
                      { value: 'intersection', label: 'Intersection' },
                    ]}
                    disabled={disabled || busy || stale}
                    onChange={(value) => {
                      setOperation(value as typeof operation);
                      setError('');
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  <span>{mode === 'fillet' ? 'Radius' : 'Distance'}</span>
                  <QuantityInput
                    unit={'mm'}
                    aria-label={mode === 'fillet' ? 'Fillet radius (mm)' : 'Chamfer distance (mm)'}
                    inputMode="decimal"
                    value={distance}
                    disabled={disabled || busy || stale}
                    onFocus={() => {
                      focusDistance.current = distance;
                    }}
                    onValueChange={(inputValue) => {
                      setDistance(inputValue);
                      setError('');
                    }}
                  />
                </label>
              </>
            )}
          </div>
          {mode === 'boolean' && (
            <section className={styles.operandSelection} aria-label="Boolean operands">
              <dl className={styles.operandList}>
                {(['Target', 'Tool'] as const).map((role, index) => {
                  const id = booleanOperands[index],
                    body = objects.find((body) => body.id === id);
                  return (
                    <div key={role}>
                      <dt>{role}</dt>
                      <dd>
                        <span aria-description={body?.name}>
                          {body?.name ?? (id ? 'Unavailable solid' : 'Not selected')}
                        </span>
                        {id && (
                          <button
                            type="button"
                            aria-label={`Remove Boolean ${role.toLowerCase()}`}
                            title="Remove operand"
                            aria-description={`Remove ${role.toLowerCase()}`}
                            disabled={disabled || busy || stale}
                            onClick={() => {
                              onBooleanOperandsChange(
                                booleanOperands.filter((_, slot) => slot !== index),
                              );
                              setError('');
                            }}
                          >
                            <X size={14} aria-hidden />
                          </button>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {booleanOperands.length < 2 && !booleanSelectionError && (
                <p className={styles.edgeHint}>Select two solids on canvas.</p>
              )}
              <div className={styles.operandActions}>
                {booleanSelectionError && booleanSelectionOwners.length > 0 ? (
                  <button
                    type="button"
                    disabled={disabled || busy || stale || booleanSelectionOwners.length > 2}
                    onClick={() => {
                      onBooleanOperandsChange([...booleanSelectionOwners]);
                      setError('');
                    }}
                  >
                    Use owning solids
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={disabled || busy || stale || !canSwap}
                    onClick={() => {
                      onBooleanOperandsChange([toolId, targetId]);
                      setError('');
                    }}
                  >
                    Swap operands
                  </button>
                )}
              </div>
            </section>
          )}
          {mode !== 'boolean' && (
            <section className={styles.edgeSelection} aria-label="Edge selection">
              <div className={styles.edgeSelectionHeader}>
                <span aria-live="polite">
                  {selectedEdges.length} {selectedEdges.length === 1 ? 'edge' : 'edges'} selected
                </span>
                <button
                  type="button"
                  disabled={disabled || busy || stale || selectedEdges.length === 0}
                  onClick={() => {
                    onSelectedEdgesChange([]);
                    setError('');
                  }}
                >
                  Clear selection
                </button>
              </div>
              {selectedEdges.length === 0 ? (
                <p className={styles.edgeHint}>Select edges on the solid.</p>
              ) : (
                <ul className={styles.edgeList} aria-label="Selected edges">
                  {selectedEdges.map((id, index) => {
                    const label =
                      selectableEdges.find((edge) => edge.id === id)?.label ??
                      `Selected edge ${index + 1}`;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          aria-label={`Remove ${label}`}
                          disabled={disabled || busy || stale}
                          onClick={() => {
                            onSelectedEdgesChange(selectedEdges.filter((edge) => edge !== id));
                            setError('');
                          }}
                        >
                          <span>{label}</span>
                          <X size={14} aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
          {(stale || error || parsed.error) && (
            <p className={styles.error} role="alert">
              {stale
                ? 'The project changed. Start the operation again.'
                : (mode === 'boolean' && booleanSelectionError) || error || parsed.error}
            </p>
          )}
        </div>
        <footer className={styles.footer}>
          <button
            type="submit"
            className="icon-button property-apply-action"
            aria-label="Apply"
            title={busy ? 'Applying…' : 'Apply'}
            aria-busy={busy}
            disabled={disabled || stale || busy || !parsed.object}
          >
            <Check size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.close}
            aria-label="Cancel"
            title="Close"
            disabled={busy}
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </footer>
      </form>
    </aside>
  );
}
