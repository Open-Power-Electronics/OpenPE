import type { ChatOutcome, ChatTimings } from './chat-stream';
import { validateAnnotations, type AgentAnnotation } from './agent-annotations';
import { displayName } from './display-name';
import { compactSessionTitle, validSuggestedTitle } from './session-title';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  error?: boolean;
  errorText?: string;
  applied?: boolean;
  basis?: string;
  provider?: string;
  outcome?: ChatOutcome;
  timings?: ChatTimings;
  model?: string;
  annotations?: AgentAnnotation[];
};

export type ChatSession = {
  id: string;
  name?: string;
  messages: Message[];
  draft: string;
  annotations?: AgentAnnotation[];
  pinned?: true;
  archived?: true;
};

export type SessionAction = 'rename' | 'pin' | 'unpin' | 'archive' | 'restore' | 'delete';
export type SessionState = { sessions: ChatSession[]; activeSessionId: string };

export function openNewSession(
  state: SessionState,
  candidate: ChatSession,
  running: Readonly<Record<string, boolean>> = {},
): SessionState {
  const available = (session: ChatSession) =>
    !session.archived && !session.messages.length && running[session.id] !== true;
  const reusable =
    state.sessions.find((session) => session.id === state.activeSessionId && available(session)) ??
    state.sessions.findLast(available);
  if (reusable)
    return reusable.id === state.activeSessionId
      ? state
      : { ...state, activeSessionId: reusable.id };
  return {
    sessions: [...state.sessions, candidate],
    activeSessionId: candidate.id,
  };
}

export function updateSession(
  state: SessionState,
  id: string,
  action: Exclude<SessionAction, 'rename'>,
): SessionState {
  if (!state.sessions.some((session) => session.id === id)) return state;
  const sessions = state.sessions.flatMap((session) => {
    if (session.id !== id) return [session];
    if (action === 'delete') return [];
    const next = { ...session };
    if (action === 'pin') next.pinned = true;
    if (action === 'unpin') delete next.pinned;
    if (action === 'archive') next.archived = true;
    if (action === 'restore') delete next.archived;
    return [next];
  });
  let selected = sessions.find(
    (session) => session.id === state.activeSessionId && !session.archived,
  );
  selected ??= sessions.find((session) => !session.archived);
  if (!selected) {
    selected = createSession();
    sessions.push(selected);
  }
  return { sessions, activeSessionId: selected.id };
}

export function createSession(draft = ''): ChatSession {
  return { id: crypto.randomUUID(), messages: [], draft };
}

export function renameSession(state: SessionState, id: string, value: string): SessionState {
  const name = displayName(value);
  return {
    ...state,
    sessions: state.sessions.map((session) =>
      session.id === id && session.name !== name ? { ...session, name } : session,
    ),
  };
}

export function sessionTitle(session: ChatSession): string {
  if (session.name !== undefined) return session.name;
  const message = session.messages.find((message) => message.role === 'user');
  const prompt = message?.text || message?.annotations?.[0]?.comment;
  return compactSessionTitle(prompt?.trim().replace(/\s+/g, ' ') || 'New session');
}

export function applySuggestedSessionTitle(
  sessions: ChatSession[],
  id: string,
  messageId: string,
  value: string,
): ChatSession[] {
  const title = validSuggestedTitle(value);
  if (!title) return sessions;
  return sessions.map((session) =>
    session.id === id &&
    session.name === undefined &&
    session.messages.some(
      (message) =>
        message.id === messageId && message.role === 'assistant' && message.outcome === 'completed',
    )
      ? { ...session, name: title }
      : session,
  );
}

export function restoreSessions(state: { sessions?: ChatSession[]; activeSessionId?: string }): {
  sessions: ChatSession[];
  activeSessionId: string;
} {
  const sessions = state.sessions;
  const ids = new Set<string>();
  if (!Array.isArray(sessions) || !sessions.length) throw new Error('Invalid saved sessions.');
  for (const session of sessions) {
    if (
      !session ||
      typeof session.id !== 'string' ||
      !session.id ||
      ids.has(session.id) ||
      typeof session.draft !== 'string' ||
      !Array.isArray(session.messages) ||
      (session.pinned !== undefined && session.pinned !== true) ||
      (session.archived !== undefined && session.archived !== true) ||
      session.messages.some(
        (message) =>
          !message ||
          typeof message.id !== 'string' ||
          !['user', 'assistant'].includes(message.role) ||
          typeof message.text !== 'string',
      )
    ) {
      throw new Error('Invalid saved sessions. The recovery file was preserved.');
    }
    ids.add(session.id);
    if (
      session.name !== undefined &&
      (typeof session.name !== 'string' || displayName(session.name) !== session.name)
    )
      throw new Error('Invalid saved conversation name. The recovery file was preserved.');
    validateAnnotations(session.annotations);
    for (const message of session.messages) validateAnnotations(message.annotations);
  }
  if (typeof state.activeSessionId !== 'string' || !ids.has(state.activeSessionId))
    throw new Error('The active conversation is missing from the saved sessions.');
  if (sessions.find((session) => session.id === state.activeSessionId)?.archived)
    throw new Error('The active conversation cannot be archived.');
  return {
    sessions,
    activeSessionId: state.activeSessionId,
  };
}
