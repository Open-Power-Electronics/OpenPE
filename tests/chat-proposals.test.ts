import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Chat from '../components/Chat';
import { emptyCircuit } from '../lib/circuit';

const noop = () => {};
function render(text: string, approvalMode: 'review' | 'auto' = 'review') {
  const props: ComponentProps<typeof Chat> = {
    doc: emptyCircuit(),
    agents: [],
    provider: 'codex',
    effort: 'low',
    setEffort: noop,
    approvalMode,
    setApprovalMode: noop,
    model: '',
    setModel: noop,
    messages: [{ id: 'reply', role: 'assistant', text, outcome: 'completed' }],
    setMessages: noop,
    onSettings: noop,
    onApply: () => assert.fail('Rendering an answer must not apply edits.'),
    active: true,
    sessionId: 'session',
    conversationTitle: 'Conversation',
    input: '',
    setInput: noop,
    onRunningChange: noop,
    annotations: [],
    setAnnotations: noop,
  };
  return renderToStaticMarkup(createElement(Chat, props));
}

test('completed replies with no edits show prose without a proposal error or Apply action', () => {
  const answer = '确认前建议保留 L1，暂不提出修改。';
  for (const mode of ['review', 'auto'] as const)
    for (const text of [answer, answer + '\n\n```openpe\n[]\n```']) {
      const html = render(text, mode);
      assert.ok(html.includes(answer));
      assert.doesNotMatch(html, /proposal-invalid|class="proposal"|Apply to schematic|0 changes/);
      assert.doesNotMatch(html, /```openpe|\[\]/);
    }
});

test('actual proposals remain available and malformed proposals still report an error', () => {
  const valid = render('```openpe\n[{"type":"setValue","ref":"L1","value":"4.7uH"}]\n```');
  assert.match(valid, /Apply to schematic/);
  assert.match(valid, /1 change/);
  for (const payload of ['{}', '[{}]', '[']) {
    const invalid = render('```openpe\n' + payload + '\n```');
    assert.match(invalid, /Invalid proposal format/);
    assert.doesNotMatch(invalid, /Apply to schematic/);
  }
});
