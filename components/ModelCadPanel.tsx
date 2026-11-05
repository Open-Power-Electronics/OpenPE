'use client';
import QuantityInput from './QuantityInput';
import PropertyDeleteButton from './PropertyDeleteButton';
import { formatFixedQuantity, quantityLabel } from './quantity-units';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { modelCadColor, validateModelCadObject, type ModelCadObject } from '@/lib/model-cad';
import Select from './Select';
import { parseNumericInput as numeric } from './numeric-input';
import styles from './ModelCadPanel.module.css';

type ModelCadPanelMode = 'box' | 'cylinder' | 'move' | 'edit';
type NumericKey = 'length' | 'width' | 'height' | 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz' | 'opacity';
type Draft = {
  name: string;
  values: Record<NumericKey, string>;
  material: ModelCadObject['material'];
  color?: string;
};

function draftFor(object: ModelCadObject | null): Draft {
  return {
    name: object?.name ?? '',
    values: {
      length: String(object?.size.x ?? 20),
      width: String(object?.size.y ?? 20),
      height: String(object?.size.z ?? 10),
      x: String(object?.position.x ?? 0),
      y: String(object?.position.y ?? 0),
      z: String(object?.position.z ?? 0),
      rx: String(object?.rotation.x ?? 0),
      ry: String(object?.rotation.y ?? 0),
      rz: String(object?.rotation.z ?? 0),
      opacity: String((object?.opacity ?? 1) * 100),
    },
    material: object?.material ?? 'aluminium',
    color: object?.color,
  };
}

function objectFor(draft: Draft, base: ModelCadObject) {
  const circular =
    base.kind === 'cylinder' || (base.kind === 'extrusion' && base.profile?.kind === 'circle');
  const fixedProfile =
    base.kind === 'boolean' || (base.kind === 'extrusion' && base.profile?.kind === 'polygon');
  const next = {
    ...base,
    name: draft.name,
    size: {
      x: fixedProfile
        ? base.size.x
        : numeric(draft.values.length, circular ? 'Diameter' : 'Length'),
      y: fixedProfile
        ? base.size.y
        : circular
          ? numeric(draft.values.length, 'Diameter')
          : numeric(draft.values.width, 'Width'),
      z: base.kind === 'boolean' ? base.size.z : numeric(draft.values.height, 'Height'),
    },
    position: {
      x: numeric(draft.values.x, 'X position'),
      y: numeric(draft.values.y, 'Y position'),
      z: numeric(draft.values.z, 'Z position'),
    },
    rotation: {
      x: numeric(draft.values.rx, 'X rotation'),
      y: numeric(draft.values.ry, 'Y rotation'),
      z: numeric(draft.values.rz, 'Z rotation'),
    },
    material: draft.material,
    opacity: numeric(draft.values.opacity, 'Opacity') / 100,
  };
  if (draft.color === undefined) delete next.color;
  else next.color = draft.color;
  return validateModelCadObject(next);
}

export default function ModelCadPanel({
  object,
  mode,
  visible,
  docked = false,
  disabled,
  revision,
  onClose,
  onDraftChange,
  onDirtyChange,
  onApply,
  onRemove,
  rotationRequest,
}: {
  object: ModelCadObject | null;
  mode: ModelCadPanelMode;
  visible: boolean;
  docked?: boolean;
  disabled: boolean;
  revision: string;
  onClose: () => void;
  onToggleSidebar?: () => void;
  onDraftChange: (draft: ModelCadObject | null, positionEdited?: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onApply: (object: ModelCadObject, baseRevision: string) => Promise<void>;
  onRemove?: () => Promise<void>;
  rotationRequest?: { sequence: number; degrees: number } | null;
}) {
  const incomingKey = JSON.stringify(object);
  const [base, setBase] = useState({ object, key: incomingKey, revision, mode });
  const [draft, setDraft] = useState(() => draftFor(object));
  const currentDraft = useRef(draft);
  const composing = useRef(false);
  currentDraft.current = draft;
  const [dirty, setDirty] = useState(false);
  const currentDirty = useRef(dirty);
  currentDirty.current = dirty;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const focusedInput = useRef<{
    input: HTMLInputElement;
    draft: Draft;
    dirty: boolean;
    error: string;
  } | null>(null);
  const draftCallback = useRef(onDraftChange);
  draftCallback.current = onDraftChange;
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const baseOutdated = base.key !== incomingKey || base.revision !== revision;
  const stale = dirty && baseOutdated;
  const changedSelection = base.object?.id !== object?.id || base.mode !== mode;
  const blocked = disabled || busy || !visible;
  const placement = mode === 'box' || mode === 'cylinder' || mode === 'move';
  function updateDirty(next: boolean) {
    // Canvas commands may follow this same input before React commits the next
    // render. Publish their live guard together with the local draft change.
    dirtyCallback.current?.(next);
    currentDirty.current = next;
    setDirty(next);
  }

  useLayoutEffect(() => {
    if (changedSelection || (!dirty && baseOutdated)) {
      focusedInput.current = null;
      setBase({ object, key: incomingKey, revision, mode });
      const next = draftFor(object);
      currentDraft.current = next;
      setDraft(next);
      updateDirty(false);
      setError('');
    }
  }, [incomingKey, revision, mode, changedSelection, dirty, object, baseOutdated, base.mode]);

  const parsed = useMemo(() => {
    if (!base.object) return { object: null, error: '' };
    try {
      return { object: objectFor(draft, base.object), error: '' };
    } catch (cause) {
      return { object: null, error: (cause as Error).message };
    }
  }, [base.object, draft, mode]);
  const validKey = JSON.stringify(parsed.object);
  const lastRotationRequest = useRef(rotationRequest);
  useLayoutEffect(() => {
    if (rotationRequest === lastRotationRequest.current) return;
    const previousDegrees = lastRotationRequest.current?.degrees ?? 0;
    lastRotationRequest.current = rotationRequest;
    if (
      !rotationRequest ||
      !placement ||
      blocked ||
      baseOutdated ||
      changedSelection ||
      !parsed.object
    )
      return;
    // Rotate the same form draft that owns dimensions and pose. Changing
    // only the preview would leave the settings stale or lose the turn on edit.
    const degrees = parsed.object.rotation.z + rotationRequest.degrees - previousDegrees;
    const z = ((((degrees + 180) % 360) + 360) % 360) - 180;
    edit((previous) => ({ ...previous, values: { ...previous.values, rz: String(z) } }));
  }, [rotationRequest, placement, blocked, baseOutdated, changedSelection, parsed.object]);
  useLayoutEffect(() => {
    draftCallback.current(blocked || baseOutdated || changedSelection ? null : parsed.object);
  }, [validKey, blocked, baseOutdated, changedSelection, mode]);
  useLayoutEffect(() => () => draftCallback.current(null), []);

  function edit(update: (previous: Draft) => Draft, positionEdited = false) {
    const next = update(currentDraft.current);
    currentDraft.current = next;
    setDraft(next);
    updateDirty(true);
    setError('');
    publishDraft(next, positionEdited);
  }
  function publishDraft(next: Draft, positionEdited = false) {
    // An input and a canvas key can share a browser event batch. Publish that
    // input's validated object now, rather than letting a prior valid draft
    // place after a newer invalid value or lose the latest valid parameters.
    let object: ModelCadObject | null = null;
    if (!blocked && !baseOutdated && !changedSelection && base.object)
      try {
        object = objectFor(next, base.object);
      } catch {}
    draftCallback.current(object, positionEdited);
  }
  function reset() {
    focusedInput.current = null;
    setBase({ object, key: incomingKey, revision, mode });
    const next = draftFor(object);
    currentDraft.current = next;
    setDraft(next);
    updateDirty(false);
    setError('');
  }
  async function apply() {
    if (
      blocked ||
      stale ||
      changedSelection ||
      !parsed.object ||
      !dirty ||
      mode !== 'edit' ||
      composing.current
    )
      return;
    setBusy(true);
    setError('');
    try {
      await onApply(parsed.object, base.revision);
      updateDirty(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      composing.current ||
      blocked ||
      currentDirty.current ||
      baseOutdated ||
      changedSelection ||
      !base.object ||
      mode !== 'edit' ||
      !onRemove
    )
      return;
    setBusy(true);
    setError('');
    try {
      await onRemove();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function numberField(key: NumericKey, label: string, accessibleLabel = label) {
    return (
      <label key={key}>
        <span>{quantityLabel(label)}</span>
        <QuantityInput
          decimalPlaces={2}
          unit={key === 'opacity' ? '%' : key.startsWith('r') ? '°' : 'mm'}
          aria-label={accessibleLabel}
          inputMode="decimal"
          value={draft.values[key]}
          disabled={blocked || stale}
          onValueChange={(inputValue) => {
            const value = inputValue;
            edit(
              (previous) => ({ ...previous, values: { ...previous.values, [key]: value } }),
              key === 'x' || key === 'y',
            );
          }}
        />
      </label>
    );
  }
  const validationError =
    stale || changedSelection
      ? 'The project changed. Reload parameters before applying this draft.'
      : error || (dirty ? parsed.error : '');
  const title = placement
    ? mode === 'move'
      ? 'Move solid'
      : mode === 'box'
        ? 'Box'
        : 'Cylinder'
    : 'Solid properties';
  const toolSheet = !docked && placement;
  const primitiveSheet = toolSheet && (mode === 'box' || mode === 'cylinder');
  const DraftDetails = toolSheet ? 'div' : 'details';
  const panelError = validationError;
  const circular =
    base.object?.kind === 'cylinder' ||
    (base.object?.kind === 'extrusion' && base.object.profile?.kind === 'circle');
  const fixedProfile =
    base.object?.kind === 'boolean' ||
    (base.object?.kind === 'extrusion' && base.object.profile?.kind === 'polygon');
  const color = `#${modelCadColor(draft).toString(16).padStart(6, '0')}`;
  const dimensionFields = (
    <div className={`${styles.fields} ${styles.dimensions}`}>
      {!fixedProfile && numberField('length', circular ? 'Diameter (mm)' : 'Length (mm)')}
      {!fixedProfile && !circular && numberField('width', 'Width (mm)')}
      {base.object?.kind !== 'boolean' && numberField('height', 'Height (mm)')}
    </div>
  );

  return (
    <aside
      className={`${styles.panel} ${docked ? styles.docked : placement ? styles.placement : styles.inspector}${primitiveSheet ? ` ${styles.primitive}` : ''}${toolSheet ? ' editor-tool-sheet' : ''}`}
      data-cad-mode={toolSheet ? mode : undefined}
      hidden={!visible}
      aria-label={`${title} settings`}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLInputElement)
          focusedInput.current = {
            input: event.target,
            draft: currentDraft.current,
            dirty: currentDirty.current,
            error,
          };
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
          return;
        }
        if (event.key !== 'Escape' || event.defaultPrevented || busy) return;
        if (event.target instanceof HTMLInputElement) {
          event.preventDefault();
          const snapshot = focusedInput.current;
          if (!snapshot || snapshot.input !== event.target) return;
          setError(snapshot.error);
          const positionEdited =
            currentDraft.current.values.x !== snapshot.draft.values.x ||
            currentDraft.current.values.y !== snapshot.draft.values.y;
          currentDraft.current = snapshot.draft;
          setDraft(snapshot.draft);
          updateDirty(snapshot.dirty);
          publishDraft(snapshot.draft, positionEdited);
          return;
        }
        onClose();
      }}
    >
      {!docked && !primitiveSheet && (
        <header className={styles.header}>
          <h2 aria-description={toolSheet ? title : undefined}>{toolSheet ? 'Name' : title}</h2>
          <span>{mode === 'edit' && dirty ? 'Unapplied' : ''}</span>
          {!toolSheet && (
            <button
              type="button"
              className="tool-button"
              aria-label="Close solid settings"
              title="Close"
              disabled={busy}
              onClick={onClose}
            >
              <X size={17} />
            </button>
          )}
        </header>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <div className={styles.body}>
          {toolSheet && panelError && (
            <p className={styles.sheetError} role="alert">
              {panelError}
            </p>
          )}
          {primitiveSheet ? (
            <section className={styles.section} aria-label="Solid dimensions">
              {dimensionFields}
            </section>
          ) : (
            <>
              <div className={styles.nameField}>
                <label className={styles.field}>
                  <span>Name</span>
                  <input
                    aria-label="Solid name"
                    value={draft.name}
                    disabled={blocked || stale}
                    onChange={(event) => {
                      const name = event.target.value;
                      edit((previous) => ({ ...previous, name }));
                    }}
                  />
                </label>
                {docked && mode === 'edit' && dirty && (
                  <span
                    className={styles.draftIndicator}
                    role="status"
                    aria-label="Unapplied changes"
                    title="Unapplied changes"
                  />
                )}
                {docked && (
                  <button
                    type="button"
                    className="tool-button"
                    aria-label="Close solid settings"
                    title="Close"
                    disabled={busy}
                    onClick={onClose}
                  >
                    <X size={17} />
                  </button>
                )}
              </div>
              <section className={styles.section} aria-label="Solid appearance">
                <div className={styles.fields}>
                  <div className={styles.field}>
                    <span>Material</span>
                    <Select
                      label="Solid material"
                      value={draft.material}
                      options={[
                        { value: 'aluminium', label: 'Aluminium' },
                        { value: 'pmma', label: 'PMMA' },
                        { value: 'plastic', label: 'Plastic' },
                      ]}
                      disabled={blocked || stale}
                      onChange={(material) =>
                        edit((previous) => ({
                          ...previous,
                          material: material as ModelCadObject['material'],
                        }))
                      }
                    />
                  </div>
                  {numberField('opacity', 'Opacity (%)')}
                  <div className={styles.colorField} role="group" aria-label="Color">
                    <span>Color</span>
                    <div className={styles.colorControls}>
                      <input
                        type="color"
                        aria-label="Solid color"
                        value={color}
                        disabled={blocked || stale}
                        onChange={(event) => {
                          const color = event.target.value;
                          edit((previous) => ({ ...previous, color }));
                        }}
                      />
                      <output className={styles.colorValue} title={color}>
                        {color.toUpperCase()}
                      </output>
                      <button
                        type="button"
                        className="tool-button"
                        aria-label="Use material color"
                        title="Use material color"
                        disabled={blocked || stale || draft.color === undefined}
                        onClick={() => {
                          if (composing.current) return;
                          edit((previous) => {
                            const next = { ...previous };
                            delete next.color;
                            return next;
                          });
                        }}
                      >
                        <RotateCcw size={14} aria-hidden />
                      </button>
                    </div>
                  </div>
                </div>
              </section>
              <section className={styles.section} aria-label="Solid dimensions">
                {fixedProfile && (
                  <dl className="model-property-list">
                    <dt>Length</dt>
                    <dd>{formatFixedQuantity(base.object!.size.x)} mm</dd>
                    <dt>Width</dt>
                    <dd>{formatFixedQuantity(base.object!.size.y)} mm</dd>
                    {base.object!.kind === 'boolean' && (
                      <>
                        <dt>Height</dt>
                        <dd>{formatFixedQuantity(base.object!.size.z)} mm</dd>
                      </>
                    )}
                  </dl>
                )}
                {dimensionFields}
              </section>
              <DraftDetails className={styles.transforms}>
                {!toolSheet && <summary>Placement</summary>}
                <section className={styles.section} aria-label="Solid position">
                  <h3>Position</h3>
                  <div className={styles.axes}>
                    {(['x', 'y', 'z'] as const).map((axis) =>
                      numberField(
                        axis,
                        axis.toUpperCase(),
                        `Solid ${axis.toUpperCase()} position (mm)`,
                      ),
                    )}
                  </div>
                </section>
                <section className={styles.section} aria-label="Solid rotation">
                  <h3>Rotation</h3>
                  <div className={styles.axes}>
                    {(['rx', 'ry', 'rz'] as const).map((axis) =>
                      numberField(
                        axis,
                        axis.slice(1).toUpperCase(),
                        `Solid ${axis.slice(1).toUpperCase()} rotation (degrees)`,
                      ),
                    )}
                  </div>
                </section>
              </DraftDetails>
            </>
          )}
        </div>
        <footer className={`${styles.footer}${!toolSheet ? ' inspector-footer' : ''}`}>
          {!toolSheet && panelError && (
            <div className={styles.error}>
              <p role="alert">{panelError}</p>
              {(stale || changedSelection) && (
                <button
                  type="button"
                  className="dialog-button secondary"
                  aria-label="Reload solid parameters"
                  disabled={blocked}
                  onClick={reset}
                >
                  Reload
                </button>
              )}
            </div>
          )}
          {placement ? (
            <>
              <p className={styles.instruction}>
                {mode === 'move' ? 'Click the canvas to move' : 'Click the canvas to place'}
              </p>
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
            </>
          ) : (
            <>
              <button
                type="submit"
                className="icon-button property-apply-action"
                aria-label="Apply"
                title="Apply"
                disabled={blocked || stale || changedSelection || !dirty || !parsed.object}
              >
                <Check size={17} aria-hidden="true" />
              </button>
              <PropertyDeleteButton
                disabled={
                  blocked || dirty || baseOutdated || changedSelection || !base.object || !onRemove
                }
                onClick={() => void remove()}
              />
            </>
          )}
        </footer>
      </form>
    </aside>
  );
}
