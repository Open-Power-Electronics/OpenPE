import { registerPcbDesignCapability } from '../plugins/pe-layout-skill/renderer/capabilities';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject } from '../lib/project';
import { emptyCircuit, uid } from '../lib/circuit';
import { ProjectCore } from '../core/project-core';
import { serializePCB } from '../lib/pcb';
import {
  LAYOUT_PARASITICS_PLUGIN_ID,
  SPICE_PLUGIN_ID,
  PCB_DESIGN_PLUGIN_ID,
} from '../plugins/catalog.mjs';
import { registerLayoutParasiticsCapability } from '../plugins/layout-parasitics/renderer/capabilities';
import {
  registerWorkbenchPluginCapabilities,
  workbenchPluginAvailability,
} from '../lib/workbench-plugins';
import { pcbDesignDocuments } from '../plugins/pe-layout-skill/renderer/capabilities';

test('workbench plugin UI/Agent operations share refresh, lifecycle confirmation and fixed IDs', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  const catalog = {
    controlsVersion: 1,
    browse: true,
    actions: ['install', 'uninstall', 'enable', 'disable'],
    warning: '',
    updatedAt: Date.now(),
    plugins: [
      {
        id: SPICE_PLUGIN_ID,
        name: 'SPICE Simulation',
        scope: 'application',
        marketplace: 'OpenPE Marketplace',
        description: 'Bundled transient simulation.',
        version: '1',
        installed: true,
        enabled: true,
        origin: 'openpe',
        managed: false,
      },
      {
        id: LAYOUT_PARASITICS_PLUGIN_ID,
        name: 'Layout Parasitics',
        scope: 'application',
        marketplace: 'OpenPE Marketplace',
        description: 'Bundled DC resistance estimate.',
        version: '1',
        installed: true,
        enabled: true,
        origin: 'openpe',
        managed: false,
      },
      {
        id: PCB_DESIGN_PLUGIN_ID,
        name: 'PE Layout Skill',
        scope: 'application',
        marketplace: 'OpenPE Marketplace',
        description: 'Bundled design guidance.',
        version: '1',
        installed: true,
        enabled: true,
        origin: 'openpe',
        managed: false,
      },
    ],
  };
  let reads = 0;
  let writes = 0;
  const documents: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { openpe: { connection: async () => ({ base: 'http://localhost', token: 'test' }) } },
  });
  globalThis.fetch = async (_input, options) => {
    const url = new URL(String(_input));
    if (url.pathname === '/api/pcb-design/guide') {
      documents.push(url.searchParams.get('document')!);
      return Response.json({ text: 'verified fixture guidance' });
    }
    if (options?.method === 'POST') {
      writes++;
      const { action, id } = JSON.parse(String(options.body));
      const row = catalog.plugins.find((row) => row.id === id)!;
      assert.ok(row);
      row.installed = action !== 'uninstall';
      row.enabled = action === 'install' || action === 'enable';
      return Response.json({ ok: true });
    }
    reads++;
    return Response.json({ ...catalog, updatedAt: Date.now() });
  };
  try {
    const host = createCapabilityHost();
    const removePlatform = registerWorkbenchPluginCapabilities(host);
    const removeGuide = registerPcbDesignCapability(host);
    const remove = () => {
      removeGuide();
      removePlatform();
    };
    await host.query('workbench.plugins.list');
    assert.equal(reads, 1);
    await host.query('workbench.plugins.list', { refresh: false });
    assert.equal(reads, 1);
    await host.query('workbench.plugins.list', { refresh: true });
    assert.equal(reads, 2);
    assert.equal(workbenchPluginAvailability(SPICE_PLUGIN_ID), true);
    const guide = host.catalog().find((entry) => entry.id === 'pcbDesign.guide')!;
    assert.equal(guide.plugin, PCB_DESIGN_PLUGIN_ID);
    assert.equal(guide.owner, 'plugin');
    assert.equal(guide.mutation, false);
    await host.query('pcbDesign.guide');
    await host.query('pcbDesign.guide', { document: pcbDesignDocuments.at(-1) });
    assert.deepEqual(documents, ['workflow', 'topologies']);
    for (const input of [
      { document: '../SKILL.md' },
      { path: 'SKILL.md' },
      { document: 'workflow', command: 'run' },
    ])
      await assert.rejects(host.query('pcbDesign.guide', input), /Invalid input/);
    assert.equal(documents.length, 2);
    await host.execute(
      'workbench.plugins.change',
      { id: SPICE_PLUGIN_ID, action: 'disable' },
      { actor: 'agent' },
    );
    assert.equal(writes, 1);
    assert.equal(reads, 3);
    assert.match(String(workbenchPluginAvailability(SPICE_PLUGIN_ID)), /Install and enable/);
    assert.equal(
      host.observe().events.some((event) => event.type === 'workbench.plugins.changed'),
      true,
    );
    await assert.rejects(
      host.execute('workbench.plugins.change', { id: 'external@untrusted', action: 'install' }),
      /Unknown|Invalid input/,
    );
    assert.equal(writes, 1);
    await host.execute(
      'workbench.plugins.change',
      { id: SPICE_PLUGIN_ID, action: 'enable' },
      { actor: 'human' },
    );
    assert.equal(workbenchPluginAvailability(SPICE_PLUGIN_ID), true);
    await host.execute('workbench.plugins.change', { id: PCB_DESIGN_PLUGIN_ID, action: 'disable' });
    await assert.rejects(host.query('pcbDesign.guide'), /Install and enable PE Layout Skill/);
    assert.equal(documents.length, 2);
    assert.equal(host.catalog().find((entry) => entry.id === 'pcbDesign.guide')?.available, false);
    await host.execute('workbench.plugins.change', { id: PCB_DESIGN_PLUGIN_ID, action: 'enable' });
    await host.query('pcbDesign.guide');
    assert.equal(documents.length, 3);
    const pcb = createEmptyPCB();
    const netId = uid(),
      startId = uid(),
      endId = uid();
    pcb.nets.push({ id: netId, name: 'Signal' });
    pcb.vias.push(
      { id: startId, x: 0, y: 0, diameter: 0.8, drill: 0.4, netId },
      { id: endId, x: 10, y: 0, diameter: 0.8, drill: 0.4, netId },
    );
    pcb.tracks.push({
      id: uid(),
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      width: 0.5,
      layer: 'F.Cu',
      netId,
    });
    const basis = structuredClone(pcb);
    const state = {
      project: { ...createProject(emptyCircuit()), pcb },
      revision: 5,
      sourceDraft: null as string | null,
      editingBlocked: null as string | null,
    };
    const removeParasitics = registerLayoutParasiticsCapability(
      host,
      () => state,
      (project) => {
        state.project = project as typeof state.project;
        state.revision++;
        return true;
      },
    );
    const measurement = host.catalog().find((entry) => entry.id === 'parasitics.measure');
    assert.equal(measurement?.plugin, LAYOUT_PARASITICS_PLUGIN_ID);
    assert.equal(measurement?.mutation, false);
    const input = { boardId: pcb.id, startId, endId };
    const human = await host.query('parasitics.measure', input, { expectedRevision: '5' });
    assert.deepEqual(await host.query('parasitics.measure', input, { actor: 'agent' }), human);
    assert.deepEqual(pcb, basis);
    const studyInput = { ...input, schematicId: state.project.schematic.id };
    await assert.rejects(
      host.query('parasitics.measure', studyInput),
      /Invalid input/,
      'The read-only measurement schema does not gain a schematic target.',
    );
    const studyDefinition = host.catalog().find((entry) => entry.id === 'parasitics.createStudy');
    assert.equal(studyDefinition?.owner, 'plugin');
    assert.equal(studyDefinition?.plugin, LAYOUT_PARASITICS_PLUGIN_ID);
    assert.equal(studyDefinition?.mutation, 'document');
    assert.equal(studyDefinition?.review, 'optional');
    assert.equal(studyDefinition?.level, 'operation');
    const studies = [];
    for (const actor of ['human', 'agent'] as const) {
      const core = new ProjectCore(state.project);
      const studyHost = createCapabilityHost({
        revision: () => String(core.getSnapshot().revision),
      });
      const dispose = registerLayoutParasiticsCapability(studyHost, core.getSnapshot, (next) =>
        core.commitProject(next),
      );
      try {
        const before = core.getSnapshot();
        const boardBytes = serializePCB(before.project!.pcb!, before.project!.schematic);
        for (const invalid of [
          input,
          { ...studyInput, resistanceOhm: 123 },
          { ...studyInput, shortestPartialInductanceNh: 999 },
          { ...studyInput, boardId: 'another-board' },
          { ...studyInput, schematicId: 'another-sheet' },
        ])
          await assert.rejects(studyHost.execute('parasitics.createStudy', invalid, { actor }));
        await assert.rejects(
          studyHost.execute('parasitics.createStudy', studyInput, {
            actor,
            expectedRevision: String(before.revision + 1),
          }),
          /project changed/,
        );
        const cancelled = new AbortController();
        cancelled.abort();
        await assert.rejects(
          studyHost.execute('parasitics.createStudy', studyInput, {
            actor,
            signal: cancelled.signal,
          }),
        );
        assert.equal(core.getSnapshot().source, before.source);
        const result = (await studyHost.execute('parasitics.createStudy', studyInput, {
          actor,
        })) as {
          schematicId: string;
          labels: unknown;
          references: unknown;
          values: unknown;
          omittedInductance: boolean;
          revision: string;
        };
        assert.equal(core.getSnapshot().undoDepth, 1);
        const after = core.getSnapshot().project!;
        assert.equal(after.schematic.id, result.schematicId);
        assert.equal(result.schematicId, before.project!.schematic.id);
        assert.equal(after.schematic.title, before.project!.schematic.title);
        assert.equal(after.additionalSchematics, before.project!.additionalSchematics);
        assert.equal(after.schematic.parts.length, before.project!.schematic.parts.length + 2);
        assert.equal(
          serializePCB(core.getSnapshot().project!.pcb!, core.getSnapshot().project!.schematic),
          boardBytes,
        );
        assert.equal(result.revision, String(core.getSnapshot().revision));
        assert.ok(
          !('project' in result),
          'The plugin result must not expose native backing or model files.',
        );
        studies.push({
          labels: result.labels,
          references: result.references,
          values: result.values,
          omittedInductance: result.omittedInductance,
        });
        core.execute('history.undo');
        assert.equal(core.getSnapshot().source, before.source);
        core.execute('history.redo');
        assert.equal(core.getSnapshot().project!.schematic.id, result.schematicId);
        assert.equal(
          core.getSnapshot().project!.schematic.parts.length,
          after.schematic.parts.length,
        );
        core.execute('source.update', { draft: 'pending native edits' });
        await assert.rejects(
          studyHost.execute('parasitics.createStudy', studyInput, { actor }),
          /Apply the Source edits/,
        );
        core.execute('source.discard');
        core.setEditingBlocked('This project is closing.');
        await assert.rejects(
          studyHost.execute('parasitics.createStudy', studyInput, { actor }),
          /project is closing/,
        );
      } finally {
        dispose();
        studyHost.dispose();
      }
    }
    assert.deepEqual(
      studies[0],
      studies[1],
      'Human and Agent studies share preparation, values and labels.',
    );
    await assert.rejects(
      host.query('parasitics.measure', { ...input, boardId: 'different-board' }),
      /no longer in the project/,
    );
    await assert.rejects(
      host.query('parasitics.measure', { ...input, path: 'board.kicad_pcb' }),
      /Invalid input/,
    );
    await assert.rejects(
      host.query('parasitics.measure', { ...input, copperThicknessMm: 0 }),
      /Invalid input/,
    );
    state.revision++;
    await assert.rejects(
      host.query('parasitics.measure', input, { expectedRevision: '5' }),
      /project changed/,
    );
    state.sourceDraft = 'pending';
    await assert.rejects(host.query('parasitics.measure', input), /Apply the Source edits/);
    await assert.rejects(
      host.execute('parasitics.createStudy', studyInput),
      /Apply the Source edits/,
    );
    state.sourceDraft = null;
    state.editingBlocked = 'This project is closing.';
    await assert.rejects(host.query('parasitics.measure', input), /project is closing/);
    await assert.rejects(host.execute('parasitics.createStudy', studyInput), /project is closing/);
    state.editingBlocked = null;
    await host.execute('workbench.plugins.change', {
      id: LAYOUT_PARASITICS_PLUGIN_ID,
      action: 'uninstall',
    });
    await assert.rejects(
      host.query('parasitics.measure', input),
      /Install and enable Layout Parasitics/,
    );
    await assert.rejects(
      host.execute('parasitics.createStudy', studyInput),
      /Install and enable Layout Parasitics/,
    );
    await host.execute('workbench.plugins.change', {
      id: LAYOUT_PARASITICS_PLUGIN_ID,
      action: 'install',
    });
    assert.equal(
      host.catalog().find((entry) => entry.id === 'parasitics.measure')?.available,
      true,
    );
    removeParasitics();
    await assert.rejects(host.query('parasitics.measure', input), /Unknown query/);
    remove();
    await assert.rejects(host.query('workbench.plugins.list'), /Unknown query/);
    await assert.rejects(host.query('pcbDesign.guide'), /Unknown query/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
