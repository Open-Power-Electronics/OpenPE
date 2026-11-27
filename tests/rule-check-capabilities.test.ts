import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { emptyCircuit, uid } from '../lib/circuit';
import { createProject } from '../lib/project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { PCBDesignRuleConfig, RuleCheckResult } from '../lib/design-rule-checks';

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
    const severityArgs = {
      schematicId,
      settings: { severities: { 'erc.wire-dangling': 'error' } },
    };
    const overridden = (await host.query('schematic.erc', severityArgs, {
      actor: 'agent',
    })) as RuleCheckResult;
    assert.deepEqual(overridden, await core.query('schematic.erc', severityArgs));
    assert.deepEqual(
      overridden.issues,
      direct.issues.map((issue) =>
        issue.ruleId === 'erc.wire-dangling' ? { ...issue, severity: 'error' } : issue,
      ),
    );
    const ignored = (await host.query('schematic.erc', {
      schematicId,
      settings: { severities: { 'erc.wire-dangling': 'ignore' } },
    })) as RuleCheckResult;
    assert.ok(!ignored.issues.some((issue) => issue.ruleId === 'erc.wire-dangling'));
    assert.ok(!ignored.checkedRules.includes('erc.wire-dangling'));
    assert.equal(ignored.complete, false);
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
      settings: { minTrackWidth: 0, scopes: ['dimensions'], useZoneClearance: true },
    })) as RuleCheckResult;
    assert.ok(!changed.issues.some((issue) => issue.ruleId === 'pcb.track-width'));
    assert.ok(changed.checkedRules.includes('pcb.via-diameter'));
    assert.ok(!changed.checkedRules.includes('pcb.copper-edge'));
    assert.equal(changed.complete, false);
    assert.deepEqual(
      changed,
      await core.query('layout.drc', {
        boardId,
        settings: { minTrackWidth: 0, scopes: ['dimensions'], useZoneClearance: true },
      }),
    );
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

test('an admitted board with unsupported copper returns a DRC report and runs independent checks', async () => {
  const name = 'Press fit.kicad_pcb';
  const source = `(kicad_pcb (version 20260206) (generator pcbnew)
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    (gr_rect (start 0 0) (end 20 20) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts"))
    (footprint "Connector" (layer "F.Cu") (at 10 10)
      (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1)
        (layers "*.Cu" "*.Mask") (property pad_prop_pressfit)))
    (segment (start 2 2) (end 4 2) (width 0.1) (layer "F.Cu") (net "Signal")))`;
  const core = new ProjectCore(projectFromNativeFiles({ entry: name, files: [{ name, source }] }));
  const snapshot = core.getSnapshot();
  const board = snapshot.project!.pcb!;
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, core);
  try {
    const report = (await host.query('layout.drc', { boardId: board.id })) as RuleCheckResult;
    assert.equal(report.complete, false);
    assert.equal(report.truncated, false);
    assert.ok(report.checkedRules.includes('pcb.outline'));
    assert.ok(report.checkedRules.includes('pcb.courtyard-overlap'));
    assert.ok(!report.checkedRules.includes('pcb.short'));
    assert.ok(!report.checkedRules.includes('pcb.copper-edge'));
    assert.ok(!report.checkedRules.includes('pcb.unrouted'));
    assert.match(
      report.issues.find(({ ruleId }) => ruleId === 'pcb.coverage')?.message ?? '',
      /pad machining or press-fit/,
    );
    assert.deepEqual(report.issues.find(({ ruleId }) => ruleId === 'pcb.track-width')?.objectIds, [
      board.tracks[0].id,
    ]);
    const outline = (await host.query('layout.drc', {
      boardId: board.id,
      settings: { scopes: ['edge'], severities: { 'pcb.copper-edge': 'ignore' } },
    })) as RuleCheckResult;
    assert.deepEqual(outline.checkedRules, ['pcb.outline']);
    assert.deepEqual(outline.issues, []);
    assert.equal(core.getSnapshot(), snapshot);
    assert.equal(
      core.getNativeFiles().files.find(({ name: file }) => file === name)?.source,
      source,
    );
  } finally {
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
      { severities: { 'erc.wire-dangling': 'info' } },
      { severities: { 'pcb.track-width': 'warning' } },
      { clearance: 0 },
    ])
      await assert.rejects(
        host.query('schematic.erc', { schematicId: project.schematic.id, settings }),
      );
    for (const settings of [
      { clearance: -1 },
      { extra: 1 },
      { minThroughHole: '0.3' },
      { clearance: 1001 },
      { scopes: [] },
      { scopes: ['dimensions', 'dimensions'] },
      { scopes: ['solder-mask'] },
      { useZoneClearance: 'yes' },
      { useKiCadClearance: 'yes' },
      { severities: { 'pcb.track-width': 'info' } },
      { severities: { 'pcb.unknown': 'warning' } },
      { clearanceOverrides: [{ key: 'zone:a', clearance: 0.2, enabled: 'false' }] },
      { clearanceOverrides: [{ key: 'zone:a', clearance: -1 }] },
      {
        clearanceOverrides: [
          { key: 'zone:a', clearance: 0 },
          { key: 'zone:a', clearance: 1 },
        ],
      },
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

test('project DRC minima round-trip through native Save as, Source and undo', async () => {
  const core = fixture();
  const boardId = core.getSnapshot().project!.pcb!.id;
  const before = core.getNativeFiles();
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const unregister = registerProjectCapabilities(host, core);
  try {
    const current = () =>
      host.query('layout.drc', { boardId: core.getSnapshot().project!.pcb!.id }) as Promise<
        RuleCheckResult & { settings: PCBDesignRuleConfig }
      >;
    const baseline = await current();
    const thresholds = { clearance: 0.32, minTrackWidth: 0.07, minThroughHole: 0.28 };
    const args = { boardId, thresholds };
    await host.execute('layout.drc.settings', args, { actor: 'agent' });
    const edited = core.getNativeFiles();
    const pro = edited.files.find((file) => file.name === edited.entry)!;
    const data = JSON.parse(pro.source);
    assert.deepEqual(data.board.design_settings.rules, {
      min_clearance: 0.32,
      min_track_width: 0.07,
      min_through_hole_diameter: 0.28,
    });
    assert.deepEqual(
      edited.files.filter((file) => file.name !== edited.entry),
      before.files.filter((file) => file.name !== before.entry),
    );
    assert.equal(core.getSnapshot().undoDepth, 1);
    const after = await current();
    assert.equal(after.settings.minThroughHole, 0.28);
    assert.equal(after.settings.useKiCadClearance, true);
    assert.ok(!after.issues.some((issue) => issue.ruleId === 'pcb.track-width'));
    const revision = core.getSnapshot().revision;
    await host.execute('layout.drc.settings', args);
    assert.equal(core.getSnapshot().revision, revision);
    core.setNativeEntryName('Saved.kicad_pro');
    const reopened = new ProjectCore(projectFromNativeFiles(core.getNativeFiles()));
    const reopenedReport = (await reopened.query('layout.drc', {
      boardId: reopened.getSnapshot().project!.pcb!.id,
    })) as typeof after;
    assert.deepEqual(reopenedReport.settings, after.settings);
    core.setNativeEntryName(before.entry);
    assert.ok(core.undo());
    assert.deepEqual(core.getNativeFiles(), before);
    assert.deepEqual((await current()).settings, baseline.settings);
    assert.ok(core.redo());
    assert.deepEqual(core.getNativeFiles(), edited);
    data.board.design_settings.rules.min_clearance = 0.42;
    core.updateNativeSource(edited.entry, JSON.stringify(data));
    await assert.rejects(host.execute('layout.drc.settings', args), /Apply the Source/);
    assert.ok(core.applySource());
    assert.equal((await current()).settings.clearance, 0.42);
  } finally {
    unregister();
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
