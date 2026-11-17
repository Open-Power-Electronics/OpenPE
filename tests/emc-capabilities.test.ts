import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { emptyCircuit, uid } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject, type Project } from '../lib/project';
import { registerWorkbenchPluginCapabilities } from '../lib/workbench-plugins';
import { EMC_PLUGIN_ID } from '../plugins/catalog.mjs';
import { inspectEmcLayout } from '../plugins/emc-analysis/domain/layout';
import { reviewEmcLayout, EMC_REVIEW_DEFAULT_LIMITS } from '../plugins/emc-analysis/domain/review';
import { registerEmcCapabilities } from '../plugins/emc-analysis/renderer/capabilities';

test('EMC GUI/Agent layout inspection shares native preservation and lifecycle gates', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  const plugin = {
    id: EMC_PLUGIN_ID,
    name: 'EMC Analysis',
    scope: 'application',
    marketplace: 'OpenPE Marketplace',
    description: 'Current PCB routing evidence',
    version: '1',
    installed: true,
    enabled: true,
    origin: 'openpe',
    managed: false,
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { openpe: { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) } },
  });
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      const { action, id } = JSON.parse(String(options.body));
      assert.equal(id, EMC_PLUGIN_ID);
      plugin.enabled = action === 'enable' || action === 'install';
      plugin.installed = action !== 'uninstall';
      return Response.json({ ok: true });
    }
    return Response.json({
      controlsVersion: 1,
      browse: true,
      actions: ['install', 'uninstall', 'enable', 'disable'],
      plugins: [plugin],
      warning: '',
      updatedAt: Date.now(),
    });
  };
  const pcb = createEmptyPCB();
  const netId = uid();
  pcb.nets.push({ id: netId, name: 'SW' });
  pcb.tracks.push({
    id: uid(),
    start: { x: 0, y: 0 },
    end: { x: 3, y: 4 },
    layer: 'F.Cu',
    width: 0.4,
    netId,
  });
  const core = new ProjectCore({ ...createProject(emptyCircuit()), pcb });
  let projectOverride: Project | null | undefined;
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const removePlugins = registerWorkbenchPluginCapabilities(host);
  const removeEmc = registerEmcCapabilities(host, () => {
    const state = core.getSnapshot();
    return { ...state, project: projectOverride === undefined ? state.project : projectOverride };
  });
  try {
    await host.query('workbench.plugins.list', { refresh: true });
    const entry = host.catalog().find((row) => row.id === 'emc.inspectLayout')!;
    assert.equal(entry.owner, 'plugin');
    assert.equal(entry.plugin, EMC_PLUGIN_ID);
    assert.equal(entry.mutation, false);
    assert.equal(entry.review, 'none');
    assert.equal(entry.available, true);
    const reviewEntry = host.catalog().find((row) => row.id === 'emc.reviewLayout')!;
    assert.equal(reviewEntry.plugin, EMC_PLUGIN_ID);
    assert.equal(reviewEntry.mutation, false);
    assert.equal(reviewEntry.review, 'none');
    assert.equal(reviewEntry.available, true);
    assert.equal(
      host.catalog().some((row) => row.id === 'emc.analyze'),
      false,
    );
    await assert.rejects(host.query('emc.analyze', {}), /Unknown query/);
    const before = core.getSnapshot();
    const files = structuredClone(core.getNativeFiles());
    const inspectInput = { netIds: [netId], segmentBudgetMm: 4 };
    const reviewInput = {
      nets: [{ netId, role: 'fast' as const }],
      limits: { ...EMC_REVIEW_DEFAULT_LIMITS, maxTrackLengthMm: 4 },
      decoupling: [],
      edgeConnectorIds: [],
    };
    for (const actor of ['human', 'agent'] as const) {
      const options = { actor, expectedRevision: String(before.revision) };
      assert.deepEqual(await host.query('emc.inspectLayout', inspectInput, options), {
        revision: before.revision,
        boardId: pcb.id,
        ...inspectEmcLayout(pcb, inspectInput),
      });
      assert.deepEqual(await host.query('emc.reviewLayout', reviewInput, options), {
        boardId: pcb.id,
        revision: before.revision,
        result: reviewEmcLayout(pcb, reviewInput),
      });
    }
    assert.deepEqual(core.getNativeFiles(), files);
    assert.equal(core.getSnapshot().revision, before.revision);
    assert.equal(core.getSnapshot().undoDepth, before.undoDepth);
    assert.equal(core.getSnapshot().project, before.project);
    for (const bad of [
      { ...inspectInput, path: 'private' },
      { ...inspectInput, boardId: pcb.id },
      { ...inspectInput, segmentBudgetMm: 0 },
      { ...inspectInput, netIds: [] },
      { ...inspectInput, netIds: [netId, netId] },
    ])
      await assert.rejects(host.query('emc.inspectLayout', bad), /Invalid input/);
    await assert.rejects(host.query('emc.inspectLayout', { ...inspectInput, netIds: ['missing'] }));
    await assert.rejects(
      host.query('emc.reviewLayout', { ...reviewInput, path: 'private' }),
      /Invalid input/,
    );
    await assert.rejects(
      host.query('emc.reviewLayout', {
        ...reviewInput,
        nets: [{ netId: 'missing', role: 'fast' }],
      }),
    );
    await assert.rejects(
      host.query('emc.reviewLayout', reviewInput, { expectedRevision: '-1' }),
      /changed/,
    );
    await assert.rejects(
      host.query('emc.inspectLayout', inspectInput, { expectedRevision: '-1' }),
      /changed/,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      host.query('emc.inspectLayout', inspectInput, { signal: cancelled.signal }),
    );
    await assert.rejects(host.query('emc.reviewLayout', reviewInput, { signal: cancelled.signal }));
    projectOverride = { ...before.project!, pcb: null };
    assert.equal(host.catalog().find((row) => row.id === 'emc.inspectLayout')?.available, false);
    await assert.rejects(host.query('emc.inspectLayout', inspectInput), /no PCB layout/);
    await assert.rejects(host.query('emc.reviewLayout', reviewInput), /no PCB layout/);
    projectOverride = null;
    assert.equal(host.catalog().find((row) => row.id === 'emc.inspectLayout')?.available, false);
    await assert.rejects(host.query('emc.inspectLayout', inspectInput), /Open a project/);
    await assert.rejects(host.query('emc.reviewLayout', reviewInput), /Open a project/);
    projectOverride = undefined;
    core.updateSource('pending native edits');
    await assert.rejects(host.query('emc.inspectLayout', inspectInput), /Source edits/);
    await assert.rejects(host.query('emc.reviewLayout', reviewInput), /Source edits/);
    core.updateSource(null);
    core.setEditingBlocked('The project is closing.');
    await assert.rejects(host.query('emc.inspectLayout', inspectInput), /project is closing/);
    await assert.rejects(host.query('emc.reviewLayout', reviewInput), /project is closing/);
    core.setEditingBlocked(null);
    await host.execute('workbench.plugins.change', { id: EMC_PLUGIN_ID, action: 'disable' });
    assert.equal(host.catalog().find((row) => row.id === 'emc.inspectLayout')?.available, false);
    await assert.rejects(host.query('emc.inspectLayout', inspectInput), /Install and enable/);
    await assert.rejects(host.query('emc.reviewLayout', reviewInput), /Install and enable/);
    await host.execute('workbench.plugins.change', { id: EMC_PLUGIN_ID, action: 'enable' });
    await host.query('emc.inspectLayout', inspectInput);
    await host.query('emc.reviewLayout', reviewInput);
    await host.execute('workbench.plugins.change', { id: EMC_PLUGIN_ID, action: 'uninstall' });
    await assert.rejects(host.query('emc.inspectLayout', inspectInput), /Install and enable/);
    await assert.rejects(host.query('emc.reviewLayout', reviewInput), /Install and enable/);
    assert.deepEqual(core.getNativeFiles(), files);
    removeEmc();
    await assert.rejects(host.query('emc.inspectLayout', inspectInput), /Unknown query/);
    await assert.rejects(host.query('emc.reviewLayout', reviewInput), /Unknown query/);
  } finally {
    removeEmc();
    removePlugins();
    host.dispose();
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
