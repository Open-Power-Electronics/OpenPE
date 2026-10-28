import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  openNewSession,
  renameSession,
  restoreSessions,
  sessionTitle,
  updateSession,
  type SessionState,
} from '../lib/chat-sessions';

test('conversation rename retains messages, draft, identity, flags and active selection', () => {
  const session = { ...createSession('Unsent draft'), pinned: true as const };
  const other = createSession();
  const state = { sessions: [session, other], activeSessionId: other.id };
  const renamed = renameSession(state, session.id, '  Power stage review  ');
  assert.equal(sessionTitle(renamed.sessions[0]), 'Power stage review');
  assert.equal(renamed.sessions[0].id, session.id);
  assert.equal(renamed.sessions[0].draft, session.draft);
  assert.equal(renamed.sessions[0].messages, session.messages);
  assert.equal(renamed.sessions[0].pinned, true);
  assert.equal(renamed.sessions[1], other);
  assert.equal(renamed.activeSessionId, other.id);
  assert.deepEqual(restoreSessions(JSON.parse(JSON.stringify(renamed))), renamed);
  assert.equal(sessionTitle(session), 'New session');
  for (const name of ['', '  ', 'a\nb', 'a'.repeat(121)])
    assert.throws(() => renameSession(state, session.id, name), /Use a name/);
  for (const name of [42, '', ' leading', 'a\nb', 'a'.repeat(121)])
    assert.throws(() => restoreSessions({ ...state, sessions: [{ ...session, name }] } as never));
});

test('opening an unused conversation repeatedly preserves its identity, draft and pin', () => {
  const idle = {
    ...createSession('Keep this unsent draft'),
    pinned: true as const,
    annotations: [],
  };
  const initial = { sessions: [idle], activeSessionId: idle.id };
  let state: SessionState = initial;
  for (let index = 0; index < 20; index++) state = openNewSession(state, createSession());
  assert.equal(state, initial);
  assert.equal(state.sessions[0], idle);
  assert.equal(state.sessions[0].draft, 'Keep this unsent draft');
  assert.deepEqual(restoreSessions(state), initial);
});

test('project-folder navigation reuses its latest visible idle conversation and prefers the active one', () => {
  const used = createSession();
  used.messages.push({ id: 'message', role: 'user', text: 'Started conversation' });
  const first = createSession('Earlier draft');
  const latest = createSession('Latest draft');
  const archived = { ...createSession('Archived draft'), archived: true as const };
  const sessions = [used, first, latest, archived];
  const result = openNewSession({ sessions, activeSessionId: used.id }, createSession());
  assert.equal(result.sessions, sessions);
  assert.equal(result.activeSessionId, latest.id);
  const activeIdle = { sessions, activeSessionId: first.id };
  assert.equal(openNewSession(activeIdle, createSession()), activeIdle);
  const running = openNewSession({ sessions, activeSessionId: latest.id }, createSession(), {
    [latest.id]: true,
  });
  assert.equal(running.activeSessionId, first.id);
  assert.equal(running.sessions, sessions);
});

test('started, archived and running conversations retain their data when a new session is needed', () => {
  const used = createSession();
  used.messages.push({ id: 'message', role: 'assistant', text: 'Provider error' });
  assert.equal(
    sessionTitle(used),
    'New session',
    'The displayed title is not the reuse criterion.',
  );
  const archived = { ...createSession('Archived draft'), archived: true as const };
  const running = createSession('Submission in progress');
  const initial = { sessions: [used, archived, running], activeSessionId: used.id };
  const candidate = createSession();
  const result = openNewSession(initial, candidate, { [running.id]: true });
  assert.equal(result.activeSessionId, candidate.id);
  assert.deepEqual(result.sessions, [...initial.sessions, candidate]);
  assert.equal(result.sessions[0], used);
  assert.equal(result.sessions[1], archived);
  assert.equal(result.sessions[2], running);
  assert.equal(initial.sessions.length, 3);
  assert.equal(openNewSession(result, createSession()), result);
});

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
