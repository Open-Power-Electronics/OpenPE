'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, FolderSearch, Search } from 'lucide-react';
import Dialog from '@/components/Dialog';
import Select from '@/components/Select';
import { api, type SpiceModelCatalog, type SpiceModelDeclaration } from '@/lib/bridge';

const modelSources = [
  {
    value: 'ti',
    label: 'Texas Instruments',
    searchRoute: 'simulation/ti-model-search',
    downloadRoute: 'simulation/ti-model',
  },
];
const sourceLabels = modelSources.map(({ label }) => label);

type TiModel = {
  archive: string;
  title: string;
  encryption: 'encrypted' | 'unencrypted' | 'unknown';
  modelId?: string;
};
type TiSearch = { partNumber: string; models: TiModel[] };

function reviewedArchive(models: TiModel[]) {
  return (
    models.find(({ encryption, modelId }) => encryption === 'unencrypted' && modelId)?.archive ?? ''
  );
}

export default function SpiceModelChooser({
  component,
  initialSearch,
  fileId,
  getRevision,
  modelIssue,
  onClose,
  onBrowse,
  onChoose,
}: {
  component: string;
  initialSearch: string;
  fileId?: string;
  getRevision?: () => number;
  modelIssue: (declaration: SpiceModelDeclaration) => string;
  onClose: () => void;
  onBrowse: () => void;
  onChoose: (
    catalog: SpiceModelCatalog,
    declaration: SpiceModelDeclaration,
    revision?: number,
  ) => void;
}) {
  const [query, setQuery] = useState(initialSearch);
  const [source, setSource] = useState(modelSources[0]);
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState<TiSearch | null>(null);
  const [downloaded, setDownloaded] = useState<{
    libraries: SpiceModelCatalog[];
    revision?: number;
  } | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [busy, setBusy] = useState<'search' | 'download' | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const partNumber = query.trim().toUpperCase();
  const choice = result?.models.find(
    ({ archive, encryption }) => archive === selected && encryption !== 'encrypted',
  );
  const models = useMemo(
    () =>
      downloaded?.libraries.flatMap((catalog) =>
        catalog.models.map((declaration) => ({
          catalog,
          declaration,
          key: `${catalog.path}#${declaration.name}`,
          issue: modelIssue(declaration),
        })),
      ) ?? [],
    [downloaded, modelIssue],
  );
  const compatible = models.filter((model) => !model.issue);
  const model =
    compatible.find(({ key }) => key === selectedModel) ??
    (compatible.length === 1 ? compatible[0] : undefined);
  useEffect(() => () => request.current?.abort(), []);

  function close() {
    if (composing.current) return;
    request.current?.abort();
    onClose();
  }

  function clearResults() {
    setResult(null);
    setSelected('');
    setDownloaded(null);
    setSelectedModel('');
  }

  function changeSource(value: string) {
    const next = modelSources.find((option) => option.value === value);
    if (!next || next === source || request.current || composing.current) return;
    setSource(next);
    clearResults();
    setError('');
  }

  async function run(
    action: 'search' | 'download',
    prepare: (fileId: string, signal: AbortSignal) => Promise<void>,
  ) {
    if (request.current || composing.current) return;
    if (!fileId || !window.openpe) {
      setError('Use the desktop app to search online SPICE models.');
      return;
    }
    const control = new AbortController();
    request.current = control;
    setBusy(action);
    setError('');
    try {
      await prepare(fileId, control.signal);
    } catch (reason) {
      if (!control.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'The TI model request failed.');
    } finally {
      request.current = null;
      if (!control.signal.aborted) setBusy(null);
    }
  }

  function search() {
    if (!partNumber) return;
    void run('search', async (fileId, signal) => {
      clearResults();
      const result: TiSearch = await (
        await api(source.searchRoute, {
          method: 'POST',
          body: JSON.stringify({ fileId, partNumber }),
          signal,
        })
      ).json();
      signal.throwIfAborted();
      if (result?.partNumber !== partNumber || !Array.isArray(result.models))
        throw new Error('Invalid TI model search result.');
      setResult(result);
      setSelected(reviewedArchive(result.models));
    });
  }

  function download() {
    if (!choice || !result) return;
    void run('download', async (fileId, signal) => {
      setDownloaded(null);
      setSelectedModel('');
      const revision = getRevision?.();
      const packet: { libraries: SpiceModelCatalog[] } = await (
        await api(source.downloadRoute, {
          method: 'POST',
          body: JSON.stringify({ fileId, archive: choice.archive }),
          signal,
        }).catch((error: Error & { code?: string }) => {
          if (!signal.aborted && error.code === 'OPENPE_TI_MODEL_ENCRYPTED') {
            const models = result.models.map((model): TiModel =>
              model.archive === choice.archive ? { ...model, encryption: 'encrypted' } : model,
            );
            setResult({ ...result, models });
            setSelected(reviewedArchive(models));
          }
          throw error;
        })
      ).json();
      signal.throwIfAborted();
      if (getRevision?.() !== revision)
        throw new Error('The project changed. Download the TI package again.');
      if (
        !Array.isArray(packet?.libraries) ||
        !packet.libraries.length ||
        packet.libraries.some(
          (library) =>
            typeof library.path !== 'string' ||
            !Array.isArray(library.models) ||
            !Array.isArray(library.issues),
        )
      )
        throw new Error('Invalid TI model inspection.');
      setDownloaded({ libraries: packet.libraries, revision });
    });
  }

  function choose() {
    if (!model || !downloaded || request.current || composing.current) return;
    if (getRevision?.() !== downloaded.revision) {
      setDownloaded(null);
      setError('The project changed. Download the TI package again.');
      return;
    }
    try {
      onChoose(model.catalog, model.declaration, downloaded.revision);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The model could not be applied.');
    }
  }

  return (
    <Dialog
      title="Choose SPICE model"
      icon={<Activity size={20} />}
      onClose={close}
      footer={
        <button
          className="dialog-button primary"
          type="button"
          disabled={busy !== null || (downloaded ? !model : !choice)}
          onClick={downloaded ? choose : download}
        >
          {busy === 'download' ? 'Downloading…' : downloaded ? 'Apply' : 'Download'}
        </button>
      }
    >
      <div
        className="spice-model-browser"
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDownCapture={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          ) {
            if (event.key === 'Enter' || event.key === 'Escape' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
            }
          }
        }}
      >
        <div className="spice-model-browser-local">
          <div>
            <strong>{component}</strong>
          </div>
          <button
            className="dialog-button secondary"
            type="button"
            onClick={() => {
              if (composing.current) return;
              request.current?.abort();
              onBrowse();
            }}
          >
            <FolderSearch size={17} aria-hidden />
            Browse local file
          </button>
        </div>
        <fieldset
          className="spice-model-browser-catalog"
          disabled={busy !== null}
          aria-busy={busy !== null}
        >
          <legend>Online SPICE models</legend>
          <form
            className="spice-model-browser-search-row"
            onSubmit={(event) => {
              event.preventDefault();
              search();
            }}
          >
            <label className="spice-model-browser-search">
              <Search size={17} aria-hidden />
              <input
                data-autofocus
                type="search"
                aria-label="Search SPICE models"
                placeholder="Enter a product number, e.g. LM5001"
                maxLength={40}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  clearResults();
                  setError('');
                }}
              />
            </label>
            <div className="spice-model-browser-search-actions">
              <Select
                compact
                label="Model source"
                value={source.value}
                options={modelSources}
                fitLabels={sourceLabels}
                onBeforeOpen={() => !composing.current}
                onChange={changeSource}
                disabled={busy !== null}
                popupMatchWidth="content"
              />
              <button className="dialog-button secondary" type="submit" disabled={!partNumber}>
                {busy === 'search' ? 'Searching…' : 'Search'}
              </button>
            </div>
          </form>
          <div className="spice-model-browser-results">
            {result?.models.map(({ archive, title, encryption }) => (
              <label
                key={archive}
                className="spice-model-browser-result"
                data-encrypted={encryption === 'encrypted' || undefined}
              >
                <input
                  type="radio"
                  name="ti-spice-model"
                  checked={selected === archive}
                  disabled={encryption === 'encrypted'}
                  onChange={() => {
                    setSelected(archive);
                    setDownloaded(null);
                    setSelectedModel('');
                    setError('');
                  }}
                />
                <strong>{title}</strong>
                <span>{archive}.ZIP</span>
                {encryption === 'encrypted' && <small>Encrypted</small>}
              </label>
            ))}
            {result?.models.length === 0 && (
              <div role="status">No SPICE packages found for {result.partNumber}.</div>
            )}
          </div>
        </fieldset>
        {downloaded && (
          <fieldset className="spice-model-browser-catalog">
            <legend>Models in {choice?.archive}.ZIP</legend>
            <div className="spice-model-browser-results">
              {models.map(({ catalog, declaration, key, issue }) => (
                <label key={key} className="spice-model-browser-result" title={issue || undefined}>
                  <input
                    type="radio"
                    name="ti-spice-declaration"
                    checked={model?.key === key}
                    disabled={!!issue}
                    onChange={() => {
                      setSelectedModel(key);
                      setError('');
                    }}
                  />
                  <strong>{declaration.name}</strong>
                  <span>{catalog.path.split('/').at(-1)}</span>
                </label>
              ))}
              {compatible.length === 0 && (
                <div role="status">No model in this package matches the component.</div>
              )}
            </div>
          </fieldset>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
