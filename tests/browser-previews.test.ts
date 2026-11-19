import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { startBrowserPreviewServer } from '../server/browser-previews.mjs';
import type { WorkbenchPluginCatalog } from '../lib/workbench-plugins';

const origin = 'http://127.0.0.1:3000';
const headers = {
  Origin: origin,
  'Sec-Fetch-Site': 'same-origin',
  'X-OpenPE-Browser': 'preview',
  'Content-Type': 'application/json',
};

test('browser preview bootstrap and preview require exact same-origin metadata and a preview-only token', async () => {
  let calls = 0,
    closed = false;
  const expected = { shapeKey: 'bounded shape', meshes: [] };
  const host = await startBrowserPreviewServer({
    previewFactory: () => ({
      preview: async () => {
        calls++;
        return expected;
      },
      close: () => {
        closed = true;
      },
    }),
  });
  const request = (path: string, body = '{}', extra: Record<string, string> = {}) =>
    fetch(host.base + path, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body,
    });
  try {
    const sessionPath = '/api/browser-preview/session';
    const rejectedHeaders: Record<string, string>[] = [
      { Origin: 'https://foreign.example' },
      { Origin: '' },
      { Origin: origin + '/' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'X-OpenPE-Browser': '' },
    ];
    for (const extra of rejectedHeaders) {
      assert.equal((await request(sessionPath, '{}', extra)).status, 403, JSON.stringify(extra));
    }
    const foreignHost = await new Promise((resolve, reject) => {
      const req = httpRequest(
        host.base + sessionPath,
        {
          method: 'POST',
          headers: { ...headers, Host: 'foreign.example' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(foreignHost, 403);
    const preflight = await fetch(host.base + sessionPath, {
      method: 'OPTIONS',
      headers: { Origin: 'https://foreign.example' },
    });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.has('access-control-allow-origin'), false);
    assert.equal((await request(sessionPath, '{"path":"anything"}')).status, 400);
    const bootstrap = await request(sessionPath);
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
    const { token } = await bootstrap.json();
    assert.match(token, /^[0-9a-f]{64}$/);
    const auth = { 'X-OpenPE-Token': token };
    const previewPath = '/api/browser-preview/cad';
    assert.equal((await request(previewPath, '{"object":{}}')).status, 401);
    assert.equal(
      (await request(previewPath, '{"object":{}}', { 'X-OpenPE-Token': 'a'.repeat(64) })).status,
      401,
    );
    assert.equal((await request(previewPath, '{}', auth)).status, 400);
    assert.equal(
      (await request(previewPath, '{"object":{},"script":"anything"}', auth)).status,
      400,
    );
    assert.equal(
      (await request(previewPath, JSON.stringify({ object: 'x'.repeat(524288) }), auth)).status,
      413,
    );
    assert.equal((await request('/api/state', '{}', auth)).status, 404);
    assert.equal(calls, 0);
    const response = await request(previewPath, '{"object":{}}', auth);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.equal(calls, 1);
  } finally {
    await host.close();
    assert.equal(closed, true);
  }
});

test('browser plugin routes share bundled lifecycle and delegate provider operations', async () => {
  const providerCalls: string[][] = [];
  const host = await startBrowserPreviewServer({
    providerPluginService: {
      async list(provider, _signal, refresh) {
        providerCalls.push([provider, String(refresh)]);
        return {
          plugins: [],
          controlsVersion: 1,
          browse: true,
          actions: ['disable'],
          marketplaces: false,
          warning: '',
          updatedAt: 1,
        };
      },
      async change(provider, action, id) {
        providerCalls.push([provider, action, id]);
        return { ok: true };
      },
    },
  });
  const post = (path: string, body: object = {}, token?: string) =>
    fetch(`${host.base}/api/browser-preview/${path}`, {
      method: 'POST',
      headers: { ...headers, ...(token ? { 'X-OpenPE-Token': token } : {}) },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('plugin/catalog')).status, 401);
    const { token } = await (await post('session')).json();
    const plugin = (action: string, body = {}) => post(`plugin/${action}`, body, token);
    const catalog: WorkbenchPluginCatalog = await (await plugin('catalog')).json();
    assert.equal(catalog.plugins.length, 5);
    assert.ok(catalog.plugins.every(({ installed, enabled }) => installed && enabled));
    assert.equal((await plugin('guide?document=workflow')).status, 200);
    assert.equal((await plugin('guide?document=missing')).status, 400);
    for (const kind of ['spice', 'thermal']) {
      assert.equal((await plugin(`${kind}-run`, { fileId: 'forged' })).status, 400);
      assert.equal(
        (await plugin(`${kind}-run`, { source: '/arbitrary/path', executable: 'fake' })).status,
        400,
      );
      assert.equal((await plugin(`${kind}-result`)).status, 404);
    }
    assert.equal((await plugin('providers')).status, 404);
    assert.equal((await plugin('provider-list?provider=codex&refresh=true')).status, 200);
    assert.equal((await plugin('provider-list?provider=unknown')).status, 400);
    assert.equal(
      (
        await plugin('provider-change', {
          provider: 'claude',
          action: 'disable',
          id: 'fixture@local',
        })
      ).status,
      200,
    );
    assert.equal(
      (await plugin('provider-change', { provider: 'claude', action: 'disable', id: '--unknown' }))
        .status,
      400,
    );
    assert.deepEqual(providerCalls, [
      ['codex', 'true'],
      ['claude', 'disable', 'fixture@local'],
    ]);
    for (const [action, id] of [
      ['spice-status', 'spice-simulation@openpe'],
      ['thermal-status', 'pcb-thermal@openpe'],
    ]) {
      assert.equal((await plugin('change', { action: 'disable', id })).status, 200);
      assert.equal((await plugin(action)).status, 403);
    }
  } finally {
    await host.close();
  }
});

test('browser preview forwards cancellation and keeps kernel failures retryable', async () => {
  let aborted!: () => void;
  let started!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const host = await startBrowserPreviewServer({
    previewFactory: () => ({
      preview: async (_body: unknown, signal: AbortSignal) => {
        if (++calls === 1) throw new Error('Kernel unavailable.');
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              reject(new Error('Cancelled.'));
            },
            { once: true },
          );
        });
      },
      close: () => {},
    }),
  });
  try {
    const session = await fetch(host.base + '/api/browser-preview/session', {
      method: 'POST',
      headers,
      body: '{}',
    });
    const { token } = await session.json();
    const options = {
      method: 'POST',
      headers: { ...headers, 'X-OpenPE-Token': token },
      body: '{"object":{}}',
    };
    const first = await fetch(host.base + '/api/browser-preview/cad', options);
    assert.equal(first.status, 422);
    assert.deepEqual(await first.json(), { error: 'Kernel unavailable.' });
    const control = new AbortController();
    const second = fetch(host.base + '/api/browser-preview/cad', {
      ...options,
      signal: control.signal,
    });
    await running;
    control.abort();
    await assert.rejects(second, { name: 'AbortError' });
    await cancelled;
  } finally {
    await host.close();
  }
});

test('browser model previews resolve library identities without exposing file grants, imports or downloads', async () => {
  const calls: unknown[] = [];
  let closed = false;
  const host = await startBrowserPreviewServer({
    previewFactory: () => ({
      preview: async () => ({ shapeKey: 'shape', meshes: [] }),
      close() {},
    }),
    libraryFactory: (options) => {
      assert.equal(options.allowModelDownloads, false);
      assert.equal(options.dataDir, undefined);
      assert.ok(options.stepParserPool);
      return {
        request: async (request) => {
          calls.push(request);
          return { footprint: ['footprint', 'Test'] };
        },
        model: async (id, index) => {
          calls.push({ id, index });
          return { meshes: [] };
        },
        price: async (id) => {
          calls.push({ id });
          return { currency: 'USD', checkedAt: 1, offers: [] };
        },
        close: () => {
          closed = true;
        },
      };
    },
  });
  const post = (route: string, body: unknown, token?: string) =>
    fetch(host.base + '/api/browser-preview/' + route, {
      method: 'POST',
      headers: { ...headers, ...(token ? { 'X-OpenPE-Token': token } : {}) },
      body: JSON.stringify(body),
    });
  try {
    const { token } = await (await post('session', {})).json();
    assert.equal((await post('footprint', { id: 'Device:Package' })).status, 401);
    assert.equal((await post('price', { id: 'NextPCB:9728_LM358' })).status, 401);
    for (const [route, body] of [
      ['model', { id: 'Device:Package', index: -1 }],
      ['model', { id: 'Device:Package', index: 100 }],
      ['model', { id: 'Device:Package', index: 0, fileId: 'not-a-grant' }],
      ['footprint', { id: 'Device:Package', path: 'C:/secret.step' }],
      ['footprint', { id: 'x'.repeat(257) }],
      ['price', { id: 'Device:Package' }],
      ['price', { id: 'NextPCB:9728_LM358', url: 'https://example.invalid' }],
    ] as const)
      assert.equal((await post(route, body, token)).status, 400);
    for (const route of ['component-model', 'component-model/library', 'state'])
      assert.equal(
        (
          await fetch(host.base + '/api/' + route, {
            method: 'POST',
            headers: { ...headers, 'X-OpenPE-Token': token },
            body: '{}',
          })
        ).status,
        404,
      );
    assert.equal(calls.length, 0);
    assert.equal((await post('footprint', { id: 'Device:Package' }, token)).status, 200);
    assert.equal((await post('model', { id: 'Device:Package', index: 0 }, token)).status, 200);
    const price = await post('price', { id: 'NextPCB:9728_LM358' }, token);
    assert.equal(price.status, 200);
    assert.deepEqual(await price.json(), { currency: 'USD', checkedAt: 1, offers: [] });
    assert.deepEqual(calls, [
      { action: 'detail', kind: 'footprints', id: 'Device:Package' },
      { id: 'Device:Package', index: 0 },
      { id: 'NextPCB:9728_LM358' },
    ]);
  } finally {
    await host.close();
    assert.equal(closed, true);
  }
});
