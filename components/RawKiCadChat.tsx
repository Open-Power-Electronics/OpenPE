'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { agentName } from '@/lib/agent-providers';
import { api, type RawKiCadSelection } from '@/lib/bridge';
import { readChatEvents, type AgentQuestionRequest, type ReasoningEffort } from '@/lib/chat-stream';
import type { AgentPreferences } from '@/lib/workspace-state';
import AgentAttentionNavigation from './AgentAttentionNavigation';
import AgentComposer from './AgentComposer';
import AgentPicker from './AgentPicker';
import AgentQuestions from './AgentQuestions';
import type { Agent } from './Chat';
import { ChatProgress } from './ChatTiming';
import DesktopTitlebar from './DesktopTitlebar';
import WorkspaceModeSelect from './WorkspaceModeSelect';
import styles from './RawKiCadChat.module.css';

type Turn = { id: number; prompt: string; reply: string; completed: boolean };
type QuestionCard = Pick<AgentQuestionRequest, 'requestId' | 'questions'> & {
  turnId: number;
  state: 'pending' | 'sending' | 'answered' | 'closed';
};

function conversationHistory(turns: Turn[]) {
  const history = turns
    .filter((turn) => turn.completed)
    .slice(-8)
    .flatMap(({ prompt, reply }) => [
      { role: 'user', text: prompt },
      { role: 'assistant', text: reply },
    ]);
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(history)).length > 128 * 1024) history.splice(0, 2);
  return history;
}

export default function RawKiCadChat({
  agents,
  detecting,
  agentError,
  onDetect,
  preferences,
  onExit,
}: {
  agents: Agent[];
  detecting: boolean;
  agentError: string;
  onDetect: () => Promise<void>;
  preferences: AgentPreferences;
  onExit: () => Promise<void>;
}) {
  const [provider, setProvider] = useState(preferences.provider);
  const [models, setModels] = useState(preferences.models);
  const [effort, setEffort] = useState(preferences.effort);
  const [selection, setSelection] = useState<RawKiCadSelection | null>(null);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [questionCards, setQuestionCards] = useState<QuestionCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [error, setError] = useState('');
  const control = useRef<AbortController | null>(null);
  const questionRequests = useRef(new Map<string, AgentQuestionRequest>());
  const nativeActivity = useRef(false);
  const composing = useRef(false);
  const nextTurn = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);
  const agent = agents.find(({ id }) => id === provider);
  const pendingCount = questionCards.reduce(
    (count, card) => count + (card.state === 'pending' ? card.questions.length : 0),
    0,
  );
  const questionState = pendingCount
    ? 'waiting'
    : questionCards.some((card) => card.state === 'sending')
      ? 'sending'
      : undefined;

  useEffect(() => () => control.current?.abort(), []);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [turns, questionCards]);

  async function nativeAction(action: () => Promise<void>) {
    if (nativeActivity.current || composing.current) return;
    nativeActivity.current = true;
    setNativeBusy(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(
        (caught as Error).message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          '',
        ),
      );
    } finally {
      nativeActivity.current = false;
      setNativeBusy(false);
    }
  }

  function resetConversation() {
    following.current = true;
    setTurns([]);
    setQuestionCards([]);
    setError('');
  }

  function updateQuestion(requestId: string, state: QuestionCard['state']) {
    setQuestionCards((cards) =>
      cards.map((card) =>
        card.requestId === requestId && (card.state !== 'closed' || state === 'answered')
          ? { ...card, state }
          : card,
      ),
    );
  }

  async function answerQuestion(requestId: string, answers: Record<string, string[]>) {
    const request = questionRequests.current.get(requestId);
    const signal = control.current?.signal;
    if (!request || !signal || signal.aborted)
      throw new Error('This Agent question is no longer active.');
    updateQuestion(requestId, 'sending');
    try {
      await api('chat/answer', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          runId: request.runId,
          sessionId: request.sessionId,
          requestId,
          token: request.token,
          answers,
        }),
      });
      questionRequests.current.delete(requestId);
      updateQuestion(requestId, 'answered');
    } catch (error) {
      updateQuestion(requestId, 'pending');
      throw error;
    }
  }

  function navigateQuestion() {
    const container = transcript.current;
    if (!container || composing.current) return;
    const card = container.querySelector<HTMLElement>('.agent-questions[data-state="pending"]');
    const target =
      card?.querySelector<HTMLElement>('fieldset[data-awaiting-answer] > legend') ??
      card?.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)');
    if (!card || !target) return;
    following.current = false;
    target.focus({ preventScroll: true });
    const top = container.getBoundingClientRect().top + container.clientTop;
    const height = container.clientHeight;
    const cardBounds = card.getBoundingClientRect();
    const view = cardBounds.height <= height ? cardBounds : target.getBoundingClientRect();
    if (view.top < top) container.scrollTop += view.top - top;
    else if (view.bottom > top + height) container.scrollTop += view.bottom - top - height;
  }

  async function submit(
    resolvedEffort: ReasoningEffort | undefined,
    parameters?: { id: string; value: string }[],
    model?: string,
  ) {
    if (
      !selection ||
      !agent?.available ||
      control.current ||
      nativeActivity.current ||
      composing.current ||
      !draft.trim() ||
      draft.length > 16000
    )
      return;
    const prompt = draft;
    const history = conversationHistory(turns);
    const id = ++nextTurn.current;
    const request = new AbortController();
    control.current = request;
    setBusy(true);
    setError('');
    setDraft('');
    following.current = true;
    let admitted = false;
    let completed = false;
    let reply = '';
    const updateTurn = () => {
      const snapshot = { id, prompt, reply, completed };
      setTurns((previous) => previous.map((turn) => (turn.id === id ? snapshot : turn)));
    };
    try {
      const response = await api('raw-kicad/chat', {
        method: 'POST',
        signal: request.signal,
        body: JSON.stringify({
          selection: selection.id,
          provider,
          prompt,
          history,
          model,
          effort: resolvedEffort,
          parameters,
        }),
      });
      request.signal.throwIfAborted();
      if (!response.body) throw new Error('The Agent returned an empty stream.');
      admitted = true;
      setTurns((previous) => [...previous, { id, prompt, reply: '', completed: false }].slice(-32));
      setQuestionCards((cards) => cards.filter((card) => card.turnId > id - 32));
      await readChatEvents(
        response.body,
        (event) => {
          switch (event.type) {
            case 'text-delta':
              reply += event.delta;
              updateTurn();
              break;
            case 'text-replace':
              reply = event.text;
              updateTurn();
              break;
            case 'question-request':
              if (
                event.sessionId !== selection.id ||
                request.signal.aborted ||
                questionRequests.current.has(event.requestId)
              )
                break;
              questionRequests.current.set(event.requestId, event);
              setQuestionCards((cards) =>
                [
                  ...cards,
                  {
                    turnId: id,
                    requestId: event.requestId,
                    questions: event.questions,
                    state: 'pending' as const,
                  },
                ].slice(-64),
              );
              break;
            case 'question-closed':
              if (
                event.sessionId === selection.id &&
                questionRequests.current.delete(event.requestId)
              )
                updateQuestion(event.requestId, 'closed');
              break;
            case 'error':
              setError(event.text);
              break;
            case 'done':
              completed = event.outcome === 'completed';
              updateTurn();
              break;
          }
        },
        request.signal,
      );
    } catch (caught) {
      if (!request.signal.aborted) setError((caught as Error).message);
    } finally {
      questionRequests.current.clear();
      setQuestionCards((cards) =>
        cards.map((card) =>
          card.turnId === id && card.state !== 'answered' ? { ...card, state: 'closed' } : card,
        ),
      );
      if (!admitted) setDraft((current) => current || prompt);
      control.current = null;
      setBusy(false);
    }
  }

  return (
    <>
      <DesktopTitlebar composing={composing} />
      <main
        className={styles.shell}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={() => {
          composing.current = false;
        }}
        onPointerDownCapture={(event) => {
          if (composing.current && (event.target as Element).closest('button'))
            event.preventDefault();
        }}
        onKeyDownCapture={(event) => {
          if (
            (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) &&
            (event.target as Element).closest('button')
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <header className={styles.header}>
          <h1>Workspace mode</h1>
          <WorkspaceModeSelect
            mode="raw-kicad"
            composing={composing}
            disabled={nativeBusy}
            onChange={() => nativeAction(onExit)}
          />
        </header>
        <div className={styles.controls}>
          <AgentPicker
            provider={provider}
            agents={agents}
            disabled={busy || nativeBusy}
            onChange={(value) => {
              if (
                value === provider ||
                control.current ||
                nativeActivity.current ||
                composing.current
              )
                return;
              setProvider(value);
              resetConversation();
            }}
          />
          <button
            className="dialog-button"
            type="button"
            disabled={detecting}
            onClick={() => {
              if (!composing.current) void onDetect();
            }}
          >
            {detecting ? 'Detecting…' : 'Detect agents'}
          </button>
          <button
            className="dialog-button"
            type="button"
            disabled={busy || nativeBusy}
            onClick={() => {
              if (control.current) return;
              void nativeAction(async () => {
                const selected = await window.openpe!.chooseRawKiCadFiles();
                if (selected) {
                  setSelection(selected);
                  resetConversation();
                }
              });
            }}
          >
            Choose KiCad files
          </button>
          {selection && (
            <ul className={styles.files} aria-label="Selected KiCad files">
              {selection.names.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
        </div>
        <div
          ref={transcript}
          className={styles.transcript}
          onFocusCapture={(event) => {
            if (event.target.closest('.agent-questions, .agent-question-receipt'))
              following.current = false;
          }}
          onScroll={(event) => {
            const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
            following.current =
              !event.currentTarget.querySelector(
                '.agent-questions textarea:focus, .agent-question-answers:focus',
              ) && scrollHeight - scrollTop - clientHeight < 24;
          }}
        >
          <div className={styles.messages}>
            {turns.map(({ id, prompt, reply }) => (
              <div key={id}>
                <div className={styles.message}>
                  <strong>You</strong>
                  <div>{prompt}</div>
                </div>
                {reply && (
                  <div className={styles.message}>
                    <strong>{agentName(provider)}</strong>
                    <div>{reply}</div>
                  </div>
                )}
                {questionCards
                  .filter((card) => card.turnId === id)
                  .map((card) => (
                    <AgentQuestions
                      key={card.requestId}
                      requestId={card.requestId}
                      questions={card.questions}
                      disabled={card.state === 'closed'}
                      onAnswer={(answers) => answerQuestion(card.requestId, answers)}
                    />
                  ))}
              </div>
            ))}
            {busy && (
              <ChatProgress
                status={`${agentName(provider)} is responding…`}
                questionState={questionState}
              />
            )}
          </div>
        </div>
        <div className={styles.composer}>
          <AgentAttentionNavigation
            kind="question"
            count={pendingCount}
            active={busy}
            onNavigate={navigateQuestion}
            onFocusInput={() => composerInput.current?.focus({ preventScroll: true })}
          />
          {(error || agentError) && (
            <p className="dialog-error" role="alert">
              {error || agentError}
            </p>
          )}
          <AgentComposer
            inputRef={composerInput}
            provider={provider}
            available={!!agent?.available}
            agentSupportsEffort={agent?.supportsEffort}
            effort={effort}
            setEffort={setEffort}
            model={models[provider] ?? ''}
            setModel={(value) => setModels((previous) => ({ ...previous, [provider]: value }))}
            input={draft}
            setInput={setDraft}
            onSubmit={submit}
            onStop={() => control.current?.abort()}
            maxLength={16000}
            busy={busy}
            submitting={!selection || nativeBusy}
            allowSmartPunctuation={false}
          />
        </div>
      </main>
    </>
  );
}
