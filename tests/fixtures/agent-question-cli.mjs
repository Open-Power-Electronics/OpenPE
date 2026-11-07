// Synthetic harnesses exercise native question round trips; no model is contacted.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const provider = process.argv[2];
if (process.argv.includes('--help')) {
  console.log(
    process.argv.slice(3).join(' ') +
      ' --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp --no-approve --offline --no-session',
  );
  process.exit(0);
}
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const question = {
  id: 'voltage',
  header: 'Voltage',
  question: 'What output voltage?',
  options: [
    { label: '12 V', description: 'Nominal output' },
    { label: '24 V', description: 'Higher output' },
  ],
};
const answer = (value) => {
  assert.deepEqual(value, ['12 V']);
};
const input = createInterface({ input: process.stdin });
let questionTool;
let deepseekAsk;
if (provider === 'pi') {
  const extension = process.argv[process.argv.indexOf('--extension') + 1];
  assert.equal(path.basename(extension), 'pi-questions.mjs');
  const { default: install } = await import(pathToFileURL(extension));
  install({
    registerTool: (tool) => {
      questionTool = tool;
    },
    on: () => {},
  });
}
if (provider === 'deepseek') {
  const { apply } = await import(pathToFileURL(path.join(process.cwd(), 'questions.mjs')));
  apply({
    on: (name, handler) => {
      assert.equal(name, 'user-questions/request');
      deepseekAsk = handler;
    },
    provide: () => {},
  });
  const { apply: guard } = await import(pathToFileURL(path.join(process.cwd(), 'boundary.mjs')));
  guard({
    tools: {
      guard: (handler) => {
        assert.equal(handler({ name: 'ask_user_question' }), undefined);
        assert.equal(typeof handler({ name: 'shell' }), 'string');
      },
    },
    provide: () => {},
  });
}
input.on('line', async (line) => {
  const e = JSON.parse(line);
  try {
    if (provider === 'codex') {
      if (e.method === 'initialize') return send({ id: e.id, result: {} });
      if (e.method === 'thread/start') {
        assert.equal(e.params.config['features.default_mode_request_user_input'], true);
        return send({
          id: e.id,
          result: { thread: { id: 'thread' }, model: 'fixture', reasoningEffort: 'medium' },
        });
      }
      if (e.method === 'turn/start') {
        send({ id: e.id, result: { turn: { id: 'turn' } } });
        return send({
          id: 99,
          method: 'item/tool/requestUserInput',
          params: { threadId: 'thread', turnId: 'turn', itemId: 'q', questions: [question] },
        });
      }
      if (e.id === 99) {
        answer(e.result.answers.voltage.answers);
        send({
          method: 'item/started',
          params: { item: { id: 'progress', type: 'agentMessage', phase: 'commentary' } },
        });
        send({
          method: 'item/agentMessage/delta',
          params: { itemId: 'progress', delta: 'Checking output.' },
        });
        send({
          method: 'item/completed',
          params: {
            item: {
              id: 'final',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'Output is 12 V.',
            },
          },
        });
        send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      }
    } else if (provider === 'claude') {
      assert.equal(process.argv[process.argv.indexOf('--tools') + 1], 'AskUserQuestion');
      if (e.type === 'user') {
        send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'a' } } });
        send({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Checking output.' },
          },
        });
        return send({
          type: 'control_request',
          request_id: 'q',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'AskUserQuestion',
            input: { questions: [{ ...question, multiSelect: false }] },
          },
        });
      }
      if (e.type === 'control_response') {
        assert.equal(e.response.response.behavior, 'allow');
        assert.equal(e.response.response.updatedInput.answers[question.question], '12 V');
        send({
          type: 'assistant',
          message: { id: 'a', content: [{ type: 'text', text: 'Output is 12 V.' }] },
        });
        send({ type: 'result', subtype: 'success', result: 'Output is 12 V.' });
      }
    } else if (provider === 'pi') {
      if (e.type === 'get_state')
        return send({
          id: e.id,
          type: 'response',
          success: true,
          data: { model: { id: 'fixture' } },
        });
      if (e.type === 'prompt') {
        send({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 0,
            delta: 'Checking output.',
          },
        });
        send({ type: 'tool_execution_start', toolName: 'openpe_ask_user', toolCallId: 'q' });
        const result = await questionTool.execute(
          'q',
          { questions: [question] },
          new AbortController().signal,
        );
        answer(JSON.parse(result.content[0].text).answers.voltage);
        send({ type: 'tool_execution_end', toolName: 'openpe_ask_user', toolCallId: 'q' });
        send({ type: 'message_start', message: { role: 'assistant' } });
        send({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Output is 12 V.' }] },
        });
        send({ type: 'agent_settled' });
      }
    } else if (provider === 'deepseek') {
      if (e.method === 'initialize') return send({ id: e.id, result: { protocolVersion: 1 } });
      if (e.method === 'session/new') return send({ id: e.id, result: { sessionId: 'session' } });
      if (e.method === 'session/close') return send({ id: e.id, result: {} });
      if (e.method === 'session/prompt') {
        send({
          method: 'session/update',
          params: {
            sessionId: 'session',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'Checking output.' },
            },
          },
        });
        const result = await deepseekAsk({
          questions: [question],
          signal: new AbortController().signal,
        });
        answer(result.answers[0].selected);
        send({
          method: 'session/update',
          params: {
            sessionId: 'session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Output is 12 V.' },
            },
          },
        });
        send({ id: e.id, result: { stopReason: 'end_turn' } });
      }
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
input.on('close', () => process.exit(0));
