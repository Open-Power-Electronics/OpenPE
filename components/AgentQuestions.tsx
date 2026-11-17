'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronRight, MessageCircleQuestion } from 'lucide-react';
import type { AgentQuestion } from '@/lib/chat-stream';
import { isCommandModifier } from '@/lib/command-modifier';

export default function AgentQuestions({
  questions,
  onAnswer,
  disabled,
  requestId,
}: {
  questions: AgentQuestion[];
  onAnswer: (answers: Record<string, string[]>) => Promise<void>;
  disabled: boolean;
  requestId?: string;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, []])),
  );
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, ''])),
  );
  const [delivery, setDelivery] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const busy = delivery === 'sending';
  const sent = delivery === 'sent';
  const [error, setError] = useState('');
  const composing = useRef(false);
  const submitted = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const receiptSummary = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    if (busy) {
      const movedFocus = (event: FocusEvent) => {
        if (event.target instanceof Node && !form.current?.contains(event.target))
          restoreFocus.current = false;
      };
      document.addEventListener('focusin', movedFocus);
      return () => document.removeEventListener('focusin', movedFocus);
    }
    restoreFocus.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && !form.current?.contains(active)) return;
    const target = sent ? receiptSummary.current : submitButton.current;
    if (target?.getClientRects().length && !target.matches(':disabled'))
      target.focus({ preventScroll: true });
  }, [busy, sent, error]);
  const answers = Object.fromEntries(
    questions.map((q) => [
      q.id,
      custom[q.id]?.trim()
        ? [...(q.multiSelect ? selected[q.id] || [] : []), custom[q.id].trim()]
        : selected[q.id] || [],
    ]),
  );
  const answered = questions.filter((q) => answers[q.id].length > 0).length;
  const canSubmit = !disabled && !busy && !sent && answered === questions.length;
  if (sent)
    return (
      <details
        className="agent-question-receipt"
        aria-label="Answers sent"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        <summary ref={receiptSummary}>
          <Check size={15} className="agent-question-check" aria-hidden="true" />
          <span className="agent-question-receipt-label">Answered</span>
          <span className="agent-question-receipt-preview">
            {questions.map((q) => answers[q.id].join(', ').slice(0, 120)).join(' · ')}
          </span>
          <ChevronRight size={14} className="agent-question-receipt-chevron" aria-hidden="true" />
        </summary>
        <div
          className="agent-question-answers"
          role="region"
          aria-label="Submitted answers"
          tabIndex={0}
        >
          <dl>
            {questions.map((q) => (
              <div key={q.id}>
                <dt>{q.question}</dt>
                <dd>{answers[q.id].join(', ')}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    );
  return (
    <form
      ref={form}
      className="agent-questions"
      data-question-request={requestId}
      data-state={disabled ? 'closed' : busy ? 'sending' : 'pending'}
      aria-label="Agent questions"
      onSubmit={async (event) => {
        event.preventDefault();
        if (composing.current || submitted.current || !canSubmit) return;
        submitted.current = true;
        restoreFocus.current = !!form.current?.contains(document.activeElement);
        setDelivery('sending');
        setError('');
        try {
          await onAnswer(answers);
          setDelivery('sent');
        } catch (e) {
          submitted.current = false;
          setError((e as Error).message);
          setDelivery('failed');
        }
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) {
          event.stopPropagation();
          if (event.key === 'Enter' || event.target === submitButton.current)
            event.preventDefault();
          return;
        }
        if (
          event.key === 'Enter' &&
          isCommandModifier(event) &&
          !event.altKey &&
          !event.shiftKey &&
          !disabled
        ) {
          event.preventDefault();
          event.stopPropagation();
          const submit = submitButton.current;
          if (!event.repeat && canSubmit && submit && event.currentTarget.getClientRects().length)
            event.currentTarget.requestSubmit(submit);
        }
      }}
    >
      <div className="agent-questions-header">
        <MessageCircleQuestion size={16} aria-hidden="true" />
        <span>{disabled ? 'Question closed' : 'Your input'}</span>
        <span className="agent-questions-count">
          {questions.length === 1 ? '1 question' : `${questions.length} questions`}
        </span>
      </div>
      {questions.map((q, index) => (
        <fieldset
          key={q.id}
          disabled={!disabled && (busy || sent)}
          data-awaiting-answer={!answers[q.id].length || undefined}
        >
          <legend tabIndex={!disabled && !busy ? -1 : undefined}>
            {questions.length > 1 && <span className="agent-question-number">{index + 1}</span>}
            {q.header}
          </legend>
          <p className="agent-question-prompt">{q.question}</p>
          {q.detail && <p className="agent-question-detail">{q.detail}</p>}
          {!!q.options.length && (
            <p className="agent-question-hint">
              {q.multiSelect ? 'Select all that apply' : 'Choose one'}
            </p>
          )}
          <div className="agent-question-options">
            {q.options.map((option) => (
              <label className="agent-question-option" key={option.label}>
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={q.id}
                  disabled={disabled}
                  checked={(selected[q.id] || []).includes(option.label)}
                  onChange={() => {
                    if (disabled || busy || sent) return;
                    setSelected((values) => ({
                      ...values,
                      [q.id]: q.multiSelect
                        ? (values[q.id] || []).includes(option.label)
                          ? values[q.id].filter((v) => v !== option.label)
                          : [...(values[q.id] || []), option.label]
                        : [option.label],
                    }));
                    if (!q.multiSelect) setCustom((values) => ({ ...values, [q.id]: '' }));
                  }}
                />
                <span>
                  <span className="agent-question-option-label">{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
              </label>
            ))}
          </div>
          <label className="agent-question-custom">
            <span>
              {disabled ? 'Retained answer' : q.options.length ? 'Your own answer' : 'Your answer'}
            </span>
            <textarea
              rows={1}
              aria-label={`Your answer: ${q.header}`}
              placeholder={
                disabled
                  ? q.options.length
                    ? 'No custom answer'
                    : 'No answer entered'
                  : q.options.length
                    ? 'Type an alternative…'
                    : 'Type your answer…'
              }
              readOnly={disabled}
              value={custom[q.id] || ''}
              maxLength={16000}
              onChange={(event) => {
                if (disabled || busy || sent) return;
                const value = event.target.value;
                setCustom((values) => ({ ...values, [q.id]: value }));
                if (!q.multiSelect && value.trim())
                  setSelected((values) => ({ ...values, [q.id]: [] }));
              }}
            />
          </label>
        </fieldset>
      ))}
      {error && (
        <p className="message-error" role="alert">
          {error}
        </p>
      )}
      <div className="agent-questions-footer">
        <span className="agent-questions-progress" role="status">
          {disabled
            ? 'This request is no longer active'
            : `${answered} of ${questions.length} answered`}
        </span>
        <button
          ref={submitButton}
          type="submit"
          className="dialog-button primary"
          disabled={!canSubmit}
          aria-keyshortcuts={canSubmit ? 'Control+Enter Meta+Enter' : undefined}
          title={canSubmit ? 'Continue (Ctrl+Enter / ⌘Enter)' : undefined}
          onPointerDown={(event) => {
            if (composing.current) event.preventDefault();
          }}
          onClick={(event) => {
            if (composing.current) event.preventDefault();
          }}
        >
          {busy ? 'Sending…' : disabled ? 'Closed' : 'Continue'}
          {!busy && !disabled && <ArrowRight size={14} aria-hidden="true" />}
        </button>
      </div>
    </form>
  );
}
