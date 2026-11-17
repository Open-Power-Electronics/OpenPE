import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../lib/bridge';

test('browser bridge routes bounded previews and plugins through one retryable session', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const calls: { path: string; options: RequestInit }[] = [];
  let sessions = 0,
    expired = false;
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    if (path.endsWith('/session')) {
      sessions++;
      return Response.json({ token: String(sessions).repeat(64) });
    }
    return expired
      ? Response.json({ error: 'Session expired.' }, { status: 401 })
      : Response.json({ shapeKey: 'shape', meshes: [] });
  });
  try {
    await assert.rejects(api('state'), /Electron/);
    await assert.rejects(api('model-cad/preview', { method: 'GET' }), /Electron/);
    assert.equal(calls.length, 0);
    const options = { method: 'POST', body: '{"object":{}}' };
    await Promise.all([api('model-cad/preview', options), api('model-cad/preview', options)]);
    assert.equal(sessions, 1);
    const preview = calls.find((call) => call.path.endsWith('/cad'))!;
    assert.equal(preview.options.body, options.body);
    assert.equal(new Headers(preview.options.headers).get('X-OpenPE-Token'), '1'.repeat(64));
    const id = 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm';
    await api(`libraries/footprints?id=${encodeURIComponent(id)}`);
    await api(`library-model?id=${encodeURIComponent(id)}&index=0`);
    assert.deepEqual(
      calls.slice(-2).map(({ path, options }) => ({
        path,
        method: options.method,
        body: JSON.parse(String(options.body)),
      })),
      [
        { path: '/api/browser-preview/footprint', method: 'POST', body: { id } },
        { path: '/api/browser-preview/model', method: 'POST', body: { id, index: 0 } },
      ],
    );
    await api('workbench-plugins');
    await api('pcb-design/guide?document=workflow');
    await api('simulation/transient', {
      method: 'POST',
      body: '{"source":"fixture","config":{}}',
      headers: { Accept: 'text/event-stream' },
    });
    assert.deepEqual(
      calls.slice(-3).map(({ path }) => path),
      [
        '/api/browser-preview/plugin/catalog',
        '/api/browser-preview/plugin/guide?document=workflow',
        '/api/browser-preview/plugin/spice-run',
      ],
    );
    assert.equal(new Headers(calls.at(-1)!.options.headers).get('Accept'), 'text/event-stream');
    await api('plugins?provider=codex&refresh=true');
    assert.equal(calls.at(-1)!.path, '/api/browser-preview/plugin/provider-list?provider=codex&refresh=true');
    const beforeDenied = calls.length;
    for (const route of [
      `library-model?id=${encodeURIComponent(id)}&index=0&path=C:/secret.step`,
      `library-model?id=${encodeURIComponent(id)}`,
      `libraries/footprints?id=a&id=b`,
      'libraries/footprints?q=anything',
      'component-model',
      'component-model/library',
      'plugins?provider=codex&path=arbitrary',
      'simulation/result',
      'thermal/spice-sources',
    ])
      await assert.rejects(api(route), /Electron/);
    assert.equal(calls.length, beforeDenied);
    expired = true;
    await assert.rejects(api('model-cad/preview', options), /Session expired/);
    assert.equal(sessions, 1, 'An expired request does not silently replay.');
    expired = false;
    await api('model-cad/preview', options);
    assert.equal(sessions, 2);
    const control = new AbortController();
    control.abort();
    const count = calls.length;
    await assert.rejects(api('model-cad/preview', { ...options, signal: control.signal }), {
      name: 'AbortError',
    });
    assert.equal(calls.length, count);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
