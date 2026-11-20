'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { agentName } from '@/lib/agent-providers';
import { api, type RawKiCadSelection } from '@/lib/bridge';
import { readChatEvents, type ReasoningEffort } from '@/lib/chat-stream';
import type { AgentPreferences } from '@/lib/workspace-state';
import AgentComposer from './AgentComposer';
import AgentPicker from './AgentPicker';
import type { Agent } from './Chat';
import DesktopTitlebar from './DesktopTitlebar';
import WorkspaceModeSelect from './WorkspaceModeSelect';
import styles from './RawKiCadChat.module.css';

type Turn = { id: number; prompt: string; reply: string; completed: boolean };

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
  const [busy, setBusy] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [error, setError] = useState('');
  const control = useRef<AbortController | null>(null);
  const nativeActivity = useRef(false);
  const composing = useRef(false);
  const nextTurn = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const agent = agents.find(({ id }) => id === provider);

  useEffect(() => () => control.current?.abort(), []);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [turns]);

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
    setError('');
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
          onScroll={(event) => {
            const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
            following.current = scrollHeight - scrollTop - clientHeight < 24;
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
              </div>
            ))}
            {busy && <p role="status">{agentName(provider)} is responding…</p>}
          </div>
        </div>
        <div className={styles.composer}>
          {(error || agentError) && (
            <p className="dialog-error" role="alert">
              {error || agentError}
            </p>
          )}
          <AgentComposer
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
