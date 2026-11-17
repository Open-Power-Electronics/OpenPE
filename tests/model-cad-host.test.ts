import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { emptyCircuit } from '../lib/circuit';
import {
  MODEL_CAD_NATIVE_VARIABLE,
  modelCadFromProject,
  modelCadGeometryKey,
  newModelCadObject,
  type ModelCadObject,
} from '../lib/model-cad';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject } from '../lib/project';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function setup(
  prepare?: (
    core: ProjectCore,
    objects: readonly ModelCadObject[],
    signal: AbortSignal,
  ) => Promise<void>,
) {
  const project = createProject(emptyCircuit());
  project.pcb = createEmptyPCB();
  const core = new ProjectCore(project),
    host = createCapabilityHost();
  const dispose = registerProjectCapabilities(
    host,
    core,
    prepare
      ? {
          prepareModelCad: (objects, signal) => prepare(core, objects, signal),
        }
      : {},
  );
  const boardId = project.pcb.id;
  return {
    core,
    host,
    boardId,
    object: newModelCadObject(project.pcb, 'extrusion'),
    close: () => {
      dispose();
      host.dispose();
    },
  };
}
function admit(core: ProjectCore, objects: readonly ModelCadObject[]) {
  for (const object of objects)
    core.acceptPreparedModelCadGeometry(object, modelCadGeometryKey(object));
}
function nativeDraft(core: ProjectCore, object: ModelCadObject) {
  const file = core.getNativeFiles().files.find((item) => item.name.endsWith('.kicad_pro'))!;
  const settings = JSON.parse(file.source);
  (settings.text_variables ??= {})[MODEL_CAD_NATIVE_VARIABLE] = JSON.stringify({
    version: 1,
    objects: [object],
  });
  const source = JSON.stringify(settings, null, 2) + '\n';
  core.updateNativeSource(file.name, source);
  return { name: file.name, source };
}

test('host awaits exact CAD preparation and publishes one immutable undo transaction', async () => {
  const waiting = gate();
  let captured: readonly ModelCadObject[] = [];
  const fixture = setup(async (core, objects) => {
    captured = objects;
    await waiting.promise;
    admit(core, objects);
  });
  const { core, host, boardId, object } = fixture,
    before = core.getSnapshot();
  const submitted = structuredClone(object);
  try {
    const request = host.execute(
      'modelCad.add',
      { boardId, object },
      { actor: 'agent', expectedRevision: String(before.revision) },
    );
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], submitted);
    assert.equal(core.getSnapshot(), before, 'No optimistic document or undo publication');
    object.size.z += 7;
    waiting.resolve();
    const result = (await request) as { object: ModelCadObject };
    assert.deepEqual(
      result.object,
      submitted,
      'Commit uses the exact independently captured candidate',
    );
    const after = core.getSnapshot();
    assert.equal(after.undoDepth, before.undoDepth + 1);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(modelCadFromProject(after.project!)!.objects, [submitted]);
    core.undo();
    assert.equal(modelCadFromProject(core.getSnapshot().project!), null);
    core.redo();
    assert.deepEqual(modelCadFromProject(core.getSnapshot().project!)!.objects, [submitted]);
  } finally {
    fixture.close();
  }
});

test('host rejects missing, failed and unproved kernel preparation without document edits', async () => {
  const missing = setup();
  try {
    const before = missing.core.getSnapshot();
    await assert.rejects(
      missing.host.execute('modelCad.add', { boardId: missing.boardId, object: missing.object }),
      /kernel is unavailable/,
    );
    assert.equal(missing.core.getSnapshot(), before);
  } finally {
    missing.close();
  }
  for (const failure of ['throw', 'no-proof'] as const) {
    let attempts = 0;
    const fixture = setup(async (core, objects) => {
      attempts++;
      if (attempts === 1) {
        if (failure === 'throw') throw new Error('The CAD operation produced no solid.');
        return;
      }
      admit(core, objects);
    });
    try {
      const before = fixture.core.getSnapshot(),
        input = { boardId: fixture.boardId, object: fixture.object };
      await assert.rejects(
        fixture.host.execute('modelCad.add', input),
        failure === 'throw' ? /produced no solid/ : /Prepare CAD geometry/,
      );
      assert.equal(fixture.core.getSnapshot(), before);
      await fixture.host.execute('modelCad.add', input);
      assert.equal(fixture.core.getSnapshot().undoDepth, 1, 'A failed attempt remains retryable');
    } finally {
      fixture.close();
    }
  }
});

test('cancelling or unregistering a preparing CAD command blocks late commits', async () => {
  for (const action of ['abort', 'unregister'] as const) {
    const waiting = gate();
    let preparationSignal!: AbortSignal;
    const fixture = setup(async (_core, _objects, signal) => {
      preparationSignal = signal;
      await waiting.promise;
      signal.throwIfAborted();
    });
    const before = fixture.core.getSnapshot(),
      control = new AbortController();
    try {
      const result = assert.rejects(
        fixture.host.execute(
          'modelCad.add',
          { boardId: fixture.boardId, object: fixture.object },
          { signal: control.signal },
        ),
        /abort|cancel/i,
      );
      if (action === 'abort') control.abort();
      else fixture.close();
      assert.equal(preparationSignal.aborted, true);
      waiting.resolve();
      await result;
      assert.equal(fixture.core.getSnapshot(), before);
    } finally {
      fixture.close();
    }
  }
});

test('CAD preparation rechecks revision, pending Source and close barriers before committing', async () => {
  for (const change of ['revision', 'source', 'closing'] as const) {
    const waiting = gate();
    const fixture = setup(async (core, objects) => {
      admit(core, objects);
      await waiting.promise;
    });
    const { core, host, boardId, object } = fixture;
    try {
      const result = assert.rejects(
        host.execute('modelCad.add', { boardId, object }),
        /project changed/,
      );
      if (change === 'revision') {
        const primitive = newModelCadObject(core.getSnapshot().project!.pcb!, 'box');
        core.execute('modelCad.add', { boardId, object: primitive });
      } else if (change === 'source') core.updateSource('{ pending native source');
      else core.setEditingBlocked('Project is closing.');
      const changed = core.getSnapshot();
      waiting.resolve();
      await result;
      assert.equal(
        core.getSnapshot(),
        changed,
        'The failed preparation cannot overwrite newer state',
      );
      assert.ok(
        !(modelCadFromProject(core.getSnapshot().project!)?.objects ?? []).some(
          (item) => item.id === object.id,
        ),
      );
    } finally {
      fixture.close();
    }
  }
});

test('explicit stale revisions cannot enter CAD preparation even without host revision wiring', async () => {
  let preparations = 0;
  const fixture = setup(async (core, objects) => {
    preparations++;
    admit(core, objects);
  });
  try {
    const initial = fixture.core.getSnapshot();
    fixture.core.execute('modelCad.add', {
      boardId: fixture.boardId,
      object: newModelCadObject(initial.project!.pcb!, 'box'),
    });
    const current = fixture.core.getSnapshot();
    await assert.rejects(
      fixture.host.execute(
        'modelCad.add',
        { boardId: fixture.boardId, object: fixture.object },
        { expectedRevision: String(initial.revision) },
      ),
      /project changed/,
    );
    assert.equal(fixture.core.getSnapshot(), current);
    assert.equal(preparations, 0, 'Stale commands do not start native work');
  } finally {
    fixture.close();
  }
});

test('actual native project Source retains its draft until exact CAD preparation succeeds', async () => {
  let attempts = 0;
  const fixture = setup(async (core, objects) => {
    attempts++;
    if (attempts === 1) throw new Error('CAD kernel rejected this operation.');
    admit(core, objects);
  });
  try {
    const draft = nativeDraft(fixture.core, fixture.object),
      before = fixture.core.getSnapshot();
    await assert.rejects(fixture.host.execute('source.apply'), /rejected/);
    assert.equal(fixture.core.getSnapshot(), before);
    assert.equal(
      fixture.core.getNativeFiles().files.find((file) => file.name === draft.name)!.source,
      draft.source,
    );
    assert.ok(fixture.core.getSnapshot().sourceDraft);
    await fixture.host.execute('source.apply');
    assert.equal(fixture.core.getSnapshot().sourceDraft, null);
    assert.equal(fixture.core.getSnapshot().undoDepth, 1);
    assert.deepEqual(modelCadFromProject(fixture.core.getSnapshot().project!)!.objects, [
      fixture.object,
    ]);
    fixture.core.undo();
    assert.equal(modelCadFromProject(fixture.core.getSnapshot().project!), null);
  } finally {
    fixture.close();
  }
});

test('changing a native Source draft while CAD prepares preserves the newer draft', async () => {
  const waiting = gate();
  const fixture = setup(async (core, objects) => {
    admit(core, objects);
    await waiting.promise;
  });
  try {
    const draft = nativeDraft(fixture.core, fixture.object);
    const result = assert.rejects(fixture.host.execute('source.apply'), /project changed/);
    const settings = JSON.parse(draft.source);
    settings.text_variables.NOTE = 'newer source edit';
    const replacement = JSON.stringify(settings, null, 2) + '\n';
    fixture.core.updateNativeSource(draft.name, replacement);
    const current = fixture.core.getSnapshot();
    waiting.resolve();
    await result;
    assert.equal(fixture.core.getSnapshot(), current);
    assert.equal(
      fixture.core.getNativeFiles().files.find((file) => file.name === draft.name)!.source,
      replacement,
    );
    assert.equal(current.undoDepth, 0);
  } finally {
    fixture.close();
  }
});

test('invalid native Source apply retains its draft and publishes Core diagnostics', async () => {
  let preparations = 0;
  const fixture = setup(async () => {
    preparations++;
  });
  try {
    const file = fixture.core
      .getNativeFiles()
      .files.find((item) => item.name.endsWith('.kicad_pro'))!;
    fixture.core.updateNativeSource(file.name, '{ invalid native project');
    const before = fixture.core.getSnapshot(),
      events: string[] = [];
    const unsubscribe = fixture.core.subscribe((event) => events.push(event.type));
    await assert.rejects(
      fixture.host.execute('source.apply'),
      /JSON|native|parse|property|syntax/i,
    );
    const after = fixture.core.getSnapshot();
    assert.equal(after.project, before.project);
    assert.equal(after.sourceDraft, before.sourceDraft);
    assert.equal(after.undoDepth, 0);
    assert.ok(after.sourceError);
    assert.ok(events.includes('source.error'));
    assert.equal(preparations, 0);
    unsubscribe();
  } finally {
    fixture.close();
  }
});
