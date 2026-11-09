import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentTurnSections,
  agentTurnTimeline,
  type ActivityAnchor,
} from '../components/agent-turn-timeline';
import type { AgentToolActivity } from '../lib/agent-tool-activity';
import { responseText } from '../lib/chat-stream';

const tool = (id: string): AgentToolActivity => ({
  id,
  messageId: 'turn',
  tool: 'openpe_query',
  name: id,
  status: 'completed',
  arguments: { text: '{}', truncated: false },
});
const anchor = (kind: ActivityAnchor['kind'], id: string, offset = 0): ActivityAnchor => ({
  messageId: 'turn',
  kind,
  id,
  offset,
});

test('one work disclosure contains intermediate text while the latest answer stays outside', () => {
  const text = 'Before.\n\nBetween.\n\nFinal answer.';
  const parts = agentTurnTimeline(
    text,
    [anchor('tool', 'one', 7), anchor('tool', 'two', 17)],
    [],
    ['one', 'two'].map(tool),
  );
  const { work, answer } = agentTurnSections(parts);
  assert.deepEqual(
    work.map((part) => part.kind),
    ['text', 'tools', 'text', 'tools'],
  );
  assert.equal(answer?.text.trim(), 'Final answer.');
  assert.deepEqual([...work, answer], parts);
});

test('plain replies need no work disclosure and stopped turns do not invent an answer', () => {
  const plain = agentTurnSections(agentTurnTimeline('A plain reply.', [], [], []));
  assert.deepEqual(plain.work, []);
  assert.equal(plain.answer?.text, 'A plain reply.');
  const stopped = agentTurnSections(
    agentTurnTimeline('Inspecting.', [anchor('tool', 'one', 11)], [], [tool('one')]),
  );
  assert.equal(stopped.answer, undefined);
  assert.equal(stopped.work.length, 2);
  assert.deepEqual(agentTurnSections([]), { work: [], answer: undefined, reviews: [] });
});

test('unresolved reviews stay outside work even before later tools and after completion', () => {
  const tools: AgentToolActivity[] = [
    { ...tool('review-one'), status: 'review' },
    tool('query'),
    { ...tool('review-two'), status: 'applying' },
    tool('last-query'),
  ];
  for (const text of ['', 'Apply the pending commands.']) {
    const parts = agentTurnTimeline(
      text,
      tools.map((item) => anchor('tool', item.id)),
      [],
      tools,
    );
    const original = structuredClone(parts);
    const { work, answer, reviews } = agentTurnSections(parts);
    assert.deepEqual(
      reviews.map((item) => item.id),
      ['review-one', 'review-two'],
    );
    assert.deepEqual(
      work.flatMap((part) => (part.kind === 'tools' ? part.entries.map((item) => item.id) : [])),
      ['query', 'last-query'],
    );
    assert.equal(answer?.text, text || undefined);
    assert.deepEqual(parts, original, 'Partitioning cannot mutate retained timeline data.');
  }
});

test('review-only turns need no work disclosure and resolved reviews return to history', () => {
  const review: AgentToolActivity = { ...tool('edit'), status: 'review' };
  const parts = agentTurnTimeline('', [anchor('tool', 'edit')], [], [review]);
  assert.deepEqual(agentTurnSections(parts), { work: [], answer: undefined, reviews: [review] });
  for (const status of ['applied', 'rejected', 'failed', 'cancelled'] as const) {
    const resolved = agentTurnSections(
      agentTurnTimeline('', [anchor('tool', 'edit')], [], [{ ...review, status }]),
    );
    assert.deepEqual(resolved.reviews, []);
    assert.equal(resolved.work[0].kind === 'tools' && resolved.work[0].entries[0].status, status);
  }
});

test('tool batches stay between the progress and response text where they arrived', () => {
  const text = 'Before.\n\nBetween.\n\nFinal answer.';
  const progress = [
    { id: 'a', messageId: 'turn', text: 'Inspecting' },
    { id: 'b', messageId: 'turn', text: 'Checking results' },
  ];
  const anchors = [
    anchor('process', 'a', 7),
    anchor('tool', 'one', 7),
    anchor('tool', 'two', 7),
    anchor('process', 'b', 7),
    anchor('tool', 'three', 17),
  ];
  const parts = agentTurnTimeline(text, anchors, progress, ['one', 'two', 'three'].map(tool));
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['text', 'process', 'tools', 'process', 'text', 'tools', 'text'],
  );
  assert.deepEqual(
    parts.flatMap((part) => (part.kind === 'tools' ? [part.entries.map((entry) => entry.id)] : [])),
    [['one', 'two'], ['three']],
  );
  assert.equal(
    parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join(''),
    text,
  );
  const updated = agentTurnTimeline(
    text,
    anchors,
    [{ ...progress[0], text: 'Inspected' }, progress[1]],
    [tool('one'), { ...tool('two'), status: 'failed' }, tool('three')],
  );
  assert.deepEqual(
    updated.map((part) => part.key),
    parts.map((part) => part.key),
  );
  assert.equal(updated[1].kind === 'process' && updated[1].entry.text, 'Inspected');
});

test('reserved metadata is filtered before segmentation and raw replies remain unchanged', () => {
  const prefix = '```openpe_session\n{"title":"Inspect circuit"}\n```\nBefore.';
  const text = prefix + '\n```openpe\n[{"type":"remove","ref":"R1"}]\n```\nAfter.';
  const parts = agentTurnTimeline(
    text,
    [anchor('tool', 'one', responseText(prefix).length)],
    [],
    [tool('one')],
  );
  const visible = parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');
  assert.equal(visible, responseText(text));
  assert.doesNotMatch(visible, /openpe|remove|Inspect circuit/);
  assert.match(text, /"ref":"R1"/);
});

test('pruned activity and replacement snapshots cannot duplicate or discard reply text', () => {
  const anchors = [
    anchor('tool', 'pruned'),
    anchor('tool', 'one', 100),
    anchor('process', 'missing', 200),
  ];
  const parts = agentTurnTimeline('Corrected answer.', anchors, [], [tool('one')]);
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['text', 'tools'],
  );
  assert.equal(parts[0].kind === 'text' && parts[0].text, 'Corrected answer.');
  assert.equal(agentTurnTimeline('Recovered answer.', [], [], [])[0].kind, 'text');
});
