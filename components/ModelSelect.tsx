'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/bridge';
import Select from './Select';
import { AlertCircle } from 'lucide-react';
import type { ReasoningEffort } from '@/lib/chat-stream';
import { isProviderReasoningEffort } from '@/lib/agent-providers';

const parameterIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const parameterValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

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
  efforts?: ReasoningEffort[];
  effortParameter?: string;
  parameters?: AgentModelParameter[];
};
type ModelCatalog = { models: ModelOption[]; defaultModel?: string | null };

function validParameterText(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001F\u007F]/.test(value);
}

function validModelOption(provider: string, item: ModelOption) {
  if (!item || typeof item.id !== 'string' || typeof item.label !== 'string') return false;
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
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    provider: string;
    attempt: number;
    catalog?: ModelCatalog;
    error?: string;
  } | null>(null);
  useEffect(() => {
    const control = new AbortController();
    setResult(null);
    if (!available) return;
    void api(`models?provider=${encodeURIComponent(provider)}`, { signal: control.signal })
      .then((r) => r.json())
      .then((result) => {
        if (
          !Array.isArray(result.models) ||
          result.models.some((item: ModelOption) => !validModelOption(provider, item))
        )
          throw new Error('The agent returned an invalid model catalog.');
        if (!control.signal.aborted)
          setResult({
            provider,
            attempt,
            catalog: { models: result.models, defaultModel: result.defaultModel },
          });
      })
      .catch((e) => {
        if (!control.signal.aborted)
          setResult({ provider, attempt, error: e.message || 'Model discovery failed.' });
      });
    return () => control.abort();
  }, [provider, available, attempt]);
  const current =
    available && result?.provider === provider && result.attempt === attempt ? result : null;
  const models = current?.catalog?.models ?? [];
  const currentModel = value || current?.catalog?.defaultModel || observedModel;
  return {
    models,
    currentModel,
    selected: models.find((model) => model.id === currentModel),
    loading: available && !current,
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
  };
}

export default function ModelSelect({
  models,
  currentModel,
  loading,
  error,
  onChange,
  disabled,
}: {
  models: ModelOption[];
  currentModel: string;
  loading: boolean;
  error?: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const selected = models.some((model) => model.id === currentModel);
  return (
    <div className="composer-model-picker">
      <Select
        label="Choose model"
        value={currentModel}
        placeholder={loading ? 'Loading model…' : 'Choose model'}
        disabled={disabled || (!models.length && !currentModel)}
        compact
        showChevron={false}
        options={[
          ...models.map((model) => ({
            value: model.id,
            label: model.label,
          })),
          ...(currentModel && !selected
            ? [
                {
                  value: currentModel,
                  label: currentModel,
                },
              ]
            : []),
        ]}
        onChange={onChange}
      />
      {error && (
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
