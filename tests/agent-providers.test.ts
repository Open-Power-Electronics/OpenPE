import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  agentName,
  agentProviderIds,
  agentProviders,
  isAgentProvider,
  providerReasoningEfforts,
  reasoningEfforts,
} from '../lib/agent-providers';
import { defaultAgentPreferences, restoreWorkspace } from '../lib/workspace-state';
import { readChatEvents, type ChatEvent } from '../lib/chat-stream';
import { restoreWorkspace as restoreServiceWorkspace } from '../server/workspace-format.mjs';
import { startServer } from '../server/index.mjs';

test('the Agent catalog exposes every supported provider independently of local installation', () => {
  assert.equal(agentProviderIds.length, 5);
  assert.equal(new Set(agentProviderIds).size, 5);
  assert.deepEqual(
    agentProviders.map((provider) => provider.id),
    agentProviderIds,
  );
  for (const provider of agentProviders) {
    assert.equal(isAgentProvider(provider.id), true);
    assert.equal(agentName(provider.id), provider.name);
    assert.ok(provider.settingsName.trim());
  }
  for (const name of ['DeepSeek Harness', 'Pi', 'Cursor'])
    assert.ok(agentProviders.some((provider) => provider.name === name));
  for (const invalid of [undefined, null, '', 'unknown', 'CODEX', '--help', ['pi'], { id: 'pi' }])
    assert.equal(isAgentProvider(invalid), false);
});

test('workspace recovery retains each selected Agent and its independent model preference', () => {
  assert.deepEqual(Object.keys(defaultAgentPreferences.models), agentProviderIds);
  const models = Object.fromEntries(agentProviderIds.map((id) => [id, `fixture/${id}-model`]));
  models.deepseek = '["fixture-provider","vendor/model:v2"]';
  for (const provider of agentProviderIds) {
    const state = {
      version: 2,
      documents: [],
      activeDocumentId: null,
      ...defaultAgentPreferences,
      provider,
      models,
    };
    for (const restore of [restoreWorkspace, restoreServiceWorkspace]) {
      const restored = restore(JSON.parse(JSON.stringify(state)));
      assert.equal(restored.provider, provider);
      assert.deepEqual(restored.models, models);
    }
  }
});

test('new Agent preferences default to medium and recovery preserves every native effort', () => {
  assert.equal(defaultAgentPreferences.effort, 'medium');
  const state = {
    version: 2,
    documents: [],
    activeDocumentId: null,
    ...defaultAgentPreferences,
  };
  for (const restore of [restoreWorkspace, restoreServiceWorkspace]) {
    for (const effort of reasoningEfforts)
      assert.equal(restore({ ...state, effort }).effort, effort);
    for (const effort of [undefined, null, '', 'unknown', 'HIGH', ['high'], 1, {}])
      assert.throws(() => restore({ ...state, effort }), /Invalid saved Agent reasoning effort/);
  }
});

test('recovery rejects invalid or missing provider and model choices without defaulting', () => {
  for (const restore of [restoreWorkspace, restoreServiceWorkspace]) {
    for (const invalid of [undefined, null, 'bad\nmodel', 42, 'x'.repeat(513)]) {
      const models = Object.fromEntries(agentProviderIds.map((id) => [id, `fixture/${id}`]));
      for (const provider of agentProviderIds) {
        const state = {
          version: 2,
          documents: [],
          activeDocumentId: null,
          ...defaultAgentPreferences,
          provider,
          models: { ...models, [provider]: invalid },
        };
        const before = structuredClone(state);
        assert.throws(() => restore(state), /Invalid saved Agent model/);
        assert.deepEqual(state, before);
      }
    }
    for (const invalid of ['--help', 'x'.repeat(201), '["fixture-provider","vendor/model:v2"]'])
      assert.throws(
        () => restore({
          version: 2,
          documents: [],
          activeDocumentId: null,
          ...defaultAgentPreferences,
          models: { ...defaultAgentPreferences.models, claude: invalid },
        }),
        /Invalid saved Agent model/,
      );
    for (const provider of [undefined, null, '', 'unknown', '--help', ['pi'], { id: 'pi' }]) {
      assert.throws(
        () =>
          restore({
            version: 2,
            documents: [],
            activeDocumentId: null,
            ...defaultAgentPreferences,
            provider,
          }),
        /Invalid saved Agent provider/,
      );
    }
    assert.deepEqual(
      restore({
        version: 2,
        documents: [],
        activeDocumentId: null,
        ...defaultAgentPreferences,
      }).models,
      defaultAgentPreferences.models,
    );
  }
});

test('authenticated Agent routes dispatch only catalog IDs to the selected provider adapter', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-agent-providers-'));
  const modelCalls: string[] = [];
  const modelId = (provider: string) =>
    provider === 'deepseek' ? '["fixture-provider","vendor/model:v2"]' : `fixture/${provider}`;
  const runCalls: { provider: string; request: unknown }[] = [];
  const service = await startServer({
    dataDir,
    agentRunner: async (provider, request, _cwd, emit) => {
      runCalls.push({ provider, request });
      emit({ type: 'text-delta', delta: `Reply from ${provider}` });
      return { outcome: 'completed' };
    },
    modelLister: async (provider) => {
      modelCalls.push(provider);
      return { models: [{ id: modelId(provider), label: `Fixture ${provider}` }] };
    },
  });
  const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
  const request = {
    prompt: 'Explain this fixture',
    context: { title: 'Fixture' },
    history: [],
    model: 'fixture/model',
  };
  try {
    for (const provider of agentProviderIds) {
      const models = await fetch(`${service.base}/api/models?provider=${provider}`, { headers });
      assert.equal(models.status, 200);
      assert.deepEqual(await models.json(), {
        models: [{ id: modelId(provider), label: `Fixture ${provider}` }],
      });
      const body = { ...request, provider, model: modelId(provider), sessionId: `fixture-${provider}` };
      const response = await fetch(`${service.base}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      const events: ChatEvent[] = [];
      await readChatEvents(response.body!, (event) => events.push(event));
      assert.ok(
        events.some(
          (event) => event.type === 'text-delta' && event.delta === `Reply from ${provider}`,
        ),
      );
      assert.deepEqual(events.at(-1), { type: 'done', outcome: 'completed' });
      assert.deepEqual(runCalls.at(-1), { provider, request: body });
    }
    assert.deepEqual(modelCalls, agentProviderIds);
    assert.deepEqual(
      runCalls.map((call) => call.provider),
      agentProviderIds,
    );

    for (const provider of ['', 'unknown', '--help', 'pi;echo injected']) {
      const response = await fetch(
        `${service.base}/api/models?provider=${encodeURIComponent(provider)}`,
        { headers },
      );
      assert.equal(response.status, 400);
    }
    const duplicateQuery = await fetch(`${service.base}/api/models?provider=codex&provider=pi`, {
      headers,
    });
    assert.equal(duplicateQuery.status, 400);
    for (const provider of [undefined, null, '', 'unknown', '--help', ['pi'], { id: 'pi' }]) {
      const response = await fetch(`${service.base}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, provider }),
      });
      assert.equal(response.status, 400);
    }
    for (const rejectedHeaders of [
      { 'Content-Type': 'application/json' },
      { ...headers, Origin: 'https://untrusted.example' },
    ]) {
      const expectedStatus = 'Origin' in rejectedHeaders ? 403 : 401;
      const models = await fetch(`${service.base}/api/models?provider=pi`, {
        headers: rejectedHeaders,
      });
      assert.equal(models.status, expectedStatus);
      const chat = await fetch(`${service.base}/api/chat`, {
        method: 'POST',
        headers: rejectedHeaders,
        body: JSON.stringify({ ...request, provider: 'pi' }),
      });
      assert.equal(chat.status, expectedStatus);
    }
    assert.deepEqual(
      modelCalls,
      agentProviderIds,
      'Rejected requests never reach model discovery.',
    );
    assert.deepEqual(
      runCalls.map((call) => call.provider),
      agentProviderIds,
      'Rejected requests never reach the Agent runner.',
    );
  } finally {
    service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('chat admission preserves every provider-native effort and rejects foreign or invalid values', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-agent-efforts-'));
  const calls: { provider: string; effort: unknown; parameters?: unknown }[] = [];
  const service = await startServer({
    dataDir,
    agentRunner: async (provider, request) => {
      calls.push({
        provider,
        effort: request.effort,
        ...(request.parameters ? { parameters: request.parameters } : {}),
      });
      return { outcome: 'completed' };
    },
  });
  const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
  try {
    for (const provider of agentProviderIds) {
      for (const effort of [...reasoningEfforts, '', 'unknown', null, ['high'], 42]) {
        const accepted = providerReasoningEfforts[provider].some((value) => value === effort);
        const before = calls.length;
        const response = await fetch(`${service.base}/api/chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            provider,
            effort,
            prompt: 'Fixture',
            context: {},
            history: [],
            sessionId: 'effort-admission',
          }),
        });
        assert.equal(response.status, accepted ? 200 : 400, `${provider}: ${String(effort)}`);
        await response.text();
        assert.equal(calls.length, before + Number(accepted));
        if (accepted) assert.deepEqual(calls.at(-1), { provider, effort });
      }
    }
    const parameters = [{ id: 'context', value: '500k' }];
    for (const [provider, body, status] of [
      ['cursor', { parameters }, 200],
      ['cursor', { parameters: [{ id: 'context', value: '500k', extra: true }] }, 400],
      ['cursor', { parameters: [] }, 400],
      ['codex', { parameters }, 400],
    ] as const) {
      const before = calls.length;
      const response = await fetch(`${service.base}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider,
          prompt: 'Fixture',
          context: {},
          history: [],
          sessionId: 'parameter-admission',
          ...body,
        }),
      });
      assert.equal(response.status, status, `${provider} parameters`);
      await response.text();
      assert.equal(calls.length, before + Number(status === 200));
    }
    assert.deepEqual(calls.at(-1), {
      provider: 'cursor',
      effort: undefined,
      parameters,
    });
  } finally {
    service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
