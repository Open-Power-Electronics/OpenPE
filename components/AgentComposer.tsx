'use client';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { ArrowUp, Maximize2, Minimize2, Square, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { ReasoningEffort } from '@/lib/chat-stream';
import { smartPunctuationEdit } from '@/lib/appearance';
import Select from './Select';
import ModelSelect, { useAgentModelCatalog, type AgentModelParameter } from './ModelSelect';
import useRetiringConversationControl from './useRetiringConversationControl';
import {
  agentName,
  defaultReasoningEffort,
  isProviderReasoningEffort,
} from '@/lib/agent-providers';
import { isCursorBooleanParameter } from '@/lib/cursor-catalog';

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
  agentAvailabilityKnown?: boolean;
  requiresAgent?: boolean;
  agentSupportsEffort?: boolean;
  effort: ReasoningEffort;
  setEffort: (value: ReasoningEffort) => void;
  approvalMode?: 'review' | 'auto';
  setApprovalMode?: (value: 'review' | 'auto') => void;
  model: string;
  setModel: (value: string) => void;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (
    effort: ReasoningEffort | undefined,
    parameters?: { id: string; value: string }[],
    model?: string,
  ) => void;
  onStop?: () => void;
  onAgentSettings?: () => void;
  onRecall?: (direction: -1 | 1) => boolean;
  busy?: boolean;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  expandableDraft?: boolean;
  observedModel?: string;
  className?: string;
  inputLabel?: string;
  submitLabel?: string;
  maxLength?: number;
  attachments?: ReactNode;
  hasAttachments?: boolean;
  followUpMode?: 'queue' | 'steer';
  allowFollowUp?: boolean;
  canSteer?: boolean;
  submitting?: boolean;
  allowSmartPunctuation?: boolean;
};

export default function AgentComposer({
  provider,
  available,
  agentAvailabilityKnown = true,
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
  onAgentSettings,
  onRecall,
  busy = false,
  autoFocus = false,
  inputRef,
  expandableDraft = false,
  observedModel = '',
  className = '',
  inputLabel = 'Message your agent',
  submitLabel = 'Send message',
  maxLength,
  attachments,
  hasAttachments = false,
  followUpMode = 'queue',
  allowFollowUp = false,
  canSteer = false,
  submitting = false,
  allowSmartPunctuation = true,
}: AgentComposerProps) {
  const name = agentName(provider);
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const field = inputRef ?? ownInput;
  const inputId = useId();
  const composing = useRef(false);
  const [draftExpanded, setDraftExpanded] = useState(false);
  const [draftOverflows, setDraftOverflows] = useState(false);
  const focusDraft = useCallback(() => field.current?.focus({ preventScroll: true }), [field]);
  const measureDraft = useCallback(() => {
    const element = field.current;
    if (element?.clientWidth) setDraftOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [field]);
  const retainExpandControl = useRetiringConversationControl(expandableDraft, focusDraft);
  useLayoutEffect(() => {
    const element = field.current;
    if (!expandableDraft || !element) return;
    const observer = new ResizeObserver(measureDraft);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expandableDraft, field, measureDraft]);
  useLayoutEffect(() => {
    if (!input) setDraftExpanded(false);
    if (expandableDraft) measureDraft();
  }, [input, expandableDraft, draftExpanded, measureDraft]);
  const expandLabel = draftExpanded ? 'Collapse draft' : 'Expand draft';
  function guardComposition(event: KeyboardEvent<HTMLButtonElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function stop() {
    if (composing.current) return;
    focusDraft();
    onStop?.();
  }
  const catalog = useAgentModelCatalog({ provider, available, value: model, observedModel });
  const selected = catalog.selected;
  const modelEfforts = selected?.efforts ?? null;
  const effortOptions = (modelEfforts ?? []).map((value) => ({ value, label: effortLabels[value] }));
  const cursorParameters = provider === 'cursor' && selected ? selected.parameters : undefined;
  const supportsEffort =
    modelEfforts === null
      ? !selected && (provider === 'codex' || agentSupportsEffort)
      : modelEfforts.length > 0;
  const [parameterChoices, setParameterChoices] = useState<Record<string, Record<string, string>>>(
    {},
  );
  function chosenParameter(parameter: AgentModelParameter) {
    if (!selected) return undefined;
    const chosen = parameterChoices[selected.id]?.[parameter.id];
    if (chosen === undefined) return parameter.default;
    return parameter.values.some((entry) => entry.value === chosen) ? chosen : undefined;
  }
  const genericParameters = (cursorParameters ?? []).filter(
    (parameter) => parameter.id !== selected?.effortParameter,
  );
  const unresolvedParameter = genericParameters.find((parameter) => !chosenParameter(parameter));
  const usesNativeModel =
    provider === 'deepseek' && !model && !catalog.error && catalog.models.length === 0;
  const submissionBlocked =
    requiresAgent &&
    (!available ||
      catalog.loading ||
      (!selected && !usesNativeModel) ||
      selected?.textInput === false ||
      Boolean(unresolvedParameter));
  const effectiveEffort = modelEfforts?.length
    ? modelEfforts.includes(effort)
      ? effort
      : modelEfforts.includes(defaultReasoningEffort)
        ? defaultReasoningEffort
        : modelEfforts[0]
    : isProviderReasoningEffort(provider, effort)
      ? effort
      : defaultReasoningEffort;
  const effectiveFollowUp =
    followUpMode === 'steer' && canSteer && !hasAttachments ? 'steer' : 'queue';
  const hasDraft = Boolean(input.trim() || hasAttachments);
  const isStop = busy && (!allowFollowUp || !hasDraft);
  const actionLabel = isStop
    ? 'Stop generation'
    : busy
      ? effectiveFollowUp === 'steer'
        ? 'Steer current run'
        : 'Queue message'
      : submitLabel;
  const loadingModels = requiresAgent && catalog.loading && submissionBlocked;
  let placeholderStatus = loadingModels ? 'Loading models…' : '';
  let availabilityText = '';
  let availabilityAction: { label: string; run: () => void } | undefined;
  if (requiresAgent && !catalog.loading) {
    if (!available) {
      if (agentAvailabilityKnown) {
        availabilityText = `${name} is unavailable.`;
        if (onAgentSettings) availabilityAction = { label: 'Agent settings', run: onAgentSettings };
      }
    } else if (unresolvedParameter) {
      availabilityText = `Choose a catalog value for ${unresolvedParameter.label}.`;
    } else if (catalog.error || (!usesNativeModel && !catalog.models.length)) {
      availabilityText = catalog.error ? 'Could not load models.' : 'No models available.';
    } else if (submissionBlocked) {
      placeholderStatus = 'Choose an available model to send.';
    }
  }
  const availabilityId = `${inputId}-availability`;
  const statusText = placeholderStatus || availabilityText;
  const availabilityStatus = statusText && (
    <span
      className={placeholderStatus ? 'composer-placeholder-status' : undefined}
      id={availabilityId}
      role="status"
      aria-description={catalog.error}
    >
      {statusText}
    </span>
  );
  const unavailableText = catalog.unavailable.length
    ? `Unavailable models: ${catalog.unavailable
        .map((model) => `${model.id} — ${model.reason}`)
        .join('; ')}`
    : '';
  function submit() {
    if (
      composing.current ||
      (!input.trim() && !hasAttachments) ||
      (busy && !allowFollowUp) ||
      submissionBlocked ||
      submitting
    )
      return;
    // Focus before dispatch so a synchronous dialog or navigation keeps its own focus.
    focusDraft();
    onSubmit(
      modelEfforts?.length ? effectiveEffort : undefined,
      genericParameters.length
        ? genericParameters.map((parameter) => ({
            id: parameter.id,
            value: chosenParameter(parameter)!,
          }))
        : undefined,
      selected?.id,
    );
  }
  return (
    <div className={`composer-stack ${className}`}>
      {attachments}
      <div className="composer" data-draft-expanded={draftExpanded || undefined}>
        <textarea
          ref={field}
          id={inputId}
          autoFocus={autoFocus}
          aria-label={inputLabel}
          aria-describedby={statusText ? availabilityId : undefined}
          aria-keyshortcuts={onRecall ? 'ArrowUp ArrowDown' : undefined}
          maxLength={maxLength}
          placeholder={placeholderStatus || `Work with ${name}`}
          value={input}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onChange={(e) => {
            const input = e.currentTarget;
            const event = e.nativeEvent as InputEvent;
            if (
              allowSmartPunctuation && document.documentElement.dataset.smartPunctuation === 'true' &&
              event.inputType === 'insertText' &&
              !composing.current &&
              !event.isComposing
            ) {
              const edit = smartPunctuationEdit(input.value, input.selectionStart);
              setInput(edit.value);
              if (edit.value !== input.value)
                requestAnimationFrame(() => {
                  if (
                    !composing.current &&
                    document.activeElement === input &&
                    input.value === edit.value
                  )
                    input.setSelectionRange(edit.caret, edit.caret);
                });
            } else setInput(input.value);
          }}
          onKeyDown={(e) => {
            if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
              e.stopPropagation();
              return;
            }
            const plainKey = !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
            const { selectionStart, selectionEnd, value } = e.currentTarget;
            if (plainKey && onRecall && selectionStart === selectionEnd) {
              const direction =
                e.key === 'ArrowUp' && selectionStart === 0
                  ? -1
                  : e.key === 'ArrowDown' && selectionEnd === value.length
                    ? 1
                    : null;
              if (direction && onRecall(direction)) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
            }
            if (e.key === 'Escape' && busy && onStop && plainKey) {
              e.preventDefault();
              e.stopPropagation();
              stop();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!e.repeat) submit();
            }
          }}
        />
        {placeholderStatus && availabilityStatus}
        {expandableDraft && (draftOverflows || draftExpanded) && (
          <button
            ref={retainExpandControl}
            className="composer-draft-size"
            type="button"
            aria-controls={inputId}
            aria-expanded={draftExpanded}
            onPointerDown={(event) => {
              if (composing.current) event.preventDefault();
            }}
            onKeyDown={guardComposition}
            onClick={() => {
              if (composing.current || !field.current?.clientWidth) return;
              focusDraft();
              setDraftExpanded((expanded) => !expanded);
            }}
          >
            {draftExpanded ? (
              <Minimize2 size={14} aria-hidden="true" />
            ) : (
              <Maximize2 size={14} aria-hidden="true" />
            )}
            {expandLabel}
          </button>
        )}
        <div className="composer-bottom">
          {approvalMode && setApprovalMode && (
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
                    label: 'Review changes',
                    description: (
                      <span aria-description="Confirm file and design changes before applying.">
                        Confirm file and design changes before applying.
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
          )}
          <div
            className="composer-settings"
            data-single-effort={supportsEffort && !cursorParameters ? true : undefined}
          >
            <ModelSelect
              key={provider}
              models={catalog.models}
              unavailable={catalog.unavailable}
              currentModel={catalog.currentModel}
              loading={catalog.loading}
              placeholder={
                catalog.loading && (!loadingModels || Boolean(input))
                  ? 'Loading model…'
                  : 'Choose model'
              }
              error={catalog.error}
              showErrorIcon={!requiresAgent}
              composing={composing}
              onChange={setModel}
              disabled={busy || !available}
            />
            {cursorParameters ? (
              <>
                {cursorParameters.map((parameter) =>
                  parameter.id === selected?.effortParameter ? (
                    <Select
                      key={parameter.id}
                      label="Reasoning effort"
                      value={effectiveEffort}
                      disabled={busy || !available || catalog.loading || !modelEfforts?.length}
                      compact
                      showChevron={false}
                      triggerClassName="composer-effort-trigger"
                      popupClassName="composer-choice-menu composer-effort-menu"
                      popupMatchWidth="content"
                      popupPlacement="top-end"
                      placeholder={effortLabels[effectiveEffort]}
                      onChange={(value) => setEffort(value as ReasoningEffort)}
                      options={effortOptions}
                    />
                  ) : isCursorBooleanParameter(parameter) ? (
                    <span key={parameter.id} className="composer-boolean">
                      <span>{parameter.label}</span>
                      <button
                        type="button"
                        role="switch"
                        className="appearance-toggle"
                        aria-label={parameter.label}
                        aria-checked={chosenParameter(parameter) === 'true'}
                        disabled={
                          busy ||
                          !available ||
                          catalog.loading ||
                          (chosenParameter(parameter) !== 'true' &&
                            chosenParameter(parameter) !== 'false')
                        }
                        onPointerDown={(event) => {
                          if (composing.current) event.preventDefault();
                        }}
                        onKeyDown={guardComposition}
                        onClick={() => {
                          if (composing.current) return;
                          const chosen = chosenParameter(parameter);
                          if (chosen !== 'true' && chosen !== 'false') return;
                          setParameterChoices((choices) => ({
                            ...choices,
                            [selected!.id]: {
                              ...choices[selected!.id],
                              [parameter.id]: chosen === 'true' ? 'false' : 'true',
                            },
                          }));
                        }}
                      >
                        <span />
                      </button>
                    </span>
                  ) : (
                    <Select
                      key={parameter.id}
                      label={parameter.label}
                      value={chosenParameter(parameter) ?? ''}
                      disabled={busy || !available || catalog.loading}
                      compact
                      showChevron={false}
                      fitLabels={parameter.values.map(({ label }) => label)}
                      popupClassName="composer-choice-menu composer-inline-menu"
                      placeholder={parameter.label}
                      onChange={(value) =>
                        setParameterChoices((choices) => ({
                          ...choices,
                          [selected!.id]: { ...choices[selected!.id], [parameter.id]: value },
                        }))
                      }
                      options={parameter.values.map((entry) => ({
                        value: entry.value,
                        label: entry.label,
                      }))}
                    />
                  ),
                )}
                {!supportsEffort && (
                  <span
                    className="composer-effort-default"
                    aria-description="This model does not expose a reasoning effort."
                  >
                    No reasoning effort
                  </span>
                )}
              </>
            ) : supportsEffort ? (
              <Select
                label="Reasoning effort"
                value={effectiveEffort}
                disabled={busy || !available || catalog.loading || !modelEfforts?.length}
                compact
                showChevron={false}
                triggerClassName="composer-effort-trigger"
                popupClassName="composer-choice-menu composer-effort-menu"
                popupMatchWidth="content"
                popupPlacement="top-end"
                placeholder={effortLabels[effectiveEffort]}
                onChange={(value) => setEffort(value as ReasoningEffort)}
                options={effortOptions}
              />
            ) : provider === 'cursor' ? null : (
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
          {busy && allowFollowUp && hasDraft && (
            <button
              className="send-button stop"
              aria-label="Stop generation"
              title="Stop generation"
              type="button"
              onPointerDown={(event) => {
                if (composing.current) event.preventDefault();
              }}
              onKeyDown={guardComposition}
              onClick={stop}
            >
              <Square size={14} />
            </button>
          )}
          <button
            className={`send-button ${isStop ? 'stop' : ''}`}
            aria-label={actionLabel}
            title={actionLabel}
            aria-describedby={statusText && !isStop ? availabilityId : undefined}
            type="button"
            onPointerDown={(event) => {
              if (composing.current) event.preventDefault();
            }}
            onKeyDown={guardComposition}
            disabled={isStop ? false : submissionBlocked || submitting || !hasDraft}
            onClick={() => (isStop ? stop() : submit())}
          >
            {isStop ? <Square size={14} /> : <ArrowUp size={17} />}
          </button>
        </div>
        {(availabilityText || unavailableText) && (
          <div className="composer-availability">
            {availabilityText && availabilityStatus}
            {unavailableText && (
              <span className="composer-unavailable-models" role="note">
                {unavailableText}
              </span>
            )}
            {availabilityAction && (
              <button
                type="button"
                onPointerDown={(event) => {
                  if (composing.current) event.preventDefault();
                }}
                onKeyDown={guardComposition}
                onClick={() => {
                  if (composing.current || !field.current?.clientWidth) return;
                  focusDraft();
                  availabilityAction.run();
                }}
              >
                {availabilityAction.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
