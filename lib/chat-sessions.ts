import type { ChatOutcome, ChatTimings } from './chat-stream';
import { validateAnnotations, type AgentAnnotation } from './agent-annotations';

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
  messages: Message[];
  draft: string;
  annotations?: AgentAnnotation[];
};

export function createSession(draft = ''): ChatSession {
  return { id: crypto.randomUUID(), messages: [], draft };
}

export function sessionTitle(session: ChatSession): string {
  const message = session.messages.find((message) => message.role === 'user');
  const prompt = message?.text || message?.annotations?.[0]?.comment;
  return prompt?.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New session';
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
    validateAnnotations(session.annotations);
    for (const message of session.messages) validateAnnotations(message.annotations);
  }
  if (typeof state.activeSessionId !== 'string' || !ids.has(state.activeSessionId))
    throw new Error('The active conversation is missing from the saved sessions.');
  return {
    sessions,
    activeSessionId: state.activeSessionId,
  };
}
