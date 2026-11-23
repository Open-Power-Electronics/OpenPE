import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentQuestions, createAgentQuestionBridge } from '../server/agent-questions.mjs';
import { startServer } from '../server/index.mjs';
import { runAgent, runRawAgent } from '../server/agents.mjs';
import { readChatEvents, type AgentQuestionRequest } from '../lib/chat-stream';
import { updateAgentProcess } from '../lib/agent-process';
import AgentProcess from '../components/AgentProcess';
import AgentTurn from '../components/AgentTurn';
import AgentQuestions from '../components/AgentQuestions';

const raw = [{ id: 'voltage', header: 'Voltage', question: 'Output voltage?', options: [] }];
test('question bridge requires explicit complete answers, binds origin/session/token and revokes on close', async () => {
  const signal = new AbortController();
  const events: AgentQuestionRequest[] = [];
  const bridge = createAgentQuestionBridge({
    sessionId: 'session',
    origin: 'origin',
    signal: signal.signal,
    emit: (e: AgentQuestionRequest) => events.push(e),
  });
  const pending = bridge.ask(agentQuestions('codex', raw));
  const { type: _, questions: __, ...request } = events[0];
  const body = { ...request, answers: { voltage: ['12 V'] } };
  for (const invalid of [
    { ...body, sessionId: 'other' },
    { ...body, token: '0'.repeat(64) },
    { ...body, answers: {} },
    { ...body, answers: { voltage: [] } },
    { ...body, answers: { voltage: ['12 V', '24 V'] } },
  ])
    assert.throws(() => bridge.respond(invalid, 'origin'));
  assert.throws(() => bridge.respond(body, 'other'));
  bridge.respond(body, 'origin');
  assert.deepEqual(await pending, { voltage: ['12 V'] });
  assert.throws(() => bridge.respond(body, 'origin'));
  const cancelled = bridge.ask(agentQuestions('codex', raw));
  signal.abort();
  await assert.rejects(cancelled, /no longer active/);
  assert.equal(bridge.authorized(bridge.token), false);
  assert.throws(() => bridge.ask(agentQuestions('codex', raw)), /inactive/);
});

test('question normalization rejects secret/approval/duplicate inputs and preserves native multi-select', () => {
  for (const provider of ['codex', 'claude', 'deepseek', 'pi']) {
    assert.equal(agentQuestions(provider, [{ ...raw[0], multiSelect: true }])[0].multiSelect, true);
    for (const q of [
      { ...raw[0], isSecret: true },
      { ...raw[0], intent: { kind: 'approval' } },
      { ...raw[0], options: [{ label: 'x' }, { label: 'x' }] },
    ])
      assert.throws(() => agentQuestions(provider, [q]));
    assert.throws(() => agentQuestions(provider, [raw[0], raw[0]]));
  }
});

test('native cancellation revokes a pending question without affecting another request', async () => {
  const events: any[] = [];
  const bridge = createAgentQuestionBridge({
    sessionId: 'session',
    origin: undefined,
    signal: new AbortController().signal,
    emit: (e: unknown) => events.push(e),
  });
  const native = new AbortController();
  const first = bridge.ask(agentQuestions('codex', raw), native.signal);
  const second = bridge.ask(agentQuestions('codex', raw));
  native.abort();
  await assert.rejects(first, /no longer active/);
  assert.equal(events[2].type, 'question-closed');
  const { type: _, questions: __, ...identity } = events[1];
  bridge.respond({ ...identity, answers: { voltage: ['24 V'] } }, undefined);
  assert.deepEqual(await second, { voltage: ['24 V'] });
  bridge.close();
});

test('completed work shares the Agent header and elapsed time without an arrow or tool total', () => {
  const html = renderToStaticMarkup(
    createElement(AgentProcess, {
      running: false,
      heading: 'Codex',
      hasWork: true,
      timings: { clientTotalMs: 69_000 },
      children: 'Details',
    }),
  );
  assert.match(html, /aria-label="Work details"/);
  assert.match(html, /<summary[^>]+class="message-author"/);
  assert.match(html, /Codex/);
  assert.match(html, /aria-label="Elapsed time">1m 9s/);
  assert.doesNotMatch(html, /tool calls/);
  assert.doesNotMatch(html, /<svg|open=""|>Work details</);
  const plain = renderToStaticMarkup(
    createElement(AgentTurn, {
      text: 'A plain reply.',
      anchors: [],
      progress: [],
      tools: [],
      running: false,
      heading: 'Codex',
      timings: { clientTotalMs: 13_000 },
      renderText: (text) => text,
      renderTool: () => null,
      onNavigateHeading: () => {},
    }),
  );
  assert.match(plain, /aria-label="Elapsed time">13s/);
  assert.doesNotMatch(plain, /<details|Work details/);
  assert.ok(plain.indexOf('13s') < plain.indexOf('A plain reply.'));
});

test('live work displays directly and completed work stays collapsed without an attention label', () => {
  const render = (running: boolean) =>
    renderToStaticMarkup(
      createElement(AgentProcess, {
        running,
        heading: 'Codex',
        hasWork: true,
        children: 'Progress',
      }),
    );
  assert.doesNotMatch(render(true), /open=""/);
  assert.doesNotMatch(render(true), /<summary|Working|tool calls/);
  assert.match(render(true), /Progress/);
  assert.doesNotMatch(render(false), /tool calls/);
  assert.doesNotMatch(render(false), /open=""|Needs attention/);
  const html = renderToStaticMarkup(
    createElement(AgentQuestions, {
      questions: agentQuestions('codex', raw),
      disabled: false,
      onAnswer: async () => {},
    }),
  );
  assert.doesNotMatch(html, /checked/);
  assert.match(html, /type="submit"[^>]*disabled/);
  assert.doesNotThrow(() =>
    renderToStaticMarkup(
      createElement(AgentQuestions, {
        questions: agentQuestions('codex', [{ ...raw[0], id: 'constructor' }]),
        disabled: false,
        onAnswer: async () => {},
      }),
    ),
  );
  const progress = updateAgentProcess([], 'message', { id: 'a', text: 'Reading' });
  assert.equal(
    updateAgentProcess(progress, 'message', { id: 'a', text: ' done', append: true })[0].text,
    'Reading done',
  );
  assert.match(
    updateAgentProcess(progress, 'message', { id: 'a', text: 'x'.repeat(150000) })[0].text,
    /truncated/,
  );
});

for (const rawMode of [false, true]) {
  test(`${rawMode ? 'Raw KiCad' : 'Workbench'} delivers answers to native Agent tools in the same run`, async (t) => {
    for (const provider of ['codex', 'claude', 'deepseek', 'pi'] as const)
      await t.test(provider, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-questions-test-'));
        const resolve = async () => ({
          file: process.execPath,
          args: [
            path.resolve('tests/fixtures/agent-question-cli.mjs'),
            provider,
            ...(rawMode ? ['raw-kicad'] : []),
          ],
          env: { ...process.env },
        });
        const service = await startServer({
          dataDir: directory,
          agentRunner: (id, request, cwd, emit, signal, options) =>
            runAgent(id, request, cwd, emit, signal, { ...options, resolve }),
          rawAgentRunner: (id, request, emit, signal, options) =>
            runRawAgent(id, request, emit, signal, { ...options, resolve }),
        });
        try {
          const headers = {
            'Content-Type': 'application/json',
            'X-OpenPE-Token': service.token,
            Origin: service.base,
          };
          let sessionId: string = provider;
          if (rawMode) {
            const file = path.join(directory, 'design.kicad_sch');
            await writeFile(file, '(kicad_sch)\r\n');
            service.setRawKiCadMode(true);
            sessionId = (await service.selectRawKiCadFiles([file])).id;
          }
          const response = await fetch(
            service.base + (rawMode ? '/api/raw-kicad/chat' : '/api/chat'),
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                provider,
                prompt: 'Configure output',
                history: [],
                ...(rawMode
                  ? { selection: sessionId }
                  : { context: { title: 'Fixture' }, sessionId }),
              }),
            },
          );
          let request: AgentQuestionRequest | undefined;
          const answers: Promise<void>[] = [];
          const progress: string[] = [];
          let text = '',
            outcome = '';
          await readChatEvents(response.body!, (event) => {
            if (event.type === 'process') progress.push(event.text);
            if (event.type === 'question-request') {
              request = event;
              answers.push(
                (async () => {
                  const { type: _, questions, ...identity } = event;
                  assert.equal(identity.sessionId, sessionId);
                  const body = JSON.stringify({
                    ...identity,
                    answers: { [questions[0].id]: ['12 V'] },
                  });
                  const { Origin: _origin, ...otherOrigin } = headers;
                  const wrongOrigin = await fetch(service.base + '/api/chat/answer', {
                    method: 'POST',
                    headers: otherOrigin,
                    body,
                  });
                  assert.equal(wrongOrigin.status, 409);
                  const reply = await fetch(service.base + '/api/chat/answer', {
                    method: 'POST',
                    headers,
                    body,
                  });
                  assert.equal(reply.status, 200);
                })(),
              );
            }
            if (event.type === 'text-delta') text += event.delta;
            if (event.type === 'text-replace') text = event.text;
            if (event.type === 'error') assert.fail(event.text);
            if (event.type === 'done') outcome = event.outcome || '';
          });
          await Promise.all(answers);
          assert.equal(outcome, 'completed');
          assert.equal(text, 'Output is 12 V.');
          if (!rawMode) assert.ok(progress.includes('Checking output.'));
          else assert.deepEqual(progress, []);
          assert.ok(request);
          const stale = await fetch(service.base + '/api/chat/answer', {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
          });
          assert.equal(stale.status, 409);
          const unauthorized = await fetch(service.base + '/api/agent-questions/' + request.runId, {
            method: 'POST',
            headers,
            body: '{}',
          });
          assert.equal(unauthorized.status, 401);
        } finally {
          await service.close();
          await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
      });
  });
}
