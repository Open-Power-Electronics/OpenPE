'use client';
import QuantityInput from './QuantityInput';
import { quantityLabel } from './quantity-units';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { uid } from '@/lib/circuit';
import { validateModelCadObject, type ModelCadObject } from '@/lib/model-cad';
import Select from './Select';
import { parseNumericInput as numeric } from './numeric-input';
import styles from './ModelCadPanel.module.css';

type ModelCadPanelMode = 'box' | 'cylinder' | 'move' | 'edit' | 'hole';
type NumericKey = 'length' | 'width' | 'height' | 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz' | 'opacity';
type Draft = {
  name: string;
  values: Record<NumericKey, string>;
  material: ModelCadObject['material'];
  holes: { id: string; x: string; y: string; diameterMm: string }[];
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
    holes:
      object?.holes.map((hole) => ({
        id: hole.id,
        x: String(hole.x),
        y: String(hole.y),
        diameterMm: String(hole.diameterMm),
      })) ?? [],
  };
}

function objectFor(draft: Draft, base: ModelCadObject) {
  const circular =
    base.kind === 'cylinder' || (base.kind === 'extrusion' && base.profile?.kind === 'circle');
  const fixedProfile =
    base.kind === 'boolean' || (base.kind === 'extrusion' && base.profile?.kind === 'polygon');
  return validateModelCadObject({
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
    holes: draft.holes.map((hole, index) => ({
      id: hole.id,
      x: numeric(hole.x, `Hole ${index + 1} X`),
      y: numeric(hole.y, `Hole ${index + 1} Y`),
      diameterMm: numeric(hole.diameterMm, `Hole ${index + 1} diameter`),
    })),
  });
}

export default function ModelCadPanel({
  object,
  mode,
  visible,
  docked = false,
  disabled,
  revision,
  holeDiameterMm = 3.2,
  onHoleDiameterChange,
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
  holeDiameterMm?: number | null;
  onHoleDiameterChange?: (diameterMm: number | null) => void;
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
  currentDraft.current = draft;
  const [dirty, setDirty] = useState(false);
  const currentDirty = useRef(dirty);
  currentDirty.current = dirty;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [holeDiameter, setHoleDiameter] = useState(String(holeDiameterMm ?? 3.2));
  const focusedInput = useRef<{
    input: HTMLInputElement;
    draft: Draft;
    dirty: boolean;
    error: string;
    holeDiameter: string;
  } | null>(null);
  const draftCallback = useRef(onDraftChange);
  draftCallback.current = onDraftChange;
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const holeCallback = useRef(onHoleDiameterChange);
  holeCallback.current = onHoleDiameterChange;
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
      if (base.mode !== mode) {
        const diameter = holeDiameterMm ?? 3.2;
        setHoleDiameter(String(diameter));
        if (mode === 'hole') holeCallback.current?.(diameter);
      }
    }
  }, [
    incomingKey,
    revision,
    mode,
    changedSelection,
    dirty,
    holeDiameterMm,
    object,
    baseOutdated,
    base.mode,
  ]);

  const parsed = useMemo(() => {
    if (!base.object || mode === 'hole') return { object: null, error: '' };
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
    // Rotate the same form draft that owns dimensions, holes and pose. Changing
    // only the preview would leave the settings stale or lose the turn on edit.
    const degrees = parsed.object.rotation.z + rotationRequest.degrees - previousDegrees;
    const z = ((((degrees + 180) % 360) + 360) % 360) - 180;
    edit((previous) => ({ ...previous, values: { ...previous.values, rz: String(z) } }));
  }, [rotationRequest, placement, blocked, baseOutdated, changedSelection, parsed.object]);
  useLayoutEffect(() => {
    if (mode !== 'hole')
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
    if (mode !== 'hole') {
      let object: ModelCadObject | null = null;
      if (!blocked && !baseOutdated && !changedSelection && base.object)
        try {
          object = objectFor(next, base.object);
        } catch {}
      draftCallback.current(object, positionEdited);
    }
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
    if (blocked || stale || changedSelection || !parsed.object || !dirty || mode !== 'edit') return;
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
  function addHole() {
    if (!parsed.object) return;
    const diameterMm = 3.2;
    const points = Array.from({ length: 121 }, (_, step) => ({
      x: ((step % 11) - 5) * Math.max(4, parsed.object!.size.x / 12),
      y: (Math.floor(step / 11) - 5) * Math.max(4, parsed.object!.size.y / 12),
    })).sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
    for (const { x, y } of points) {
      const hole = { id: uid(), x, y, diameterMm };
      try {
        validateModelCadObject({ ...parsed.object, holes: [...parsed.object.holes, hole] });
      } catch {
        continue;
      }
      edit((previous) => ({
        ...previous,
        holes: [...previous.holes, { ...hole, x: String(x), y: String(y), diameterMm: '3.2' }],
      }));
      return;
    }
    setError('No free hole position is available. Adjust the current holes or solid dimensions.');
  }
  function numberField(key: NumericKey, label: string, accessibleLabel = label) {
    return (
      <label key={key}>
        <span>{quantityLabel(label)}</span>
        <QuantityInput
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
  const title =
    mode === 'hole'
      ? 'Hole'
      : placement
        ? mode === 'move'
          ? 'Move solid'
          : mode === 'box'
            ? 'Box'
            : 'Cylinder'
        : 'Solid properties';
  const toolSheet = !docked && (placement || mode === 'hole');
  const panelError = mode === 'hole' ? error : validationError;
  const circular =
    base.object?.kind === 'cylinder' ||
    (base.object?.kind === 'extrusion' && base.object.profile?.kind === 'circle');
  const fixedProfile =
    base.object?.kind === 'boolean' ||
    (base.object?.kind === 'extrusion' && base.object.profile?.kind === 'polygon');

  return (
    <aside
      className={`${styles.panel} ${docked ? styles.docked : placement || mode === 'hole' ? styles.placement : styles.inspector}${toolSheet ? ' editor-tool-sheet' : ''}`}
      data-cad-mode={toolSheet ? mode : undefined}
      hidden={!visible}
      aria-label={`${title} settings`}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLInputElement)
          focusedInput.current = {
            input: event.target,
            draft: currentDraft.current,
            dirty: currentDirty.current,
            error,
            holeDiameter,
          };
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          busy
        )
          return;
        if (event.target instanceof HTMLInputElement) {
          event.preventDefault();
          const snapshot = focusedInput.current;
          if (!snapshot || snapshot.input !== event.target) return;
          setError(snapshot.error);
          if (mode === 'hole') {
            setHoleDiameter(snapshot.holeDiameter);
            let diameter: number | null = null;
            try {
              const value = numeric(snapshot.holeDiameter, 'Hole diameter');
              if (value >= 0.5 && value <= 500) diameter = value;
            } catch {}
            holeCallback.current?.(diameter);
          } else {
            const positionEdited =
              currentDraft.current.values.x !== snapshot.draft.values.x ||
              currentDraft.current.values.y !== snapshot.draft.values.y;
            currentDraft.current = snapshot.draft;
            setDraft(snapshot.draft);
            updateDirty(snapshot.dirty);
            publishDraft(snapshot.draft, positionEdited);
          }
          return;
        }
        onClose();
      }}
    >
      {!docked && (
        <header className={styles.header}>
          <h2 aria-description={toolSheet ? title : undefined}>{title}</h2>
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
          {docked && (
            <div className={styles.sectionHeader}>
              <h3>{title}</h3>
              <span>{mode === 'edit' && dirty ? 'Unapplied' : ''}</span>
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
            </div>
          )}
          {mode === 'hole' ? (
            <>
              {object && <div className={styles.target}>{object.name}</div>}
              <label className={styles.field}>
                <span>Diameter</span>
                <QuantityInput
                  unit={'mm'}
                  aria-label="Hole diameter (mm)"
                  inputMode="decimal"
                  value={holeDiameter}
                  disabled={blocked}
                  onValueChange={(inputValue) => {
                    const value = inputValue;
                    setHoleDiameter(value);
                    try {
                      const next = numeric(value, 'Hole diameter');
                      if (next < 0.5 || next > 500)
                        throw new Error('Hole diameter must be between 0.5 and 500 mm.');
                      setError('');
                      onHoleDiameterChange?.(next);
                    } catch (cause) {
                      setError((cause as Error).message);
                      onHoleDiameterChange?.(null);
                    }
                  }}
                />
              </label>
            </>
          ) : !base.object ? (
            <p className={styles.empty}>Select a solid to edit its properties.</p>
          ) : (
            <>
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
              <section className={styles.section} aria-label="Solid dimensions">
                <h3>{base.object.kind === 'boolean' ? 'Bounds' : 'Dimensions'}</h3>
                {fixedProfile && (
                  <dl className="model-property-list">
                    <dt>Length</dt>
                    <dd>{base.object.size.x} mm</dd>
                    <dt>Width</dt>
                    <dd>{base.object.size.y} mm</dd>
                    {base.object.kind === 'boolean' && (
                      <>
                        <dt>Height</dt>
                        <dd>{base.object.size.z} mm</dd>
                      </>
                    )}
                  </dl>
                )}
                <div className={styles.fields}>
                  {!fixedProfile &&
                    numberField('length', circular ? 'Diameter (mm)' : 'Length (mm)')}
                  {!fixedProfile && !circular && numberField('width', 'Width (mm)')}
                  {base.object.kind !== 'boolean' && numberField('height', 'Height (mm)')}
                </div>
              </section>
              <section className={styles.section} aria-label="Solid position">
                <h3>Position (mm)</h3>
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
                <h3>Rotation (°)</h3>
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
                </div>
              </section>
              {base.object.kind !== 'boolean' && (
                <section className={styles.section} aria-label="Solid holes">
                  <div className={styles.sectionHeader}>
                    <h3>Holes</h3>
                    <button
                      type="button"
                      className="tool-button"
                      aria-label="Add hole"
                      title="Add hole"
                      disabled={blocked || stale || !parsed.object || draft.holes.length >= 32}
                      onClick={addHole}
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                  <div className={styles.holes}>
                    {draft.holes.map((hole, index) => (
                      <fieldset key={hole.id} className={styles.hole}>
                        <legend>Hole {index + 1}</legend>
                        <div className={styles.holeHeader}>
                          <span>{toolSheet ? `Hole ${index + 1}` : 'Local coordinates (mm)'}</span>
                          <button
                            type="button"
                            className="tool-button"
                            aria-label={`Remove hole ${index + 1}`}
                            title="Remove hole"
                            disabled={blocked || stale}
                            onClick={() =>
                              edit((previous) => ({
                                ...previous,
                                holes: previous.holes.filter((item) => item.id !== hole.id),
                              }))
                            }
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <div className={styles.axes}>
                          {(['x', 'y', 'diameterMm'] as const).map((key) => (
                            <label key={key}>
                              <span>{key === 'diameterMm' ? 'Diameter' : key.toUpperCase()}</span>
                              <QuantityInput
                                unit={'mm'}
                                aria-label={`Hole ${index + 1} ${key === 'diameterMm' ? 'diameter' : key.toUpperCase()} (mm)`}
                                inputMode="decimal"
                                value={hole[key]}
                                disabled={blocked || stale}
                                onValueChange={(inputValue) => {
                                  const value = inputValue;
                                  edit((previous) => ({
                                    ...previous,
                                    holes: previous.holes.map((item) =>
                                      item.id === hole.id ? { ...item, [key]: value } : item,
                                    ),
                                  }));
                                }}
                              />
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
        <footer className={styles.footer}>
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
          {placement || mode === 'hole' ? (
            <>
              <p className={styles.instruction}>
                {mode === 'hole'
                  ? 'Click a solid to place a hole'
                  : mode === 'move'
                    ? 'Click the canvas to move'
                    : 'Click the canvas to place'}
              </p>
              <button type="button" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="tool-button"
                aria-label="Delete solid"
                title="Delete solid"
                disabled={
                  blocked || dirty || baseOutdated || changedSelection || !base.object || !onRemove
                }
                onClick={remove}
              >
                <Trash2 size={17} />
              </button>
              <span />
              <button
                type="submit"
                className="dialog-button primary"
                disabled={blocked || stale || changedSelection || !dirty || !parsed.object}
              >
                Apply
              </button>
            </>
          )}
        </footer>
      </form>
    </aside>
  );
}
