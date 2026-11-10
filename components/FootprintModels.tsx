'use client';
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Box, FolderOpen, FolderSearch, Library, Trash2 } from 'lucide-react';
import type { Footprint, FootprintModel } from '@/lib/pcb';
import { api } from '@/lib/bridge';
import { previewAssignedModel } from '@/lib/pcb-preview-cache';
import { prepareFootprintModelSelection } from '@/lib/model-resource-preparation';
import type { CapabilityHost } from '@/api/capabilities';
import { TextField, NumberField, PropertyGrid, PropertyToggle } from './LayoutPropertyFields';
import Dialog from './Dialog';
import DeferredDialog from './DeferredDialog';
const LibraryChooser = lazy(() => import('./LibraryChooser'));
const ModelPreview = lazy(() => import('./ModelPreview'));
export default function FootprintModels({
  footprint,
  active,
  fileId,
  projectSource,
  getRevision,
  capabilityHost,
  onChange,
}: {
  footprint: Footprint;
  active: boolean;
  fileId?: string;
  projectSource?: string;
  getRevision?: () => number;
  capabilityHost?: CapabilityHost;
  onChange: (models: FootprintModel[]) => boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [choosing, setChoosing] = useState<number | null>(null);
  const request = useRef(0);
  const close = () => {
    request.current++;
    setChoosing(null);
    setOpened(false);
  };
  const latest = useRef({ footprint, active, fileId, projectSource });
  latest.current = { footprint, active, fileId, projectSource };
  const desktop = typeof window !== 'undefined' && !!window.openpe;
  useEffect(
    () => () => {
      latest.current.active = false;
    },
    [],
  );
  useEffect(() => {
    setChoosing(null);
  }, [footprint]);
  useEffect(() => {
    if (!active) {
      request.current++;
      setChoosing(null);
      setOpened(false);
    }
  }, [active]);
  const models = footprint.models ?? [];
  const selectedIndex = Math.min(previewIndex, Math.max(0, models.length - 1));
  const selectedModel = models[selectedIndex];
  const selectedPath = selectedModel?.path;
  const footprintId = footprint.id;
  const loadPreview = useCallback(
    (signal: AbortSignal) => {
      const source = latest.current.projectSource;
      if (!source || !selectedPath)
        return Promise.reject(new Error('The current project is unavailable for preview.'));
      return previewAssignedModel(source, fileId, footprintId, selectedIndex, signal);
    },
    [fileId, footprintId, selectedIndex, selectedPath],
  );
  function change(index: number, path: string) {
    if (!active) return false;
    let next: FootprintModel[];
    try {
      next = prepareFootprintModelSelection(footprint, index, path);
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
    const accepted = onChange(next);
    if (accepted) {
      setError('');
      setPreviewIndex(index);
    }
    return accepted;
  }
  async function chooseFile(index: number) {
    const native = window.openpe;
    if (!active || !native || !fileId || busy) return;
    const token = ++request.current;
    const basis = footprint,
      revision = getRevision?.();
    setBusy(true);
    setError('');
    try {
      const selected = await native.chooseComponentModel(fileId);
      if (
        selected &&
        token === request.current &&
        latest.current.active &&
        latest.current.footprint === basis &&
        latest.current.fileId === fileId &&
        revision === getRevision?.()
      )
        change(index, selected.path);
    } catch (error) {
      if (token === request.current && latest.current.footprint === basis)
        setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function chooseLibrary(index: number, library: string, modelIndex: number) {
    const basis = footprint,
      revision = getRevision?.();
    if (!active || busy) return;
    const token = ++request.current;
    setBusy(true);
    setError('');
    try {
      const response = await api('component-model/library', {
        method: 'POST',
        body: JSON.stringify({ id: library, index: modelIndex }),
      });
      const selected = await response.json();
      if (
        token === request.current &&
        latest.current.active &&
        latest.current.footprint === basis &&
        revision === getRevision?.()
      )
        change(index, selected.path);
    } catch (error) {
      if (token === request.current && latest.current.footprint === basis)
        setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const update = (index: number, changes: Partial<FootprintModel>) =>
    onChange(models.map((m, i) => (i === index ? { ...m, ...changes } : m)));
  return (
    <>
      <div className="property-field property-resource-field">
        <input
          className="property-field-name"
          value="Model"
          readOnly
          disabled={!active}
          aria-label="Model field name"
        />
        <input
          className="property-field-value"
          value={models.map((m) => m.path.split(/[\\/]/).at(-1)).join('; ')}
          placeholder={footprint.models === undefined ? 'From footprint library' : 'Unassigned'}
          aria-label="Model"
          aria-description={models.map((m) => m.path).join('; ')}
          title={models.map((m) => m.path).join('; ')}
          readOnly
          disabled={!active}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Browse models"
          title="Browse models"
          disabled={!active}
          onClick={() => setOpened(true)}
        >
          <FolderSearch size={17} />
        </button>
      </div>
      {opened && (
        <Dialog
          wide
          className="component-model-dialog assignment-dialog"
          title="Component models"
          icon={<Box size={20} />}
          onClose={close}
          footer={
            <div className="library-actions">
              <button type="button" className="dialog-button primary" onClick={close}>
                Done
              </button>
            </div>
          }
        >
          <div className="component-model-browser assignment-browser">
            <div className="component-model-settings">
              <div>
                {models.map((model, index) => (
                  <section
                    key={index}
                    className={`component-model-card${index === selectedIndex ? ' selected' : ''}`}
                    onFocusCapture={() => setPreviewIndex(index)}
                  >
                    <button
                      type="button"
                      className="component-model-select"
                      aria-label={`Preview model ${index + 1}`}
                      aria-pressed={index === selectedIndex}
                      title={model.path}
                      onClick={() => setPreviewIndex(index)}
                    >
                      <Box size={15} />
                      <strong>{model.path.split(/[\\/]/).at(-1)}</strong>
                      {models.length > 1 && <span>{index + 1}</span>}
                    </button>
                    <div className="component-model-actions">
                      <button
                        type="button"
                        className="dialog-button secondary"
                        disabled={!active || busy || !desktop || !fileId}
                        aria-label={`Browse STEP for model ${index + 1}`}
                        onClick={() => void chooseFile(index)}
                      >
                        <FolderOpen size={14} />
                        File
                      </button>
                      <button
                        type="button"
                        className="dialog-button secondary"
                        disabled={!active || busy}
                        aria-label={`Choose library model ${index + 1}`}
                        onClick={() => setChoosing(index)}
                      >
                        <Library size={14} />
                        Library
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={!active || busy}
                        aria-label={`Remove model ${index + 1}`}
                        onClick={() => {
                          if (onChange(models.filter((_, i) => i !== index))) setPreviewIndex(0);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <details className="component-model-path">
                      <summary>File path</summary>
                      <TextField
                        label={`Model ${index + 1} file`}
                        value={model.path}
                        active={active && !busy}
                        resetKey={active}
                        onCommit={(path) => change(index, path)}
                      />
                    </details>
                    <details>
                      <summary>Placement</summary>
                      {(['offset', 'rotation', 'scale'] as const).map((group) => (
                        <PropertyGrid key={group} columns={3}>
                          {(['x', 'y', 'z'] as const).map((axis) => (
                            <NumberField
                              key={axis}
                              active={active && !busy}
                              resetKey={active}
                              label={`${group[0].toUpperCase() + group.slice(1)} ${axis.toUpperCase()}${group === 'offset' ? ' (mm)' : group === 'rotation' ? ' (°)' : ''}`}
                              value={model[group][axis]}
                              min={group === 'scale' ? 0.000001 : -100000}
                              max={group === 'scale' ? 1000 : 100000}
                              onCommit={(value) =>
                                update(index, { [group]: { ...model[group], [axis]: value } })
                              }
                            />
                          ))}
                        </PropertyGrid>
                      ))}
                      <PropertyToggle
                        active={active && !busy}
                        label="Visible model"
                        checked={!model.hidden}
                        onChange={(visible) =>
                          update(index, { hidden: visible ? undefined : true })
                        }
                      />
                      <NumberField
                        active={active && !busy}
                        label="Opacity (%)"
                        value={(model.opacity ?? 1) * 100}
                        min={0}
                        max={100}
                        onCommit={(value) => update(index, { opacity: value / 100 })}
                      />
                    </details>
                  </section>
                ))}
                {!models.length && (
                  <p className="component-model-empty">
                    {footprint.models === undefined
                      ? 'Using models from the footprint library. Add a file to set an explicit model.'
                      : 'No models assigned. Add a STEP file or choose from the library.'}
                  </p>
                )}
                <div className="property-actions">
                  <button
                    type="button"
                    className="dialog-button secondary"
                    disabled={!active || busy || !desktop || !fileId}
                    onClick={() => void chooseFile(models.length)}
                  >
                    Add STEP file
                  </button>
                  <button
                    type="button"
                    className="dialog-button secondary"
                    disabled={!active || busy}
                    onClick={() => setChoosing(models.length)}
                  >
                    Add library model
                  </button>
                </div>
                {error && <p role="alert">{error}</p>}
                {choosing !== null && (
                  <DeferredDialog title="Choose component model" onClose={() => setChoosing(null)}>
                    <LibraryChooser
                      kind="footprints"
                      title="Choose component model"
                      label="Model library footprint"
                      actionLabel="Use model"
                      initialPreview="3d"
                      requireModel
                      capabilityHost={capabilityHost}
                      initialSearch={footprint.libraryId}
                      onClose={() => setChoosing(null)}
                      onChoose={(detail, _unit, modelIndex) => {
                        if (!active || !('models' in detail)) return;
                        const index = choosing;
                        setChoosing(null);
                        if (detail.models.length) void chooseLibrary(index, detail.id, modelIndex);
                      }}
                    />
                  </DeferredDialog>
                )}
              </div>
            </div>
            <section
              className="component-model-preview assignment-detail"
              aria-label="Selected model preview"
            >
              <div className="assignment-preview-stage">
                {selectedModel || footprint.models === undefined ? (
                  <Suspense fallback={<p role="status">Loading preview…</p>}>
                    {selectedModel ? (
                      <ModelPreview load={loadPreview} model={selectedModel} />
                    ) : (
                      <ModelPreview id={footprint.libraryId} />
                    )}
                  </Suspense>
                ) : (
                  <div className="component-model-preview-empty">
                    <Box size={36} strokeWidth={1} />
                    <p>Add a model to preview its geometry.</p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function UnassignedModelField() {
  const hintId = useId();
  return (
    <div className="property-field property-resource-field">
      <input
        className="property-field-name"
        value="Model"
        readOnly
        disabled
        aria-label="Model field name"
      />
      <span className="property-field-value property-resource-hint" id={hintId}>
        Unassigned
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Browse models"
        aria-describedby={hintId}
        disabled
      >
        <FolderSearch size={17} />
      </button>
    </div>
  );
}
