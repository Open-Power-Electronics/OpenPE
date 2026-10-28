import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, restoreSessions, sessionTitle } from '../lib/chat-sessions';

test('sessions preserve identities, messages, drafts and active selection through recovery', () => {
  const first = createSession('draft one');
  const second = createSession('draft two');
  assert.notEqual(first.id, second.id);
  first.messages.push({ id: 'message', role: 'user', text: 'Explain this circuit' });
  const state = { sessions: [first, second], activeSessionId: second.id };
  assert.deepEqual(restoreSessions(JSON.parse(JSON.stringify(state))), state);
  assert.equal(sessionTitle(first), 'Explain this circuit');
  assert.equal(sessionTitle(second), 'New session');
  assert.deepEqual(second.messages, []);
});

test('session recovery rejects retired message-only state and broken active selections', () => {
  const messages = [{ id: 'user', role: 'user' as const, text: 'Legacy prompt' }];
  assert.throws(
    () => restoreSessions({ sessions: undefined, ...{ messages } }),
    /Invalid saved sessions/,
  );
  const session = createSession();
  assert.throws(() => restoreSessions({ sessions: [session, session] }), /Invalid saved sessions/);
  assert.throws(() => restoreSessions({ sessions: [] }), /Invalid saved sessions/);
  assert.throws(() => restoreSessions({ sessions: [session] }), /active conversation/);
  assert.throws(
    () => restoreSessions({ sessions: [session], activeSessionId: 'missing' }),
    /active conversation/,
  );
});
