'use client';
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Box, FolderOpen, FolderSearch, Library, Trash2 } from 'lucide-react';
import type { Footprint, FootprintModel } from '@/lib/pcb';
import { api } from '@/lib/bridge';
import { previewAssignedModel } from '@/lib/pcb-preview-cache';
import { prepareFootprintModelSelection } from '@/lib/model-resource-preparation';
import { footprintSearchTerm, onlineFootprintLibrary } from '@/lib/library';
import type { CapabilityHost } from '@/api/capabilities';
import { TextField, NumberField, PropertyGrid, PropertyToggle } from './LayoutPropertyFields';
import Dialog from './Dialog';
import DeferredDialog from './DeferredDialog';
import WorkspaceLoading from './WorkspaceLoading';
import type { FootprintDetail } from './LibraryChooser';
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
  const importRequest = useRef<AbortController | null>(null);
  const closeChooser = useCallback(() => {
    request.current++;
    importRequest.current?.abort();
    setChoosing(null);
  }, []);
  const close = () => {
    closeChooser();
    setOpened(false);
  };
  const latest = useRef({ footprint, active, fileId, projectSource });
  latest.current = { footprint, active, fileId, projectSource };
  const desktop = typeof window !== 'undefined' && !!window.openpe;
  useEffect(
    () => () => {
      request.current++;
      importRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    closeChooser();
  }, [footprint, closeChooser]);
  useEffect(() => {
    if (!active) {
      closeChooser();
      setOpened(false);
    }
  }, [active, closeChooser]);
  const models = footprint.models ?? [];
  const modelPaths = models.map((model) => model.path).join('; ');
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
    const accepted = onChange(prepareFootprintModelSelection(footprint, index, path));
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
      if (!selected || token !== request.current || !latest.current.active) return;
      if (
        latest.current.footprint !== basis ||
        latest.current.fileId !== fileId ||
        revision !== getRevision?.()
      ) {
        throw new Error('The project changed. Select the STEP file again.');
      }
      if (!change(index, selected.path)) throw new Error('The model assignment could not be applied.');
    } catch (error) {
      if (token === request.current && latest.current.footprint === basis)
        setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function chooseLibrary(index: number, detail: FootprintDetail, modelIndex: number) {
    const basis = footprint,
      revision = getRevision?.();
    if (!active || busy) throw new Error('Model selection is unavailable.');
    const token = ++request.current;
    const control = new AbortController();
    importRequest.current = control;
    setError('');
    try {
      const selected = detail.projectAssets
        ? detail.models[modelIndex]
        : await (
            await api('component-model/library', {
              method: 'POST',
              body: JSON.stringify({ id: detail.id, index: modelIndex }),
              signal: control.signal,
            })
          ).json();
      if (token !== request.current) return;
      if (
        !latest.current.active ||
        latest.current.footprint !== basis ||
        latest.current.fileId !== fileId ||
        revision !== getRevision?.()
      )
        throw new Error('The project changed. Confirm the model again.');
      if (!selected || !change(index, selected.path))
        throw new Error('The model assignment could not be applied.');
      closeChooser();
    } finally {
      if (importRequest.current === control) importRequest.current = null;
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
        <button
          type="button"
          className="property-field-value property-model-manager"
          data-empty={!models.length || undefined}
          aria-label="Manage assigned models"
          aria-haspopup="dialog"
          aria-description={modelPaths || undefined}
          title={modelPaths ? `${modelPaths}\nManage assigned models` : 'Manage assigned models'}
          disabled={!active}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
              event.preventDefault();
          }}
          onClick={() => {
            setError('');
            setOpened(true);
          }}
        >
          {models.length
            ? models.map((model) => model.path.split(/[\\/]/).at(-1)).join('; ')
            : footprint.models === undefined ? 'From footprint library' : 'Unassigned'}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Browse models"
          title="Browse models"
          disabled={!active}
          onClick={() => {
            setError('');
            setChoosing(0);
          }}
        >
          <FolderSearch size={17} />
        </button>
      </div>
      {opened && (
        <Dialog
          wide
          open={choosing === null}
          className="component-model-dialog assignment-dialog"
          title="Component models"
          icon={<Box size={20} />}
          onClose={close}
          footer={
            <button type="button" className="dialog-button primary" onClick={close}>
              Done
            </button>
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
                        onClick={() => {
                          setError('');
                          setChoosing(index);
                        }}
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
                        onCommit={(path) => {
                          try {
                            return change(index, path);
                          } catch (error) {
                            setError((error as Error).message);
                            return false;
                          }
                        }}
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
                    onClick={() => {
                      setError('');
                      setChoosing(models.length);
                    }}
                  >
                    Add library model
                  </button>
                </div>
                {error && <p role="alert">{error}</p>}
              </div>
            </div>
            <section
              className="component-model-preview assignment-detail"
              aria-label="Selected model preview"
            >
              <div className="assignment-preview-stage">
                {selectedModel || footprint.models === undefined ? (
                  <Suspense fallback={<WorkspaceLoading panel label="Loading model preview" />}>
                    {selectedModel ? (
                      <ModelPreview
                        load={loadPreview}
                        model={selectedModel}
                        active={choosing === null}
                      />
                    ) : (
                      <ModelPreview id={footprint.libraryId} active={choosing === null} />
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
      {choosing !== null && active && (
        <DeferredDialog title="Choose component model" onClose={closeChooser}>
          <LibraryChooser
            kind="footprints"
            title="Choose component model"
            label="Choose component model"
            actionLabel="Use model"
            requireModel
            canChoose={!busy}
            capabilityHost={capabilityHost}
            initialSearch={footprintSearchTerm(footprint.libraryId)}
            initialLibrary={onlineFootprintLibrary(footprint.libraryId) ?? ''}
            initialFootprintId={onlineFootprintLibrary(footprint.libraryId) ? footprint.libraryId : undefined}
            initialModelPath={models[choosing]?.path}
            fileId={fileId}
            projectSource={projectSource}
            onClose={closeChooser}
            onChoose={(detail, _unit, modelIndex) => {
              if ('models' in detail) return chooseLibrary(choosing, detail, modelIndex);
            }}
          />
        </DeferredDialog>
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
