import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceExample, referenceExamples } from '../lib/reference-examples';
import { projectExamples } from '../lib/examples';
import { defaultExamples } from '../lib/default-examples';
import { homeExampleCatalog, homeExamples, homeRecent } from '../lib/home-examples';
import { validExampleKey } from '../lib/workspace-example';
import { parseProject, serializeProject } from '../lib/project';
import { createSession } from '../lib/chat-sessions';
import { defaultAgentPreferences, restoreWorkspace } from '../lib/workspace-state';
import { restoreWorkspace as restoreServiceWorkspace } from '../server/workspace-format.mjs';

test('Home retains nine Reference examples and prepares fixed Recent EMC separately', () => {
  assert.equal(referenceExamples.length, 9);
  assert.equal(new Set(referenceExamples.map((entry) => entry.id)).size, 9);
  assert.equal(
    new Set(referenceExamples.map((entry) => entry.modelId)).size,
    9,
    'Home examples use nine distinct controller models.',
  );
  assert.ok(referenceExamples.some((entry) => entry.id === 'reference-lm2598-to220-7-buck'));
  assert.equal(
    referenceExamples.filter((entry) => entry.modelId === 'reference-lm2735y').length,
    1,
  );
  assert.deepEqual(
    homeExamples.map((entry) => entry.id),
    referenceExamples.map((entry) => entry.id),
    'Examples retain all original Reference entries and their order.',
  );
  assert.deepEqual(
    homeRecent.map((entry) => entry.id),
    ['emc-flyback-demo'],
  );
  assert.equal(new Set(homeExampleCatalog.map((entry) => entry.id)).size, 10);
  const defaults = defaultExamples();
  const restartedDefaults = defaultExamples();
  assert.equal(defaults.length, 10);
  assert.deepEqual(
    defaults.map((entry) => [entry.key, entry.name]),
    homeExampleCatalog.map((entry) => [`example:${entry.id}`, entry.title]),
  );
  for (const entry of defaults) {
    assert.equal(
      entry.createSource(),
      restartedDefaults.find((item) => item.key === entry.key)!.createSource(),
      'Managed template UUIDs and serialized bytes stay stable across process factories.',
    );
    const project = parseProject(entry.createSource());
    assert.equal(project.name, entry.name);
    assert.ok(project.schematic.parts.length > 0, entry.key);
    assert.ok(project.pcb && project.pcb.footprints.length > 0, entry.key);
    assert.ok(project.pcb.tracks.length > 0, entry.key);
    assert.ok(validExampleKey(entry.key));
    assert.equal(
      serializeProject(parseProject(serializeProject(project))),
      serializeProject(project),
    );
  }
  assert.equal(defaults[0].key, 'example:emc-flyback-demo');
  assert.ok(defaults.slice(1).every((entry) => entry.key.startsWith('example:reference-')));
});

test('removed catalog identities fail recovery without detaching or rewriting the project', () => {
  const removedId = 'reference-removed-template';
  const key = `example:${removedId}`;
  const project = createReferenceExample(referenceExamples[0].id);
  project.extensions['org.openpe.reference-example'] = { id: removedId };
  const source = serializeProject(project);
  assert.equal(validExampleKey(key), false);
  assert.equal(
    defaultExamples().some((entry) => entry.key === key),
    false,
  );
  for (const dirty of [false, true]) {
    const session = createSession('Keep project conversation');
    session.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      text: 'Inspect this saved design.',
    });
    const id = crypto.randomUUID();
    const sourceDraft = dirty ? '{unfinished source' : null;
    const saved = {
      version: 2,
      documents: [
        {
          id,
          source,
          sourceDraft,
          dirty,
          exampleKey: key,
          filename: 'project.kicad_pro',
          localExample: true,
          sessions: [session],
          activeSessionId: session.id,
        },
      ],
      activeDocumentId: id,
      ...defaultAgentPreferences,
    };
    const before = structuredClone(saved);
    assert.throws(() => restoreWorkspace(saved), /Invalid example opening identity/);
    assert.throws(() => restoreServiceWorkspace(saved), /Invalid example opening identity/);
    assert.deepEqual(saved, before);
    assert.throws(
      () =>
        restoreWorkspace({
          ...saved,
          documents: [{ ...saved.documents[0], exampleKey: 'example:unrelated' }],
        }),
      /Invalid example opening identity/,
    );
  }
});

test('Reference recovery keeps complete boards and pending source with explicit current identity', () => {
  const entry = referenceExamples[0];
  const project = createReferenceExample(entry.id);
  const session = createSession('Keep this project conversation');
  const doc = {
    id: crypto.randomUUID(),
    source: serializeProject(project),
    sourceDraft: '{unfinished',
    dirty: false,
    filename: 'project.kicad_pro',
    exampleKey: `example:${entry.id}`,
    localExample: true,
    sessions: [session],
    activeSessionId: session.id,
  };
  const state = {
    version: 2,
    documents: [doc],
    activeDocumentId: doc.id,
    ...defaultAgentPreferences,
  };
  const recovered = restoreWorkspace(state).documents[0];
  assert.equal(recovered.exampleKey, `example:${entry.id}`);
  assert.equal(recovered.sourceDraft, doc.sourceDraft);
  assert.equal(recovered.source, doc.source);
  assert.equal(recovered.dirty, false);
  assert.deepEqual(parseProject(recovered.source).pcb, project.pcb);
  for (const previous of projectExamples) {
    assert.equal(validExampleKey(`example:${previous.id}`), false);
  }
  assert.equal(validExampleKey('example:unknown'), false);
});
