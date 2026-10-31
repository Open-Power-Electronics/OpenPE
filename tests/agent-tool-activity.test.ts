import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentToolCall from '../components/AgentToolCall';
import {
  appendToolActivity,
  toolPreview,
  toolResultStatus,
  type AgentToolActivity,
} from '../lib/agent-tool-activity';

const activity = (id: string): AgentToolActivity => ({
  id,
  messageId: 'reply',
  tool: 'openpe_query',
  name: 'project.snapshot',
  status: 'completed',
  arguments: toolPreview({ name: 'project.snapshot' }),
});

test('tool previews bound deep, broad and long results without retaining mutable inputs', () => {
  const value = {
    parts: Array.from({ length: 1000 }, (_, id) => ({ id, text: 'x'.repeat(10000) })),
  };
  const preview = toolPreview(value);
  assert.equal(preview.truncated, true);
  assert.ok(preview.text.length <= 6000);
  value.parts[0].text = 'changed';
  assert.doesNotMatch(preview.text, /changed/);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.equal(toolPreview(cyclic).truncated, true);
  const short = { revision: '17', result: [false, 0, null, 'Ω'] };
  assert.deepEqual(toolPreview(short), { text: JSON.stringify(short, null, 2), truncated: false });
});

test('settled activity is bounded while pending reviews and in-flight calls survive pruning', () => {
  const review = { ...activity('review'), status: 'review' as const };
  const running = { ...activity('running'), status: 'running' as const };
  let items: AgentToolActivity[] = [review, running];
  for (let index = 0; index < 300; index++)
    items = appendToolActivity(items, activity(String(index)));
  assert.equal(items.length, 256);
  assert.equal(items[0], review);
  assert.equal(items[1], running);
  assert.equal(items.at(-1)?.id, '299');
  assert.equal(
    items.some((item) => item.id === '0'),
    false,
  );
});

test('pending reviews and cancelled results cannot appear as completed host edits', () => {
  assert.equal(toolResultStatus({ status: 'review-required' }), 'review');
  assert.equal(toolResultStatus({ status: 'cancelled' }), 'cancelled');
  assert.equal(toolResultStatus({ revision: '18' }), 'completed');
  const html = renderToStaticMarkup(
    createElement(AgentToolCall, {
      activity: { ...activity('review'), status: 'review' },
      onApply: () => {},
      onReject: () => {},
    }),
  );
  assert.match(html, /Needs review/);
  assert.match(html, /aria-label="Apply project.snapshot"/);
  assert.match(html, /aria-label="Reject project.snapshot"/);
  assert.doesNotMatch(html, /Completed|Applied/);
});

test('tool result markup is literal and delivery failures preserve the execution outcome', () => {
  const html = renderToStaticMarkup(
    createElement(AgentToolCall, {
      activity: {
        ...activity('result'),
        result: toolPreview('<img src="https://example.com/track">'),
        deliveryError: 'Result delivery failed: disconnected',
      },
    }),
  );
  assert.match(html, /data-tool-status="completed"/);
  assert.match(html, /Result delivery failed: disconnected/);
  assert.doesNotMatch(html, /1.2s|tool-duration/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
