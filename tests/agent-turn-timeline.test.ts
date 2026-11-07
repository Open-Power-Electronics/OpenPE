import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentTurnTimeline, type ActivityAnchor } from '../components/agent-turn-timeline';
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
