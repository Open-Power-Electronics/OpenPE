import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestedSessionTitle, withoutSessionTitle } from '../lib/session-title';
import { responseText } from '../lib/chat-stream';
import {
  applySuggestedSessionTitle,
  createSession,
  restoreSessions,
  sessionTitle,
} from '../lib/chat-sessions';
import { extractProposal } from '../lib/proposals';
import { makePrompt } from '../server/agents.mjs';

const metadata = '```openpe_session\n{"title":"Buck converter ripple review"}\n```';

test('title metadata stays hidden throughout streaming and never becomes an edit proposal', () => {
  for (let end = 1; end <= metadata.length; end++)
    assert.equal(responseText(metadata.slice(0, end)), '');
  assert.equal(suggestedSessionTitle(metadata), 'Buck converter ripple review');
  assert.equal(withoutSessionTitle(metadata + '\nAnswer.'), 'Answer.');
  assert.equal(extractProposal(metadata), null);
  const proposal = '\n```openpe\n[{"type":"setValue","ref":"R1","value":"10k"}]\n```';
  assert.equal(extractProposal(metadata + proposal)?.length, 1);
  assert.equal(responseText(metadata + '\nAnswer.' + proposal), 'Answer.');
});

test('invalid, incomplete, duplicated or oversized title metadata cannot rename a session', () => {
  for (const text of [
    metadata.slice(0, -1),
    metadata + '\n' + metadata,
    '```openpe_session\nnot JSON\n```',
    ...[
      null,
      [],
      { title: '' },
      { title: 123 },
      { title: 'a\nb' },
      { title: 'x'.repeat(61) },
      { title: 'Valid', execute: 'part.remove' },
    ].map((value) => '```openpe_session\n' + JSON.stringify(value) + '\n```'),
  ])
    assert.equal(suggestedSessionTitle(text), undefined);
});

test('suggested titles are origin-bound, successful-only, recoverable and cannot replace manual names', () => {
  const origin = createSession();
  origin.messages.push({
    id: 'reply',
    role: 'assistant',
    text: metadata + '\nAnswer.',
    outcome: 'completed',
  });
  const other = createSession('Keep draft');
  const renamed = applySuggestedSessionTitle(
    [origin, other],
    origin.id,
    'reply',
    'Buck converter ripple review',
  );
  assert.equal(sessionTitle(renamed[0]), 'Buck converter ripple review');
  assert.equal(renamed[1], other);
  assert.equal(renamed[0].messages, origin.messages);
  assert.equal(
    restoreSessions({ sessions: renamed, activeSessionId: origin.id }).sessions[0].name,
    renamed[0].name,
  );
  for (const session of [
    { ...origin, name: 'My name' },
    { ...origin, messages: [{ ...origin.messages[0], outcome: 'cancelled' as const }] },
    { ...origin, messages: [] },
  ])
    assert.equal(
      applySuggestedSessionTitle([session], origin.id, 'reply', 'Generated title')[0],
      session,
    );
  assert.equal(applySuggestedSessionTitle([origin], other.id, 'reply', 'Wrong session')[0], origin);
});

test('only unnamed conversation requests ask the same restricted CLI response for a title', () => {
  const request = { prompt: '检查降压电路纹波', context: {}, history: [] };
  assert.doesNotMatch(makePrompt(request), /fenced openpe_session/);
  const prompt = makePrompt({ ...request, requestTitle: true });
  assert.match(prompt, /fenced openpe_session/);
  assert.match(prompt, /language of the user request/);
  assert.match(prompt, /Do not execute tools or modify files/);
});
