'use client';
import { useRef, useState } from 'react';
import { ArrowRight, Check, ChevronRight, MessageCircleQuestion } from 'lucide-react';
import type { AgentQuestion } from '@/lib/chat-stream';

export default function AgentQuestions({
  questions,
  onAnswer,
  disabled,
}: {
  questions: AgentQuestion[];
  onAnswer: (answers: Record<string, string[]>) => Promise<void>;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, []])),
  );
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, ''])),
  );
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const composing = useRef(false);
  const answers = Object.fromEntries(
    questions.map((q) => [
      q.id,
      custom[q.id]?.trim()
        ? [...(q.multiSelect ? selected[q.id] || [] : []), custom[q.id].trim()]
        : selected[q.id] || [],
    ]),
  );
  const answered = questions.filter((q) => answers[q.id].length > 0).length;
  if (sent)
    return (
      <details
        className="agent-question-receipt"
        aria-label="Answers sent"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        <summary>
          <Check size={15} className="agent-question-check" aria-hidden="true" />
          <span className="agent-question-receipt-label">Answered</span>
          <span className="agent-question-receipt-preview">
            {questions.map((q) => answers[q.id].join(', ').slice(0, 120)).join(' · ')}
          </span>
          <ChevronRight size={14} className="agent-question-receipt-chevron" aria-hidden="true" />
        </summary>
        <dl>
          {questions.map((q) => (
            <div key={q.id}>
              <dt>{q.question}</dt>
              <dd>{answers[q.id].join(', ')}</dd>
            </div>
          ))}
        </dl>
      </details>
    );
  return (
    <form
      className="agent-questions"
      data-state={disabled ? 'closed' : busy ? 'sending' : 'pending'}
      aria-label="Agent questions"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          composing.current ||
          disabled ||
          busy ||
          sent ||
          questions.some((q) => !answers[q.id].length)
        )
          return;
        setBusy(true);
        setError('');
        try {
          await onAnswer(answers);
          setSent(true);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
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
          if (event.key === 'Enter') event.preventDefault();
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
        <fieldset key={q.id} disabled={disabled || busy || sent}>
          <legend>
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
                  checked={(selected[q.id] || []).includes(option.label)}
                  onChange={() => {
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
            <span>{q.options.length ? 'Your own answer' : 'Your answer'}</span>
            <textarea
              rows={1}
              aria-label={`Your answer: ${q.header}`}
              placeholder={q.options.length ? 'Type an alternative…' : 'Type your answer…'}
              value={custom[q.id] || ''}
              maxLength={16000}
              onChange={(event) => {
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
          type="submit"
          className="dialog-button primary"
          disabled={disabled || busy || sent || questions.some((q) => !answers[q.id].length)}
        >
          {busy ? 'Sending…' : disabled ? 'Closed' : 'Continue'}
          {!busy && !disabled && <ArrowRight size={14} aria-hidden="true" />}
        </button>
      </div>
    </form>
  );
}
