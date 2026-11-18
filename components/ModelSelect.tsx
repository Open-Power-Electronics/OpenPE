'use client';
import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { api } from '@/lib/bridge';
import Select from './Select';
import { AlertCircle } from 'lucide-react';
import type { ReasoningEffort } from '@/lib/chat-stream';
import { isProviderReasoningEffort, validAgentModelId } from '@/lib/agent-providers';
import {
  readCursorUnavailableModels,
  type CursorUnavailableModel,
} from '@/lib/cursor-catalog';

const parameterIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const parameterValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const hiddenCodexModelIds = new Set(['gpt-reserve', 'codex-auto-review']);

export type AgentModelParameter = {
  id: string;
  label: string;
  values: { value: string; label: string }[];
  default: string;
};
type ModelOption = {
  id: string;
  label: string;
  description?: string;
  textInput?: false;
  efforts?: ReasoningEffort[];
  effortParameter?: string;
  parameters?: AgentModelParameter[];
};
type ModelCatalog = {
  models: ModelOption[];
  unavailable: CursorUnavailableModel[];
  defaultModel?: string | null;
};
type CatalogRequest = {
  control: AbortController;
  catalog?: ModelCatalog;
  error?: string;
};

const catalogRequests = new Map<string, CatalogRequest>();
const catalogListeners = new Set<() => void>();

function subscribeToCatalogs(listener: () => void) {
  catalogListeners.add(listener);
  return () => {
    catalogListeners.delete(listener);
  };
}

function notifyCatalogListeners() {
  for (const listener of catalogListeners) listener();
}

function validParameterText(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001F\u007F]/.test(value);
}

function validModelOption(provider: string, item: ModelOption) {
  if (!item || !validAgentModelId(provider, item.id) || typeof item.label !== 'string') return false;
  if (item.textInput !== undefined && (!['codex', 'pi'].includes(provider) || item.textInput !== false))
    return false;
  if (
    item.efforts !== undefined &&
    (!Array.isArray(item.efforts) ||
      item.efforts.some((effort) => !isProviderReasoningEffort(provider, effort)))
  )
    return false;
  if (provider === 'cursor' && !Array.isArray(item.parameters)) return false;
  if (item.parameters === undefined) return item.effortParameter === undefined;
  if (!Array.isArray(item.parameters) || item.parameters.length > 16 || !Array.isArray(item.efforts))
    return false;
  const ids = new Set<string>();
  for (const parameter of item.parameters) {
    if (
      !parameter ||
      !parameterIdPattern.test(parameter.id) ||
      ids.has(parameter.id) ||
      !validParameterText(parameter.label) ||
      !Array.isArray(parameter.values) ||
      parameter.values.length < 1 ||
      parameter.values.length > 32
    )
      return false;
    ids.add(parameter.id);
    const values = new Set<string>();
    for (const entry of parameter.values) {
      if (
        !entry ||
        !parameterValuePattern.test(entry.value) ||
        values.has(entry.value) ||
        !validParameterText(entry.label)
      )
        return false;
      values.add(entry.value);
    }
    if (!values.has(parameter.default)) return false;
  }
  if (item.efforts.length === 0) return item.effortParameter === undefined;
  const effort = item.parameters.find((parameter) => parameter.id === item.effortParameter);
  return (
    effort !== undefined &&
    effort.values.every((entry) => isProviderReasoningEffort(provider, entry.value)) &&
    effort.values.map((entry) => entry.value).join('\u0000') === item.efforts.join('\u0000')
  );
}

export function loadAgentModelCatalog(provider: string) {
  if (catalogRequests.has(provider)) return;
  const control = new AbortController();
  const request: CatalogRequest = { control };
  catalogRequests.set(provider, request);
  notifyCatalogListeners();
  function settle(result: Omit<CatalogRequest, 'control'>) {
    if (control.signal.aborted) return;
    catalogRequests.set(provider, { control, ...result });
    notifyCatalogListeners();
  }
  void api(`models?provider=${encodeURIComponent(provider)}`, {
    signal: control.signal,
    cache: 'no-store',
  })
    .then((response) => response.json())
    .then((result) => {
      if (
        !Array.isArray(result.models) ||
        result.models.some((item: ModelOption) => !validModelOption(provider, item)) ||
        (provider === 'cursor' && result.models.length === 0)
      )
        throw new Error('The agent returned an invalid model catalog.');
      settle({
        catalog: {
          models:
            provider === 'codex'
              ? result.models.filter((model: ModelOption) => !hiddenCodexModelIds.has(model.id))
              : result.models,
          unavailable: provider === 'cursor' ? readCursorUnavailableModels(result.unavailable) : [],
          defaultModel: result.defaultModel,
        },
      });
    })
    .catch((error) => settle({ error: error.message || 'Model discovery failed.' }));
}

export function resetAgentModelCatalogs() {
  for (const request of catalogRequests.values()) request.control.abort();
  catalogRequests.clear();
  notifyCatalogListeners();
}

export function useAgentModelCatalog({
  provider,
  available,
  value,
  observedModel = '',
}: {
  provider: string;
  available: boolean;
  value: string;
  observedModel?: string;
}) {
  const current = useSyncExternalStore(
    subscribeToCatalogs,
    () => (available ? catalogRequests.get(provider) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (available && !current) loadAgentModelCatalog(provider);
  }, [provider, available, current]);
  const loading = available && !current?.catalog && !current?.error;
  const models = current?.catalog?.models ?? [];
  const unavailable = current?.catalog?.unavailable ?? [];
  const currentModel = value || current?.catalog?.defaultModel || observedModel;
  return {
    models,
    unavailable,
    currentModel,
    selected: models.find((model) => model.id === currentModel),
    loading,
    error: current?.error,
  };
}

function unavailableOptions(models: ModelOption[], unavailable: CursorUnavailableModel[]) {
  const used = new Set(models.map((model) => model.id));
  return unavailable.map((model, index) => {
    let value = model.id;
    if (used.has(value)) {
      let suffix = 2;
      while (used.has(`${model.id}#${suffix}`)) suffix += 1;
      value = `${model.id}#${suffix}`;
    }
    used.add(value);
    return {
      value,
      label: model.id,
      description: model.reason,
      disabled: true,
      muted: true,
      separatorBefore: index === 0,
    };
  });
}

export default function ModelSelect({
  models,
  unavailable,
  currentModel,
  loading,
  placeholder,
  error,
  showErrorIcon,
  composing,
  onChange,
  disabled,
}: {
  models: ModelOption[];
  unavailable: CursorUnavailableModel[];
  currentModel: string;
  loading: boolean;
  placeholder: string;
  error?: string;
  showErrorIcon: boolean;
  composing: RefObject<boolean>;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const selected = models.some((model) => model.id === currentModel);
  const popupStatus = loading
    ? 'Loading models…'
    : error
      ? 'Could not load models.'
      : !models.length
        ? 'No models available.'
        : undefined;
  return (
    <div
      className="composer-model-picker"
      onPointerDownCapture={(event) => {
        if (composing.current) event.preventDefault();
      }}
    >
      <Select
        label="Choose model"
        popupStatus={popupStatus}
        popupClassName="model-menu composer-choice-menu"
        popupMaxOptions={5}
        value={selected ? currentModel : ''}
        placeholder={placeholder}
        disabled={disabled}
        compact
        showChevron={false}
        options={[
          ...models.map((model) => ({
            value: model.id,
            label: model.label,
            ...(model.textInput === false && {
              disabled: true,
              description: 'This model does not accept text input.',
            }),
          })),
          ...unavailableOptions(models, unavailable),
        ]}
        onBeforeOpen={() => !composing.current}
        onChange={onChange}
      />
      {showErrorIcon && error && (
        <span
          className="model-list-error"
          role="status"
          aria-label="Model list unavailable"
          aria-description={error}
          title="Models unavailable"
        >
          <AlertCircle size={13} />
        </span>
      )}
    </div>
  );
}
