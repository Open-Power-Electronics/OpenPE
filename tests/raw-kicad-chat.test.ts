import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runRawAgent } from '../server/agents.mjs';
import { startServer } from '../server/index.mjs';
import { createRawKiCadSession } from '../server/raw-kicad-chat.mjs';

test('Raw KiCad captures exact file text and preserves a valid selection on rejection', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-raw-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'original.kicad_pcb');
  const invalid = path.join(directory, 'invalid.kicad_sch');
  const large = path.join(directory, 'large.kicad_pro');
  const linked = path.join(directory, 'linked');
  const original = '\ufeffnot necessarily parsed\r\nµF  \r\n';
  await writeFile(file, original);
  await writeFile(invalid, Buffer.from([0xff]));
  await writeFile(large, 'x'.repeat(2 * 1024 * 1024));
  await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const session = createRawKiCadSession();
  session.setActive(true);
  const { id, names } = await session.select([file]);
  assert.deepEqual(names, ['original.kicad_pcb']);
  const prompt = 'Check this board.  ';
  const expected = `${prompt}\n\nKiCad file "original.kicad_pcb" (${Buffer.byteLength(original)} UTF-8 bytes):\n${original}`;
  assert.equal(session.prompt(id, prompt, []), expected);
  await assert.rejects(session.select([file, invalid]), /UTF-8/);
  await assert.rejects(session.select([file, large]), /2 MiB/);
  await assert.rejects(session.select([file, file]), /distinct filenames/);
  await assert.rejects(session.select([path.join(linked, path.basename(file))]), /regular folder/);
  assert.equal(session.prompt(id, prompt, []), expected);
  await writeFile(file, 'x'.repeat(1100 * 1024));
  assert.equal(session.prompt(id, prompt, []), expected);
  const bigger = await session.select([file]);
  assert.ok(session.prompt(bigger.id, prompt, []).endsWith('x'.repeat(1100 * 1024)));
  session.setActive(false);
  session.setActive(true);
  assert.throws(() => session.prompt(bigger.id, prompt, []), /Choose KiCad files/);
});

test('raw Codex transport forwards the exact prompt and skips workbench instructions and tools', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url));
  const events: { type: string; text?: string; delta?: string }[] = [];
  const result = await runRawAgent(
    'codex',
    { prompt: 'Fixture raw prompt\r\n(kicad_pcb)' },
    (event: (typeof events)[number]) => events.push(event),
    new AbortController().signal,
    {
      resolve: async () => ({
        file: process.execPath,
        args: [fixture, 'raw-kicad'],
        env: process.env,
      }),
    },
  );
  assert.equal(result.outcome, 'completed', JSON.stringify(events));
  assert.ok(events.some((event) => ['text-delta', 'text-replace'].includes(event.type)));
});

test('Raw KiCad HTTP permits only message transport and revokes live turns and file IDs', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-raw-route-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'design.kicad_sch');
  const source = '\ufeff(kicad_sch)\r\n  ';
  await writeFile(file, source);
  const calls: unknown[][] = [];
  const normalStarted = Promise.withResolvers<void>();
  const normalStopped = Promise.withResolvers<void>();
  const rawStopped = Promise.withResolvers<void>();
  function stopped(signal: AbortSignal) {
    return signal.aborted
      ? Promise.resolve()
      : new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
  }
  const service = await startServer({
    dataDir,
    agentRunner: async (
      _provider: unknown,
      _request: unknown,
      _cwd: unknown,
      _emit: unknown,
      signal: AbortSignal,
    ) => {
      normalStarted.resolve();
      await stopped(signal);
      normalStopped.resolve();
      return { outcome: 'cancelled' };
    },
    rawAgentRunner: async (
      provider: string,
      request: { prompt: string },
      emit: (event: object) => void,
      signal: AbortSignal,
      options: object = {},
    ) => {
      calls.push([provider, request, Object.keys(options)]);
      emit({ type: 'status', text: 'private status' });
      emit({ type: 'question-request', token: 'private token' });
      emit({ type: 'text-delta', delta: 'Raw reply' });
      if (request.prompt.startsWith('Wait')) {
        await stopped(signal);
        rawStopped.resolve();
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed' };
    },
  });
  const headers = { 'Content-Type': 'application/json', 'X-OpenPE-Token': service.token };
  const post = (route: string, body: object, extra: Record<string, string> = {}) =>
    fetch(`${service.base}/api/${route}`, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  const raw = (body: object, extra?: Record<string, string>) => post('raw-kicad/chat', body, extra);
  const plugins = () => fetch(`${service.base}/api/workbench-plugins`, { headers });
  const normalBody = {
    provider: 'codex',
    prompt: 'Fixture',
    sessionId: 'fixture',
    context: { title: 'Fixture' },
    history: [],
  };
  try {
    assert.equal((await raw({})).status, 409);
    const normal = await post('chat', normalBody);
    assert.equal(normal.status, 200);
    const normalClosed = normal.text().catch(() => '');
    await normalStarted.promise;
    service.setRawKiCadMode(true);
    await normalStopped.promise;
    await normalClosed;
    const selection = await service.selectRawKiCadFiles([file]);
    const payload = { selection: selection.id, provider: 'codex', prompt: 'Inspect.', history: [] };
    assert.equal((await plugins()).status, 409);
    assert.equal(
      (await fetch(`${service.base}/api/plugins?provider=codex`, { headers })).status,
      409,
    );
    assert.equal((await post('chat', normalBody)).status, 409);
    assert.equal((await post('agent-questions/fixture', {})).status, 409);
    assert.equal((await raw(payload, { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await raw(payload, { 'X-OpenPE-Token': 'invalid' })).status, 401);
    assert.equal((await raw({ ...payload, context: {} })).status, 400);
    const stream = await raw(payload);
    assert.equal(stream.status, 200);
    const reply = await stream.text();
    assert.match(reply, /"delta":"Raw reply"/);
    assert.match(reply, /"outcome":"completed"/);
    assert.doesNotMatch(reply, /private|question-request|status/);
    assert.deepEqual(calls, [
      [
        'codex',
        {
          prompt: `${payload.prompt}\n\nKiCad file "design.kicad_sch" (${Buffer.byteLength(source)} UTF-8 bytes):\n${source}`,
          model: undefined,
          effort: undefined,
          parameters: undefined,
        },
        ['cursorCredential'],
      ],
    ]);
    const waiting = await raw({ ...payload, prompt: 'Wait' });
    const ended = waiting.text().catch(() => '');
    assert.equal(waiting.status, 200);
    assert.equal((await raw(payload)).status, 409);
    service.setRawKiCadMode(false);
    await rawStopped.promise;
    await ended;
    assert.equal((await plugins()).status, 200);
    service.setRawKiCadMode(true);
    assert.equal((await raw(payload)).status, 400);
  } finally {
    service.close();
  }
});
