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
export default function ModelSelect({
  provider,
  available,
  value,
  onChange,
  disabled,
  onEfforts,
  observedModel = '',
}: {
  provider: string;
  available: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  onEfforts: (efforts: ReasoningEffort[] | null) => void;
  observedModel?: string;
}) {
  const [catalog, setCatalog] = useState<{
    provider: string;
    models: ModelOption[];
    defaultModel?: string | null;
  }>({
    provider: '',
    models: [],
  });
  const [error, setError] = useState('');
  const models = available && catalog.provider === provider ? catalog.models : [];
  const currentModel =
    value || (catalog.provider === provider ? catalog.defaultModel : '') || observedModel;
  const selected = models.find((m) => m.id === currentModel);
  useEffect(() => {
    const control = new AbortController();
    setError('');
    setCatalog({ provider: '', models: [] });
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
          setCatalog({ provider, models: result.models, defaultModel: result.defaultModel });
      })
      .catch((e) => {
        if (!control.signal.aborted) setError(e.message);
      });
    return () => control.abort();
  }, [provider, available]);
  useEffect(() => {
    onEfforts(selected?.efforts ?? null);
  }, [selected, onEfforts]);
  return (
    <div className="composer-model-picker">
      <Select
        label="Choose model"
        value={currentModel}
        placeholder={
          available && catalog.provider !== provider && !error ? 'Loading model…' : 'Choose model'
        }
        disabled={disabled || !available || (!models.length && !currentModel)}
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
