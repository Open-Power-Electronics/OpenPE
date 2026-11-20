import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { makePrompt, resolveAgent } from '../server/agents.mjs';
import { exampleProject } from '../lib/project-example';
import { serializeProject } from '../lib/project';
import { createReferenceExample, referenceExamples } from '../lib/reference-examples';
import { pinPositions } from '../lib/circuit';
import { schematicTexts } from '../lib/schematic-text';
import { commitWireRoute } from '../lib/wiring';
import { saveAnnotation } from '../lib/schematic-edit';
import { createSession } from '../lib/chat-sessions';
import { defaultAgentPreferences } from '../lib/workspace-state';
import {
  importDocument as nativeImportDocument,
  exportKiCad as nativeExportKiCad,
} from '../server/project-format.mjs';

function workspace(source: string, sourceDraft: string | null = null) {
  const session = createSession();
  const document = {
    id: crypto.randomUUID(),
    source,
    sourceDraft,
    dirty: false,
    filename: 'project.kicad_pro',
    sessions: [session],
    activeSessionId: session.id,
  };
  return {
    version: 2,
    documents: [document],
    activeDocumentId: document.id,
    ...defaultAgentPreferences,
  };
}
function changeDocument(payload: ReturnType<typeof workspace>, changes: Record<string, unknown>) {
  return { ...payload, documents: [{ ...payload.documents[0], ...changes }] };
}

test('wiring Home projects with added free text survives native validation and draft persistence', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-text-wire-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = await startServer({ dataDir: dir });
  const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
  try {
    for (const { id } of referenceExamples) {
      const project = createReferenceExample(id);
      const d = saveAnnotation(project.schematic, 'Native annotation test\nSecond line', {
        x: 200,
        y: 200,
      }).circuit;
      project.schematic = d;
      const text = schematicTexts(d.original);
      assert.ok(text.some((item) => item.text === 'Native annotation test\nSecond line'));

      const part = d.parts.find((p) => pinPositions(p, d.libraries[p.libId]).length > 0)!;
      const pin = pinPositions(part, d.libraries[part.libId])[0];
      project.schematic = commitWireRoute(d, [
        pin,
        { x: pin.x, y: Number((pin.y - 12.7).toFixed(4)) },
      ]);
      const source = serializeProject(project);
      // Electron's native save/open handlers use this generated module, not TS source.
      const native = nativeImportDocument(source);
      assert.deepEqual(schematicTexts(native.schematic.original), text);
      const exported = nativeImportDocument(nativeExportKiCad(native, 'schematic'));
      assert.deepEqual(schematicTexts(exported.schematic.original), text);
      const response = await fetch(service.base + '/api/state', {
        method: 'POST',
        headers,
        body: JSON.stringify(workspace(source)),
      });
      assert.equal(response.status, 200, await response.text());
      const restored = await (await fetch(service.base + '/api/state', { headers })).json();
      assert.equal(restored.documents[0].source, source);
      assert.equal(
        JSON.parse(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8')).documents[0]
          .source,
        source,
      );
    }
  } finally {
    service.close();
  }
});
test('closing a project clears recovery through the authenticated state queue', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-close-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = await startServer({ dataDir: dir });
  const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
  const payload = workspace(serializeProject(exampleProject()), '{"version":');
  try {
    await fetch(service.base + '/api/state', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    assert.equal((await fetch(service.base + '/api/state', { method: 'DELETE' })).status, 401);
    assert.equal(
      (
        await fetch(service.base + '/api/state', {
          method: 'DELETE',
          headers: { ...headers, Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    assert.deepEqual(await (await fetch(service.base + '/api/state', { headers })).json(), payload);
    assert.equal(
      (await fetch(service.base + '/api/state', { method: 'DELETE', headers })).status,
      200,
    );
    assert.equal(await (await fetch(service.base + '/api/state', { headers })).json(), null);
    assert.equal(
      JSON.parse(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8')),
      null,
    );
    // Clearing an already closed project is safe, and the next project can recover normally.
    assert.equal(
      (await fetch(service.base + '/api/state', { method: 'DELETE', headers })).status,
      200,
    );
    await fetch(service.base + '/api/state', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    assert.deepEqual(await (await fetch(service.base + '/api/state', { headers })).json(), payload);
  } finally {
    service.close();
  }
});
test('prompt carries current schematic and bounded history', () => {
  const p = makePrompt({
    prompt: '调整 C2',
    context: { title: 'Buck' },
    history: Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: 'turn-' + i })),
  });
  assert.ok(p.includes('Buck'));
  assert.ok(p.includes('调整 C2'));
  assert.ok(p.includes('turn-19'));
  assert.ok(!p.includes('"turn-0"'));
  assert.ok(
    p.includes('When no edits are proposed, answer normally without a proposal code block.'),
  );
});
test('unknown providers cannot become executable names', async () => {
  await assert.rejects(resolveAgent('powershell'), /Unknown/);
});
test('local API enforces token and origin, saves atomically and restores state', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await startServer({ dataDir: dir });
  try {
    assert.equal((await fetch(s.base + '/api/state')).status, 401);
    assert.equal(
      (
        await fetch(s.base + '/api/state', {
          headers: { Origin: 'https://evil.example', 'X-OpenPE-Token': s.token },
        })
      ).status,
      403,
    );
    const headers = { 'X-OpenPE-Token': s.token, 'Content-Type': 'application/json' };
    assert.equal(await (await fetch(s.base + '/api/state', { headers })).json(), null);
    const payload = workspace(serializeProject(exampleProject()));
    assert.equal(
      (
        await fetch(s.base + '/api/state', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        })
      ).status,
      200,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8')),
      payload,
    );
    const savedRecovery = await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8');
    const legacyDocument = JSON.parse(payload.documents[0].source);
    legacyDocument.format = 'unsupported-format';
    const legacySource = JSON.stringify(legacyDocument);
    assert.throws(
      () => nativeImportDocument(legacySource),
      /unsupported internal snapshot format/i,
    );
    const rejectedLegacy = await fetch(s.base + '/api/state', {
      method: 'POST',
      headers,
      body: JSON.stringify(changeDocument(payload, { source: legacySource })),
    });
    assert.equal(rejectedLegacy.status, 400);
    assert.equal(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8'), savedRecovery);
    assert.deepEqual(await (await fetch(s.base + '/api/state', { headers })).json(), payload);
    // Incomplete source is recoverable text, never the canonical project payload.
    const draftPayload = changeDocument(payload, { sourceDraft: '{"schematic":' });
    assert.equal(
      (
        await fetch(s.base + '/api/state', {
          method: 'POST',
          headers,
          body: JSON.stringify(draftPayload),
        })
      ).status,
      200,
    );
    assert.deepEqual(await (await fetch(s.base + '/api/state', { headers })).json(), draftPayload);
    for (const sourceDraft of [42, {}, 'Ω'.repeat(4_000_001)]) {
      assert.equal(
        (
          await fetch(s.base + '/api/state', {
            method: 'POST',
            headers,
            body: JSON.stringify(changeDocument(payload, { sourceDraft })),
          })
        ).status,
        400,
      );
      assert.deepEqual(
        JSON.parse(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8')),
        draftPayload,
      );
    }
    await fetch(s.base + '/api/state', { method: 'POST', headers, body: JSON.stringify(payload) });
    const broken = JSON.parse(payload.documents[0].source);
    broken.schematic.components[0].footprints[0].pads[0].netId = broken.project.id;
    assert.equal(
      (
        await fetch(s.base + '/api/state', {
          method: 'POST',
          headers,
          body: JSON.stringify(changeDocument(payload, { source: JSON.stringify(broken) })),
        })
      ).status,
      400,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8')),
      payload,
    );
    assert.equal(
      (
        await fetch(s.base + '/api/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({ provider: 'other', prompt: 'x' }),
        })
      ).status,
      400,
    );
  } finally {
    s.close();
  }
});
