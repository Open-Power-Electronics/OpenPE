import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { emptyCircuit, uid } from '../lib/circuit';
import { createProject } from '../lib/project';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { RuleCheckResult } from '../lib/design-rule-checks';

function fixture() {
  const circuit = emptyCircuit();
  circuit.wires.push({ id: uid(), a: { x: 0, y: 0 }, b: { x: 5.08, y: 0 } });
  const project = createProject(circuit);
  project.additionalSchematics = [emptyCircuit()];
  project.pcb = createEmptyPCB();
  project.pcb.nets = [{ id: uid(), name: 'TEST' }];
  project.pcb.tracks.push({
    id: uid(),
    netId: project.pcb.nets[0].id,
    layer: 'F.Cu',
    width: 0.1,
    start: { x: 5, y: 5 },
    end: { x: 10, y: 5 },
  });
  return new ProjectCore(project);
}

test('human and Agent rule queries return the same read-only report for their explicit sheet/board', async () => {
  const core = fixture();
  const snapshot = core.getSnapshot();
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, core);
  const events: unknown[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));
  try {
    const schematicId = snapshot.project!.schematic.id;
    const direct = (await core.query('schematic.erc', { schematicId })) as RuleCheckResult;
    const agent = await host.query('schematic.erc', { schematicId }, { actor: 'agent' });
    assert.deepEqual(agent, direct);
    assert.equal((agent as Record<string, unknown>).revision, String(snapshot.revision));
    assert.equal((agent as Record<string, unknown>).schematicId, schematicId);
    assert.ok(direct.issues.some((issue) => issue.ruleId === 'erc.wire-dangling'));
    const other = (await host.query('schematic.erc', {
      schematicId: snapshot.project!.additionalSchematics![0].id,
    })) as RuleCheckResult;
    assert.deepEqual(other.issues, []);
    const boardId = snapshot.project!.pcb!.id;
    const drc = (await host.query('layout.drc', { boardId })) as RuleCheckResult;
    assert.equal((drc as unknown as Record<string, unknown>).boardId, boardId);
    assert.ok(drc.issues.some((issue) => issue.ruleId === 'pcb.track-width'));
    const changed = (await host.query('layout.drc', {
      boardId,
      settings: { minTrackWidth: 0 },
    })) as RuleCheckResult;
    assert.ok(!changed.issues.some((issue) => issue.ruleId === 'pcb.track-width'));
    assert.equal(core.getSnapshot(), snapshot);
    assert.deepEqual(events, []);
    assert.equal(snapshot.undoDepth, 0);
    assert.deepEqual(
      host
        .catalog()
        .filter((entry) => ['schematic.erc', 'layout.drc'].includes(entry.id))
        .map((entry) => entry.id)
        .sort(),
      ['layout.drc', 'schematic.erc'],
    );
    assert.ok(
      host
        .catalog()
        .filter((entry) => ['schematic.erc', 'layout.drc'].includes(entry.id))
        .every((entry) => entry.kind === 'query' && entry.owner === 'core' && !entry.mutation),
    );
  } finally {
    unsubscribe();
    dispose();
    host.dispose();
  }
});

test('rule queries reject pending Source, closed documents, wrong targets and malformed thresholds', async () => {
  const core = fixture();
  const project = core.getSnapshot().project!;
  const host = createCapabilityHost();
  const dispose = registerProjectCapabilities(host, core);
  try {
    await assert.rejects(host.query('schematic.erc', { schematicId: uid() }), /no longer/);
    await assert.rejects(host.query('layout.drc', { boardId: uid() }), /no longer/);
    for (const settings of [
      { clearance: -1 },
      { extra: 1 },
      { minViaDrill: '0.3' },
      { clearance: 1001 },
    ])
      await assert.rejects(host.query('layout.drc', { boardId: project.pcb!.id, settings }));
    core.updateSource('{pending');
    await assert.rejects(
      host.query('schematic.erc', { schematicId: project.schematic.id }),
      /Apply the Source/,
    );
    await assert.rejects(
      core.query('layout.drc', { boardId: project.pcb!.id }) as Promise<unknown>,
      /Apply the Source/,
    );
    core.discardSource();
    core.setEditingBlocked('The project is closing.');
    await assert.rejects(host.query('layout.drc', { boardId: project.pcb!.id }), /closing/);
    core.setEditingBlocked(null);
    assert.equal(
      (
        (await host.query('schematic.erc', {
          schematicId: project.schematic.id,
        })) as RuleCheckResult
      ).kind,
      'erc',
    );
  } finally {
    dispose();
    host.dispose();
  }
});

test('async engine loading rejects superseded revisions and cancellation without publishing data', async () => {
  const core = fixture();
  const project = core.getSnapshot().project!;
  const pending = core.query('schematic.erc', {
    schematicId: project.schematic.id,
  }) as Promise<unknown>;
  core.updateSource('{new draft');
  await assert.rejects(pending, /changed during rule checks/);
  core.discardSource();
  const before = core.getSnapshot();
  const controller = new AbortController();
  const cancelled = core.query(
    'layout.drc',
    { boardId: project.pcb!.id },
    { signal: controller.signal },
  ) as Promise<unknown>;
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(core.getSnapshot(), before);
});
