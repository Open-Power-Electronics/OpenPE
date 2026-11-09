'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/bridge';
import Select from './Select';
import { AlertCircle } from 'lucide-react';
import type { ReasoningEffort } from '@/lib/chat-stream';
import { isProviderReasoningEffort } from '@/lib/agent-providers';

type ModelOption = {
  id: string;
  label: string;
  description?: string;
  efforts?: ReasoningEffort[];
};
type ModelCatalog = { models: ModelOption[]; defaultModel?: string | null };

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
          result.models.some(
            (item: ModelOption) =>
              !item ||
              typeof item.id !== 'string' ||
              typeof item.label !== 'string' ||
              (item.efforts !== undefined &&
                (!Array.isArray(item.efforts) ||
                  item.efforts.some((effort) => !isProviderReasoningEffort(provider, effort)))),
          )
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
