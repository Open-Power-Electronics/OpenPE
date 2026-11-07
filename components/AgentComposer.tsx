'use client';
import { useCallback, useState, type ReactNode } from 'react';
import { ArrowUp, Square, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { ReasoningEffort } from '@/lib/chat-stream';
import { smartPunctuationEdit } from '@/lib/appearance';
import Select from './Select';
import ModelSelect from './ModelSelect';
import {
  agentName,
  defaultReasoningEffort,
  isProviderReasoningEffort,
} from '@/lib/agent-providers';

const effortLabels: Record<ReasoningEffort, string> = {
  none: 'None',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

export type AgentComposerProps = {
  provider: string;
  available: boolean;
  requiresAgent?: boolean;
  agentSupportsEffort?: boolean;
  effort: ReasoningEffort;
  setEffort: (value: ReasoningEffort) => void;
  approvalMode: 'review' | 'auto';
  setApprovalMode: (value: 'review' | 'auto') => void;
  model: string;
  setModel: (value: string) => void;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (effort: ReasoningEffort | undefined) => void;
  onStop?: () => void;
  busy?: boolean;
  autoFocus?: boolean;
  observedModel?: string;
  className?: string;
  inputLabel?: string;
  submitLabel?: string;
  maxLength?: number;
  attachments?: ReactNode;
  hasAttachments?: boolean;
};

export default function AgentComposer({
  provider,
  available,
  requiresAgent = true,
  agentSupportsEffort,
  effort,
  setEffort,
  approvalMode,
  setApprovalMode,
  model,
  setModel,
  input,
  setInput,
  onSubmit,
  onStop,
  busy = false,
  autoFocus = false,
  observedModel = '',
  className = '',
  inputLabel = 'Message your agent',
  submitLabel = 'Send message',
  maxLength,
  attachments,
  hasAttachments = false,
}: AgentComposerProps) {
  const name = agentName(provider);
  const [effortCatalog, setEffortCatalog] = useState<{
    provider: string;
    model: string;
    observedModel: string;
    efforts: ReasoningEffort[] | null;
  } | null>(null);
  const receiveEfforts = useCallback(
    (efforts: ReasoningEffort[] | null) =>
      setEffortCatalog({ provider, model, observedModel, efforts }),
    [provider, model, observedModel],
  );
  const modelEfforts =
    available &&
    effortCatalog?.provider === provider &&
    effortCatalog.model === model &&
    effortCatalog.observedModel === observedModel
      ? effortCatalog.efforts
      : null;
  const supportsEffort =
    modelEfforts === null ? provider === 'codex' || agentSupportsEffort : modelEfforts.length > 0;
  const submissionBlocked =
    requiresAgent &&
    (!available || (['codex', 'claude', 'pi'].includes(provider) && modelEfforts === null));
  const effectiveEffort = modelEfforts?.length
    ? modelEfforts.includes(effort)
      ? effort
      : modelEfforts.includes(defaultReasoningEffort)
        ? defaultReasoningEffort
        : modelEfforts[0]
    : isProviderReasoningEffort(provider, effort)
      ? effort
      : defaultReasoningEffort;
  function submit() {
    if ((!input.trim() && !hasAttachments) || busy || submissionBlocked) return;
    onSubmit(supportsEffort ? effectiveEffort : undefined);
  }
  return (
    <div className={`composer-stack ${className}`}>
      {attachments}
      <div className="composer">
        <textarea
          autoFocus={autoFocus}
          aria-label={inputLabel}
          maxLength={maxLength}
          placeholder={`Work with ${name}`}
          value={input}
          onChange={(e) => {
            const input = e.currentTarget;
            const event = e.nativeEvent as InputEvent;
            if (
              document.documentElement.dataset.smartPunctuation === 'true' &&
              event.inputType === 'insertText' &&
              !event.isComposing
            ) {
              const edit = smartPunctuationEdit(input.value, input.selectionStart);
              setInput(edit.value);
              if (edit.value !== input.value)
                requestAnimationFrame(() => {
                  if (document.activeElement === input)
                    input.setSelectionRange(edit.caret, edit.caret);
                });
            } else setInput(input.value);
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bottom">
          <div className="approval-control">
            <Select
              label="Agent permissions"
              popupClassName="permission-menu"
              value={approvalMode}
              onChange={(value) => setApprovalMode(value as 'review' | 'auto')}
              icon={
                approvalMode === 'auto' ? (
                  <ShieldAlert className="permission-auto" size={18} />
                ) : (
                  <ShieldCheck className="permission-review" size={18} />
                )
              }
              iconOnly
              showChevron={false}
              compact
              options={[
                {
                  value: 'review',
                  label: 'Review commands',
                  description: (
                    <span aria-description="Approve commands before running.">
                      Approve commands before running.
                    </span>
                  ),
                  icon: <ShieldCheck className="permission-review" size={18} />,
                },
                {
                  value: 'auto',
                  label: 'Auto-approve',
                  icon: <ShieldAlert className="permission-auto" size={18} />,
                  description: (
                    <span aria-description="Run supported commands automatically.">
                      Run supported commands automatically.
                    </span>
                  ),
                },
              ]}
            />
          </div>
          <div className="composer-settings">
            <ModelSelect
              key={provider}
              provider={provider}
              available={available}
              value={model}
              observedModel={observedModel}
              onChange={setModel}
              disabled={busy}
              onEfforts={receiveEfforts}
            />
            {supportsEffort ? (
              <Select
                label="Reasoning effort"
                value={effectiveEffort}
                disabled={busy || !available || !modelEfforts?.length}
                compact
                placeholder={effortLabels[effectiveEffort]}
                onChange={(value) => setEffort(value as ReasoningEffort)}
                options={(modelEfforts || []).map((value) => ({
                  value,
                  label: effortLabels[value],
                }))}
              />
            ) : (
              <span
                className="composer-effort-default"
                aria-description={
                  provider === 'claude'
                    ? 'Effort: CLI default. Update Claude Code to choose reasoning effort.'
                    : 'This model uses its default reasoning effort.'
                }
              >
                Default effort
              </span>
            )}
          </div>
          <button
            className={`send-button ${busy ? 'stop' : ''}`}
            aria-label={busy ? 'Stop generation' : submitLabel}
            title={
              busy
                ? 'Stop generation'
                : submissionBlocked
                  ? 'Choose an available model before sending.'
                  : submitLabel
            }
            type="button"
            disabled={!busy && (submissionBlocked || (!input.trim() && !hasAttachments))}
            onClick={() => (busy ? onStop?.() : submit())}
          >
            {busy ? <Square size={14} /> : <ArrowUp size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
