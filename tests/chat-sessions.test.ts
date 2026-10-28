import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, restoreSessions, sessionTitle, updateSession } from '../lib/chat-sessions';

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

test('pin, archive, restore and delete preserve other conversations and retain an active visible session', () => {
  const first = createSession('Keep this draft');
  first.messages.push({ id: 'prompt', role: 'user', text: 'First conversation' });
  const second = createSession('Independent draft');
  const initial = { sessions: [first, second], activeSessionId: first.id };
  const pinned = updateSession(initial, first.id, 'pin');
  assert.equal(pinned.sessions[0].pinned, true);
  assert.equal(pinned.sessions[1], second);
  assert.equal(first.pinned, undefined);
  const archived = updateSession(pinned, first.id, 'archive');
  assert.equal(archived.activeSessionId, second.id);
  assert.equal(archived.sessions[0].archived, true);
  assert.equal(archived.sessions[0].messages, first.messages);
  assert.equal(archived.sessions[0].draft, first.draft);
  assert.deepEqual(restoreSessions(JSON.parse(JSON.stringify(archived))), archived);
  const restored = updateSession(archived, first.id, 'restore');
  assert.equal(restored.sessions[0].archived, undefined);
  assert.equal(restored.sessions[0].pinned, true);
  assert.equal(restored.activeSessionId, second.id);
  const unpinned = updateSession(restored, first.id, 'unpin');
  assert.equal('pinned' in unpinned.sessions[0], false);
  const deleted = updateSession(unpinned, first.id, 'delete');
  assert.deepEqual(deleted, { sessions: [second], activeSessionId: second.id });
  assert.equal(updateSession(initial, 'missing', 'delete'), initial);
  for (const action of ['archive', 'delete'] as const) {
    const result = updateSession(
      { sessions: [first], activeSessionId: first.id },
      first.id,
      action,
    );
    const selected = result.sessions.find((session) => session.id === result.activeSessionId)!;
    assert.notEqual(selected.id, first.id);
    assert.equal(selected.archived, undefined);
    assert.equal(selected.draft, '');
    assert.deepEqual(selected.messages, []);
    assert.deepEqual(restoreSessions(result), result);
  }
});

test('recovery rejects malformed conversation flags and archived active conversations', () => {
  const session = createSession();
  for (const field of ['pinned', 'archived']) {
    for (const value of [false, 'true', 1, null]) {
      assert.throws(
        () =>
          restoreSessions({
            sessions: [{ ...session, [field]: value }],
            activeSessionId: session.id,
          }),
        /Invalid saved sessions/,
      );
    }
  }
  assert.throws(
    () =>
      restoreSessions({ sessions: [{ ...session, archived: true }], activeSessionId: session.id }),
    /cannot be archived/,
  );
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
