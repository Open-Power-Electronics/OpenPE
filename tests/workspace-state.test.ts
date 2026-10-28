import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { appendSchematic, createProject, serializeProject } from '../lib/project';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createSession } from '../lib/chat-sessions';
import {
  defaultAgentPreferences,
  restoreWorkspace,
  type DocumentState,
} from '../lib/workspace-state';
import { startServer } from '../server/index.mjs';
const { FileGrants } = createRequire(import.meta.url)('../electron/file-grants.cjs');

function document(title: string): DocumentState {
  const project = createProject(emptyCircuit());
  project.schematic.title = title;
  project.extensions['org.openpe.test'] = { title };
  const session = createSession(title + ' draft');
  return {
    id: crypto.randomUUID(),
    source: serializeProject(project),
    sourceDraft: null,
    dirty: false,
    filename: `${title}.kicad_pro`,
    sessions: [session],
    activeSessionId: session.id,
  };
}
test('workspace recovery keeps independent projects, invalid pending source and conversations', () => {
  const a = document('A'),
    b = document('B');
  a.sourceDraft = '{unfinished';
  const state = {
    version: 2,
    documents: [a, b],
    activeDocumentId: b.id,
    ...defaultAgentPreferences,
  };
  assert.deepEqual(restoreWorkspace(JSON.parse(JSON.stringify(state))), state);
  assert.equal(
    restoreWorkspace({ ...state, documents: [{ ...a, sourceDraft: '' }, b] }).documents[0]
      .sourceDraft,
    '',
  );
  for (const change of [
    { version: 3 },
    { activeDocumentId: 'missing' },
    { documents: [a, a] },
    { documents: [a, { ...b, sessions: a.sessions }] },
    { documents: [a, { ...b, source: '{invalid' }] },
    { documents: [a, { ...b, sourceDraft: 42 }] },
    { documents: [a, { ...b, dirty: 'false' }] },
  ])
    assert.throws(() => restoreWorkspace({ ...state, ...change }));
  assert.throws(
    () => restoreWorkspace({ ...a, messages: [], provider: 'claude' }),
    /Unsupported workspace version/,
  );
});

test('recovery preserves clean projects, actual edits and pending Source independently', () => {
  const clean = document('Unedited example');
  const edited = { ...document('Edited project'), dirty: true };
  const draft = { ...document('Source draft'), sourceDraft: '{pending' };
  const workspace = {
    version: 2,
    documents: [clean, edited, draft],
    activeDocumentId: clean.id,
    ...defaultAgentPreferences,
  };
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.documents[0].dirty, false);
  assert.equal(restored.documents[1].dirty, true);
  assert.equal(restored.documents[2].dirty, false);
  assert.equal(restored.documents[2].sourceDraft, '{pending');
  const { dirty: _dirty, ...legacy } = edited;
  assert.throws(
    () =>
      restoreWorkspace({
        ...workspace,
        documents: [legacy],
        activeDocumentId: legacy.id,
      }),
    /Invalid project modification state/,
  );
  assert.throws(() => restoreWorkspace(legacy), /Unsupported workspace version/);
});

test('current recovery rejects missing required fields instead of synthesizing saved state', () => {
  const saved = document('Complete recovery');
  const state = {
    version: 2,
    documents: [saved],
    activeDocumentId: saved.id,
    ...defaultAgentPreferences,
  };
  for (const field of ['dirty', 'sourceDraft', 'filename', 'sessions', 'activeSessionId']) {
    const missing = structuredClone(state);
    Reflect.deleteProperty(missing.documents[0], field);
    const before = structuredClone(missing);
    assert.throws(() => restoreWorkspace(missing), field);
    assert.deepEqual(missing, before);
  }
  for (const field of ['provider', 'effort', 'approvalMode', 'models']) {
    const missing = structuredClone(state);
    Reflect.deleteProperty(missing, field);
    assert.throws(() => restoreWorkspace(missing), field);
  }
  const missingModel = structuredClone(state);
  Reflect.deleteProperty(missingModel.models, 'pi');
  assert.throws(() => restoreWorkspace(missingModel), /Invalid saved Agent model/);
});

test('workspace restoration accepts typed simulation settings and rejects retired or duplicated sources without migration', () => {
  const settings = [
    ['seriesResistance', 'OpenPE.SeriesResistance'],
    ['initialVoltage', 'OpenPE.InitialVoltage'],
    ['coupling', 'OpenPE.Coupling'],
  ] as const;
  for (const additional of [false, true])
    for (const [canonical, native] of settings) {
      const project = additional ? appendSchematic(createProject()).project : createProject();
      const schematic = additional ? project.additionalSchematics![0] : project.schematic;
      const part = createPart(schematic, 'C', 0, 0);
      part.fields = { ...part.fields, [native]: '50m', 'OpenPE.Note': 'Keep this note.' };
      schematic.parts.push(part);
      const recovered = { ...document('Simulation'), source: serializeProject(project) };
      const workspace = {
        version: 2,
        documents: [recovered],
        activeDocumentId: recovered.id,
        ...defaultAgentPreferences,
      };
      assert.equal(restoreWorkspace(workspace).documents[0].source, recovered.source);
      for (const duplicate of [false, true]) {
        const source = JSON.parse(recovered.source);
        const sheet = additional ? source.additionalSchematics[0].schematic : source.schematic;
        const component = sheet.components[0];
        component.fields = { ...component.fields, [native]: '50m' };
        if (!duplicate) delete component.simulation[canonical];
        const invalid = {
          ...workspace,
          documents: [{ ...recovered, source: JSON.stringify(source), sourceDraft: '{pending' }],
        };
        const before = structuredClone(invalid);
        assert.throws(() => restoreWorkspace(invalid), /Invalid OpenPE project/);
        assert.deepEqual(invalid, before, 'Rejected recovery is not converted or rewritten.');
      }
    }
});
test('recovery validates local example flags without storing native paths', () => {
  const a = document('Example');
  // Use an allowlisted identity from the example manifest.
  a.exampleKey = 'example:reference-lm27761-wson8-pump';
  a.localExample = true;
  const state = {
    version: 2,
    documents: [a],
    activeDocumentId: a.id,
    ...defaultAgentPreferences,
  };
  assert.equal(restoreWorkspace(state).documents[0].localExample, true);
  assert.equal(
    restoreWorkspace({ ...state, documents: [{ ...a, localExample: false }] }).documents[0]
      .localExample,
    false,
  );
  assert.throws(() => restoreWorkspace({ ...state, documents: [{ ...a, localExample: 'true' }] }));
  assert.throws(() => restoreWorkspace({ ...state, documents: [{ ...a, exampleKey: null }] }));
  assert.equal('path' in restoreWorkspace(state).documents[0], false);
});

test('closed tabs recover independently of project content and reject broken links', () => {
  const a = document('Tabs');
  const project = appendSchematic(createProject());
  a.source = serializeProject(project.project);
  a.activeSchematicId = project.schematic.id;
  a.closedSchematicIds = [project.project.schematic.id];
  const state = {
    version: 2,
    documents: [a],
    activeDocumentId: a.id,
    ...defaultAgentPreferences,
  };
  const recovered = restoreWorkspace(state).documents[0];
  assert.deepEqual(recovered.closedSchematicIds, a.closedSchematicIds);
  assert.equal(recovered.source, a.source);
  assert.equal(recovered.dirty, false);
  for (const invalid of [
    [a.activeSchematicId],
    [crypto.randomUUID()],
    [project.project.schematic.id, project.project.schematic.id],
    'all',
  ])
    assert.throws(() =>
      restoreWorkspace({
        ...state,
        documents: [{ ...a, closedSchematicIds: invalid }],
      }),
    );
});

test('repeated recovery reuses validated project metadata while checking every live envelope', () => {
  const a = document('Cached recovery');
  const sheets = appendSchematic(createProject());
  a.source = serializeProject(sheets.project);
  a.activeSchematicId = sheets.schematic.id;
  a.closedSchematicIds = [sheets.project.schematic.id];
  const state = {
    version: 2,
    documents: [a],
    activeDocumentId: a.id,
    ...defaultAgentPreferences,
  };
  const originalParse = JSON.parse;
  let imports = 0;
  const parse = mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    if (args[0] === a.source) imports++;
    return originalParse(...args);
  });
  try {
    const first = restoreWorkspace(structuredClone(state));
    first.documents[0].closedSchematicIds!.push('changed-returned-array');
    first.documents[0].sessions[0].draft = 'changed-returned-session';
    const updated = structuredClone(state);
    updated.documents[0].sessions[0].draft = 'new composer draft';
    updated.documents[0].sourceDraft = '{unfinished';
    const next = restoreWorkspace(updated).documents[0];
    assert.equal(next.sessions[0].draft, 'new composer draft');
    assert.equal(next.sourceDraft, '{unfinished');
    assert.deepEqual(next.closedSchematicIds, a.closedSchematicIds);
    assert.equal(imports, 1, 'Identical validated source is imported only once.');
    for (const change of [
      { activeSchematicId: crypto.randomUUID() },
      { closedSchematicIds: [a.activeSchematicId] },
      { dirty: 'false' },
      { sourceDraft: 42 },
      { exampleKey: 'example:unregistered' },
      { localExample: true, exampleKey: null },
      { sessions: [{ ...a.sessions[0], messages: [{ id: 'bad', role: 'other', text: '' }] }] },
      { sessions: [{ ...a.sessions[0], annotations: [{}] }] },
    ])
      assert.throws(() => restoreWorkspace({ ...state, documents: [{ ...a, ...change }] }));
    assert.throws(() => restoreWorkspace({ ...state, activeDocumentId: crypto.randomUUID() }));
    assert.throws(() => restoreWorkspace({ ...state, documents: [a, a] }));
    assert.throws(() =>
      restoreWorkspace({ ...state, documents: [a, { ...a, id: crypto.randomUUID() }] }),
    );
    assert.equal(imports, 1, 'Envelope and session rejection does not reimport unchanged source.');
  } finally {
    parse.mock.restore();
  }
});

test('recovery metadata reuse matches exact source and never accepts or retains failed imports', () => {
  const a = document('Exact recovery source');
  const state = {
    version: 2,
    documents: [a],
    activeDocumentId: a.id,
    ...defaultAgentPreferences,
  };
  const originalParse = JSON.parse;
  const imports = new Map<string, number>();
  const parse = mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    imports.set(args[0], (imports.get(args[0]) ?? 0) + 1);
    return originalParse(...args);
  });
  try {
    restoreWorkspace(state);
    for (const invalid of [
      '{unfinished',
      JSON.stringify({ ...originalParse(a.source), format: 'unsupported-format' }),
      JSON.stringify({ ...originalParse(a.source), unsupported: true }),
    ]) {
      const changed = { ...state, documents: [{ ...a, source: invalid }] };
      assert.throws(() => restoreWorkspace(changed));
      assert.throws(() => restoreWorkspace(changed));
      assert.equal(imports.get(invalid), 2, 'Every failed import is checked again.');
    }
    const differentlySpaced = a.source + '\n';
    restoreWorkspace({ ...state, documents: [{ ...a, source: differentlySpaced }] });
    assert.equal(
      imports.get(differentlySpaced),
      1,
      'Even equivalent JSON has a distinct source key.',
    );
    restoreWorkspace(state);
    assert.equal(
      imports.get(a.source),
      1,
      'Rejected source cannot poison the earlier valid entry.',
    );
  } finally {
    parse.mock.restore();
  }
});

test('reused recovery metadata retains explicit example identity and filename', () => {
  const manifest = createRequire(import.meta.url)('./fixtures/kicad/manifest.json');
  const example = manifest.examples[0];
  const project = createProject();
  project.name = example.title;
  project.schematic.title = 'Independent schematic';
  project.extensions['org.openpe.example'] = { id: example.id };
  const a = {
    ...document('Inferred example'),
    source: serializeProject(project),
    filename: `${example.id}.kicad_pro`,
  };
  const state = {
    version: 2,
    documents: [a],
    activeDocumentId: a.id,
    ...defaultAgentPreferences,
  };
  for (let repeat = 0; repeat < 2; repeat++) {
    const recovered = restoreWorkspace(state).documents[0];
    assert.equal(recovered.exampleKey, undefined);
    assert.equal(recovered.filename, `${example.id}.kicad_pro`);
    const explicit = restoreWorkspace({
      ...state,
      documents: [{ ...a, exampleKey: null, filename: 'User filename.kicad_pro' }],
    }).documents[0];
    assert.equal(explicit.exampleKey, null);
    assert.equal(explicit.filename, 'User filename.kicad_pro');
  }
});

test('recovery metadata reuse evicts old sources by entry count and retained character budget', () => {
  const a = document('Bounded recovery cache');
  const restore = (doc: DocumentState) =>
    restoreWorkspace({
      version: 2,
      documents: [doc],
      activeDocumentId: doc.id,
      ...defaultAgentPreferences,
    });
  const originalParse = JSON.parse;
  let targetImports = 0;
  const parse = mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    if (args[0] === a.source) targetImports++;
    return originalParse(...args);
  });
  try {
    restore(a);
    restore(a);
    assert.equal(targetImports, 1);
    for (let index = 0; index < 24; index++) restore(document(`Other cached source ${index}`));
    restore(a);
    assert.equal(targetImports, 2, 'Old metadata is evicted when the entry budget is exceeded.');
    for (let index = 0; index < 9; index++)
      restore({ ...a, source: a.source + ' '.repeat(1_000_000 + index) });
    restore(a);
    assert.equal(
      targetImports,
      3,
      'Large exact source keys evict old entries below the count limit.',
    );
  } finally {
    parse.mock.restore();
  }
});

test('native grants isolate destinations, deduplicate opens and reject cross-project overwrites', () => {
  const grants = new FileGrants();
  const a = grants.create(path.resolve('a.kicad_pro'));
  const b = grants.create();
  assert.notEqual(a, b);
  assert.equal(grants.get(b), null);
  assert.equal(grants.create(path.resolve('a.kicad_pro')), a);
  assert.throws(() => grants.get(path.resolve('a.kicad_pro')));
  assert.throws(() => grants.assign(b, path.resolve('a.kicad_pro')));
  grants.assign(b, path.resolve('b.kicad_pro'));
  assert.equal(grants.get(a), path.resolve('a.kicad_pro'));
  grants.release(a);
  assert.throws(() => grants.get(a));
  assert.equal(grants.get(b), path.resolve('b.kicad_pro'));
  const recovered = grants.create();
  assert.equal(grants.get(recovered), null, 'Recovery never restores a filesystem grant.');
  grants.clear();
  assert.throws(() => grants.get(b), 'Renderer reload revokes old grants.');
  assert.equal(grants.get(grants.create()), null);
});
test('repeated imports reuse their editor without granting writes to the source', () => {
  const grants = new FileGrants();
  const source = path.resolve('import.kicad_sch');
  const id = grants.createImport(source);
  assert.equal(grants.createImport(source), id);
  assert.equal(grants.findOpen(source), id);
  assert.equal(grants.get(id), null);
  assert.equal(grants.find(source), undefined);
  grants.assign(id, path.resolve('import.kicad_pro'));
  assert.equal(grants.findOpen(source), id);
  assert.equal(grants.findOpen(path.resolve('import.kicad_pro')), id);
  grants.release(id);
  assert.equal(grants.findOpen(source), undefined);
  const reopened = grants.createImport(source);
  assert.notEqual(reopened, id);
  grants.clear();
  assert.equal(grants.findOpen(source), undefined);
});

test('reveal locations use live grants and follow Save as without granting imported-source writes', () => {
  const grants = new FileGrants();
  const original = path.resolve('source.kicad_sch');
  const id = grants.createImport(original);
  assert.equal(grants.location(id), original);
  assert.equal(grants.get(id), null);
  assert.equal(grants.location(grants.create()), null);
  assert.throws(() => grants.location(original), /no file access grant/);
  assert.throws(() => grants.location({ path: original }), /no file access grant/);
  const saved = path.resolve('saved.kicad_pro');
  grants.assign(id, saved);
  assert.equal(grants.location(id), saved);
  const moved = path.resolve('saved-as.kicad_pro');
  grants.assign(id, moved);
  assert.equal(grants.location(id), moved);
  grants.release(id);
  assert.throws(() => grants.location(id), /no file access grant/);
  const reopened = grants.createImport(original);
  grants.clear();
  assert.throws(() => grants.location(reopened), /no file access grant/);
});

test('grant cleanup tolerates retries and revoked IDs without weakening save authorization', () => {
  const grants = new FileGrants();
  const untitled = grants.create();
  const savedPath = path.resolve('still-open.kicad_pro');
  const saved = grants.create(savedPath);
  grants.release(untitled);
  assert.doesNotThrow(() => grants.release(untitled), 'Repeated close cleanup is harmless.');
  assert.doesNotThrow(() => grants.release('missing-grant'));
  assert.throws(() => grants.release(null), /Invalid file access grant/);
  assert.equal(grants.get(saved), savedPath, 'Other projects retain their destinations.');
  assert.throws(() => grants.get(untitled), /no file access grant/);
  assert.throws(() => grants.assign(untitled, savedPath), /no file access grant/);
  grants.clear();
  const recovered = grants.create();
  assert.doesNotThrow(() => grants.release(saved), 'Late cleanup after reload can finish.');
  assert.equal(grants.get(recovered), null);
  assert.throws(() => grants.get(saved), /no file access grant/);
});

test('multi-project recovery validates every project before atomic writes and removes only the closed project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-workspace-'));
  const service = await startServer({ dataDir: dir });
  const headers = {
    'X-OpenPE-Token': service.token,
    'Content-Type': 'application/json',
  };
  const a = document('A'),
    b = document('B');
  a.sourceDraft = '{unfinished';
  const state = {
    version: 2,
    documents: [a, b],
    activeDocumentId: a.id,
    ...defaultAgentPreferences,
  };
  const post = (value: unknown) =>
    fetch(service.base + '/api/state', {
      method: 'POST',
      headers,
      body: JSON.stringify(value),
    });
  try {
    assert.equal((await post(state)).status, 200);
    const saved = await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8');
    assert.equal((await post({ ...state, documents: [a, { ...b, source: '{}' }] })).status, 400);
    assert.equal(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8'), saved);
    const remaining = { ...state, documents: [b], activeDocumentId: b.id };
    assert.equal((await post(remaining)).status, 200);
    assert.deepEqual(
      await (await fetch(service.base + '/api/state', { headers })).json(),
      remaining,
    );
  } finally {
    await service.close();
  }
});
