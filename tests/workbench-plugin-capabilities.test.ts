import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import { createEmptyPCB } from '../lib/pcb-layout';
import {
  LAYOUT_PARASITICS_PLUGIN_ID,
  registerLayoutParasiticsCapability,
  registerWorkbenchPluginCapabilities,
  SPICE_PLUGIN_ID,
  PCB_DESIGN_PLUGIN_ID,
  pcbDesignDocuments,
  workbenchPluginAvailability,
} from '../lib/workbench-plugins';

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
    const remove = registerWorkbenchPluginCapabilities(host);
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
      /Invalid input/,
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
    pcb.nets.push({ id: 'signal', name: 'Signal' });
    pcb.vias.push(
      { id: 'start', x: 0, y: 0, diameter: 0.8, drill: 0.4, netId: 'signal' },
      { id: 'end', x: 10, y: 0, diameter: 0.8, drill: 0.4, netId: 'signal' },
    );
    pcb.tracks.push({
      id: 'trace',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      width: 0.5,
      layer: 'F.Cu',
      netId: 'signal',
    });
    const basis = structuredClone(pcb);
    const state = {
      project: { pcb },
      revision: 5,
      sourceDraft: null as string | null,
      editingBlocked: null as string | null,
    };
    const removeParasitics = registerLayoutParasiticsCapability(host, () => state);
    const measurement = host.catalog().find((entry) => entry.id === 'parasitics.measure');
    assert.equal(measurement?.plugin, LAYOUT_PARASITICS_PLUGIN_ID);
    assert.equal(measurement?.mutation, false);
    const input = { boardId: pcb.id, startId: 'start', endId: 'end' };
    const human = await host.query('parasitics.measure', input, { expectedRevision: '5' });
    assert.deepEqual(await host.query('parasitics.measure', input, { actor: 'agent' }), human);
    assert.deepEqual(pcb, basis);
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
    state.sourceDraft = null;
    state.editingBlocked = 'This project is closing.';
    await assert.rejects(host.query('parasitics.measure', input), /project is closing/);
    state.editingBlocked = null;
    await host.execute('workbench.plugins.change', {
      id: LAYOUT_PARASITICS_PLUGIN_ID,
      action: 'uninstall',
    });
    await assert.rejects(
      host.query('parasitics.measure', input),
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
