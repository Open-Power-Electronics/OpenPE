import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspacePresentation } from '../components/WorkspacePresentation';
import type { ProjectNavigationItem } from '../components/ProjectNavigation';

test('pin and unpin notify navigation immediately even when project order and content stay unchanged', () => {
  const store = createWorkspacePresentation();
  const projects: ProjectNavigationItem[] = [
    { id: 'a', title: 'A', unsaved: false, sessions: [{ id: 'chat-a', title: 'A chat' }] },
    { id: 'b', title: 'B', unsaved: false, sessions: [{ id: 'chat-b', title: 'B chat' }] },
  ];
  store.publishProjects(projects);
  const seen: (true | undefined)[] = [];
  const unsubscribe = store.subscribeProjects(() => seen.push(store.getProjects()[0].pinned));
  const initial = store.getProjects();
  for (let attempt = 0; attempt < 3; attempt++) {
    store.publishProjects([{ ...projects[0], pinned: true }, projects[1]]);
    assert.equal(store.getProjects()[0].pinned, true);
    store.publishProjects(projects);
    assert.equal(store.getProjects()[0].pinned, undefined);
  }
  assert.deepEqual(seen, [true, undefined, true, undefined, true, undefined]);
  assert.deepEqual(store.getProjects(), initial);
  const unchanged = store.getProjects();
  store.publishProjects(structuredClone(projects));
  assert.equal(store.getProjects(), unchanged, 'Unchanged metadata retains the snapshot.');
  assert.equal(seen.length, 6);
  unsubscribe();
  store.publishProjects([{ ...projects[0], pinned: true }, projects[1]]);
  assert.equal(seen.length, 6, 'Detached subscriptions stop receiving changes.');
});

test('replacing a presentation cache republishes current pins and status without mutating document metadata', () => {
  const previous = createWorkspacePresentation();
  const input: ProjectNavigationItem[] = [
    {
      id: 'a',
      title: 'A',
      unsaved: true,
      pinned: true,
      sessions: [{ id: 'chat-a', title: 'Draft', pinned: true, archived: true }],
    },
  ];
  const expected = structuredClone(input);
  previous.publishProjects(input);
  previous.publishDraftStatus('Draft save failed');
  const current = createWorkspacePresentation();
  current.publishProjects(previous.getProjects());
  current.publishDraftStatus(previous.getDraftStatus());
  assert.deepEqual(current.getProjects(), expected);
  assert.equal(current.getDraftStatus(), 'Draft save failed');
  input[0].pinned = undefined;
  input[0].sessions![0].title = 'Changed outside the cache';
  assert.deepEqual(previous.getProjects(), expected);
  assert.deepEqual(current.getProjects(), expected);
  assert.notEqual(current.getProjects(), previous.getProjects());
  assert.ok(Object.isFrozen(current.getProjects()[0].sessions));
  assert.deepEqual(expected[0].sessions, [
    { id: 'chat-a', title: 'Draft', pinned: true, archived: true },
  ]);
});
