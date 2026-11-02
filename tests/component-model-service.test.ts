import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
test('component model routes require the service token, reject foreign origins and bound request shape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-component-route-'));
  const server = await startServer({ dataDir: root });
  try {
    const post = (route: string, headers: Record<string, string>, body: unknown) =>
      fetch(server.base + '/api/' + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    for (const route of ['component-model', 'component-model/library']) {
      assert.equal((await post(route, {}, {})).status, 401);
      assert.equal(
        (
          await post(
            route,
            { 'X-OpenPE-Token': server.token, Origin: 'https://foreign.invalid' },
            {},
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post(
            route,
            { 'X-OpenPE-Token': server.token },
            { path: 'C:/private.step', url: 'https://foreign.invalid/model.step' },
          )
        ).status,
        422,
      );
    }
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
