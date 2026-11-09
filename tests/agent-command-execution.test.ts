import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { createProject, projectFromNativeFiles } from '../lib/project';
import { switchingStageFixture } from './fixtures/switching-stage';
import { registerLibraryCapabilities } from '../lib/library-capabilities';
import { registerWorkbenchCapabilities } from '../lib/workbench-capabilities';
import { partFields } from '../lib/library';
import { parseSExpr } from '../lib/sexpr';
import {
  agentCapabilitiesForHost,
  resolveAgentCapability,
  type AgentCapabilityRequest,
  type AgentCommandReview,
} from '../lib/chat-stream';

function fixture() {
  const project = createProject(switchingStageFixture());
  const core = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  registerProjectCapabilities(host, core);
  const runtime = agentCapabilitiesForHost(host);
  const partId = project.schematic.parts.find((part) => part.ref === 'R1')!.id;
  const input = (value: string) => ({ schematicId: project.schematic.id, partId, value });
  const request = (name: string, input: unknown): AgentCapabilityRequest => ({
    type: 'capability-request',
    runId: 'run',
    sessionId: 'session',
    requestId: 'request',
    token: 'token',
    tool: 'openpe_execute',
    arguments: { name, input },
  });
  const execute = (value: string) =>
    resolveAgentCapability(request('part.properties', input(value)), runtime, 'auto', () =>
      assert.fail(),
    );
  return { project, core, host, runtime, input, request, execute };
}

test('Review executes presentation commands and queries but holds design and file changes', async () => {
  const f = fixture();
  let selection: string[] = [];
  let view = '';
  let saves = 0;
  const remove = registerWorkbenchCapabilities(f.host, () => ({
    revision: () => String(f.core.getSnapshot().revision),
    state: () => ({}),
    view: (next: string) => {
      view = next;
      return true;
    },
    sheet: () => {},
    selection: (ids: string[]) => {
      selection = ids;
    },
    panel: () => {},
    save: async () => {
      saves++;
      return 'saved';
    },
    export: async () => 'exported',
    historyList: async () => [],
    historyRead: async () => '',
    historyCreate: async () => ({}),
    simulation: async () => ({}),
  }));
  const reviews: AgentCommandReview[] = [];
  const resolve = (name: string, input = {}) =>
    resolveAgentCapability(f.request(name, input), f.runtime, 'review', (command) =>
      reviews.push(command),
    );
  try {
    const before = f.core.getSnapshot();
    await resolve('workbench.view', { view: 'layout' });
    await resolve('workbench.selection', { ids: [f.input('').partId] });
    await resolve('workbench.panel', { panel: 'parts' });
    await resolve('simulation.show');
    await resolveAgentCapability(
      { ...f.request('core.state', {}), tool: 'openpe_query' },
      f.runtime,
      'review',
      () => assert.fail(),
    );
    assert.equal(view, 'layout');
    assert.deepEqual(selection, [f.input('').partId]);
    assert.equal(reviews.length, 0);
    assert.equal(f.core.getSnapshot().project, before.project);
    for (const [name, input] of [
      ['part.properties', f.input('47k')],
      ['source.update', { draft: '{invalid Source' }],
      ['project.save', {}],
    ] as const) {
      assert.equal(((await resolve(name, input)) as { status: string }).status, 'review-required');
    }
    assert.deepEqual(
      reviews.map((command) => command.name),
      ['part.properties', 'source.update', 'project.save'],
    );
    assert.equal(f.core.getSnapshot().project, before.project);
    assert.equal(f.core.getSnapshot().sourceDraft, null);
    assert.equal(saves, 0);
    await assert.rejects(resolve('missing.command'), /not registered/);
    await assert.rejects(resolve('history.undo'), /no edit to undo/);
    assert.equal(reviews.length, 3);
  } finally {
    remove();
    f.host.dispose();
  }
});

test('Auto edits use current project data without a prior observation or revision token', async () => {
  const f = fixture();
  try {
    await f.host.execute('part.properties', f.input('22k'));
    await f.execute('47k');
    await f.host.execute('part.properties', { ...f.input('68k'), reference: 'R2' });
    await f.execute('100k');
    const part = f.core
      .getSnapshot()
      .project!.schematic.parts.find((part) => part.id === f.input('').partId)!;
    assert.equal(part.value, '100k');
    assert.equal(part.ref, 'R2', 'An Agent value edit preserves newer unrelated properties.');
    assert.equal(f.core.getSnapshot().undoDepth, 4);
    f.core.undo();
    assert.equal(
      f.core.getSnapshot().project!.schematic.parts.find((part) => part.id === f.input('').partId)!
        .value,
      '68k',
    );
  } finally {
    f.host.dispose();
  }
});

test('manual review retains exact arguments and applies to the latest project state', async () => {
  const f = fixture();
  try {
    const reviews: AgentCommandReview[] = [];
    const args = f.input('47k');
    await resolveAgentCapability(
      f.request('part.properties', args),
      f.runtime,
      'review',
      (command) => reviews.push(command),
    );
    args.value = 'discarded caller change';
    await f.host.execute('part.properties', { ...f.input('22k'), reference: 'R2' });
    assert.equal(f.core.getSnapshot().undoDepth, 1);
    await f.runtime.execute(reviews[0].name, reviews[0].input);
    const part = f.core
      .getSnapshot()
      .project!.schematic.parts.find((part) => part.id === args.partId)!;
    assert.equal(part.value, '47k');
    assert.equal(part.ref, 'R2');
    assert.equal(f.core.getSnapshot().undoDepth, 2);
  } finally {
    f.host.dispose();
  }
});

test('latest-state dispatch still rejects pending Source, missing targets, closure and cancellation', async () => {
  const f = fixture();
  try {
    f.core.updateSource('{invalid source');
    await assert.rejects(f.execute('47k'), /Source/);
    f.core.discardSource();
    await assert.rejects(async () =>
      f.runtime.execute('part.properties', { ...f.input('47k'), partId: 'missing' }),
    );
    const control = new AbortController();
    control.abort();
    await assert.rejects(
      async () => f.runtime.execute('part.properties', f.input('47k'), { signal: control.signal }),
      { name: 'AbortError' },
    );
    f.host.suspend('Closing project');
    await assert.rejects(f.execute('47k'), /Closing project/);
  } finally {
    f.host.dispose();
  }
});

test('overlapping asynchronous footprint edits run in order on current data, preserving native files and undo', async () => {
  const f = fixture();
  const previousWindow = (globalThis as any).window,
    previousFetch = globalThis.fetch;
  const libraryId = 'Fixture:TwoPin';
  const detail = {
    id: libraryId,
    footprint: parseSExpr(
      '(footprint "TwoPin" (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")) (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))',
    ),
  };
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://127.0.0.1:1', token: 'fixture' }) },
  };
  let release!: () => void,
    started!: () => void,
    calls = 0;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/libraries\/footprints\?id=Fixture%3ATwoPin/);
    if (++calls === 1) {
      started();
      await waiting;
    }
    return Response.json(detail);
  };
  const unregister = registerLibraryCapabilities(f.host, f.core);
  try {
    const baseline = f.core.getNativeFiles();
    const parts = f.project.schematic.parts.filter((part) => ['R1', 'C1'].includes(part.ref));
    assert.equal(parts.length, 2);
    const assign = (partId: string, signal?: AbortSignal) =>
      resolveAgentCapability(
        f.request('part.footprint', {
          schematicId: f.project.schematic.id,
          partId,
          libraryId,
        }),
        f.runtime,
        'auto',
        () => assert.fail(),
        signal,
      );
    const first = assign(parts[0].id);
    await loading;
    const cancelled = new AbortController();
    const skipped = assign(parts[1].id, cancelled.signal);
    const second = assign(parts[1].id);
    cancelled.abort();
    const cancellation = assert.rejects(skipped, { name: 'AbortError' });
    assert.equal(
      calls,
      1,
      'Only the first document edit prepares against Core while it is pending.',
    );
    release();
    await Promise.all([first, second, cancellation]);
    assert.equal(calls, 2, 'A cancelled queued edit never reaches the host or library.');
    assert.equal(f.core.getSnapshot().undoDepth, 2);
    const reopened = projectFromNativeFiles(f.core.getNativeFiles());
    for (const part of parts)
      assert.equal(
        partFields(reopened.schematic.parts.find((p) => p.id === part.id)!).Footprint,
        libraryId,
      );
    f.core.undo();
    f.core.undo();
    assert.deepEqual(f.core.getNativeFiles(), baseline);
  } finally {
    release();
    unregister();
    f.host.dispose();
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
  }
});

test('session Stop bypasses a pending document edit and failed edits do not poison the queue', async () => {
  const host = createCapabilityHost();
  let release!: () => void;
  host.register({
    id: 'fixture.edit',
    kind: 'command',
    owner: 'core',
    mutation: 'document',
    description: 'Hold a document edit until Stop releases it.',
    inputSchema: {},
    handler: () =>
      new Promise((resolve) => {
        release = () => resolve({});
      }),
  });
  host.register({
    id: 'fixture.stop',
    kind: 'command',
    owner: 'plugin',
    plugin: 'fixture',
    mutation: 'session',
    description: 'Release the pending test document edit.',
    inputSchema: {},
    handler: () => {
      release();
      return { stopped: true };
    },
  });
  host.register({
    id: 'fixture.fail',
    kind: 'command',
    owner: 'core',
    mutation: 'document',
    description: 'Reject a document edit.',
    inputSchema: {},
    handler: () => {
      throw new Error('Rejected edit');
    },
  });
  const runtime = agentCapabilitiesForHost(host);
  try {
    const edit = runtime.execute('fixture.edit');
    await Promise.resolve();
    assert.deepEqual(await runtime.execute('fixture.stop'), { stopped: true });
    await edit;
    await assert.rejects(async () => runtime.execute('fixture.fail'), /Rejected edit/);
    const retry = runtime.execute('fixture.edit');
    await Promise.resolve();
    await runtime.execute('fixture.stop');
    await retry;
    assert.deepEqual(await runtime.execute('fixture.stop'), { stopped: true });
  } finally {
    host.dispose();
  }
});
