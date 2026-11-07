import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { createPart, emptyCircuit, pinPositions, uid, type Point } from '../lib/circuit';
import { createProject } from '../lib/project';
import { commitWireRoute } from '../lib/wiring';
import { projectNetGroups } from '../lib/project-net-groups';
import type { SchematicDraftingReport } from '../lib/schematic-drafting';

function fixture() {
  const circuit = emptyCircuit();
  const resistor = createPart(circuit, 'R', 12.7, 12.7);
  const capacitor = createPart(circuit, 'C', 50.8, 12.7);
  resistor.x = 10.636;
  resistor.y = 8.255;
  circuit.parts.push(resistor, capacitor);
  circuit.wires.push({ id: uid(), a: { x: 70, y: 0 }, b: { x: 90, y: 0 } });
  const a = pinPositions(resistor, circuit.libraries[resistor.libId])[0];
  const b = pinPositions(capacitor, circuit.libraries[capacitor.libId])[0];
  const routes = [
    [a, { x: 30.48, y: a.y }, { x: 30.48, y: b.y }, b],
    [
      { x: 80, y: -10 },
      { x: 80, y: 10 },
    ],
  ];
  const project = createProject(circuit);
  project.extensions['example.org'] = { retained: true };
  return { project, circuit, resistor, routes };
}

async function stableIds<T>(action: () => T | Promise<T>) {
  let sequence = 0;
  const replacement = mock.method(
    crypto,
    'randomUUID',
    () =>
      `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}` as ReturnType<
        typeof crypto.randomUUID
      >,
  );
  try {
    return await action();
  } finally {
    replacement.mock.restore();
  }
}

test('batch wire capability matches ordered canvas preparations in native bytes and one undo', async () => {
  const { project, circuit, routes } = fixture();
  const gui = new ProjectCore(project);
  await stableIds(() =>
    gui.replaceSchematic(
      routes.reduce(
        (sheet, route) => commitWireRoute(sheet, route),
        gui.getSnapshot().project!.schematic,
      ),
    ),
  );
  const core = new ProjectCore(project);
  const initial = core.getSnapshot();
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, core);
  try {
    const command = host.catalog().find((item) => item.id === 'schematic.wires')!;
    assert.equal(
      host
        .catalog()
        .some((item) => /^schematic\.(?:position|connections|arrange|batch)(?:\.|$)/.test(item.id)),
      false,
      'The drafting harness exposes explicit edits, without the retired layout/transaction experiments.',
    );
    assert.equal(command.owner, 'core');
    assert.equal(command.level, 'operation');
    const input = { schematicId: circuit.id, routes };
    await stableIds(() =>
      host.execute('schematic.wires', input, { actor: 'agent', expectedRevision: '0' }),
    );
    const after = core.getSnapshot();
    assert.deepEqual(core.getNativeFiles(), gui.getNativeFiles());
    assert.equal(after.undoDepth, 1);
    assert.deepEqual(after.project!.extensions, initial.project!.extensions);
    assert.equal(
      after.project!.schematic.wires[1].a.x,
      routes[0][0].x,
      'Keep imported off-grid pin anchors exact.',
    );
    assert.equal(
      after.project!.schematic.junctions.some((point) => point.x === 80 && point.y === 0),
      false,
    );
    const crossingGroups = projectNetGroups(after.project!.schematic).filter((group) =>
      group.wires.some((index) => after.project!.schematic.wires[index].a.x >= 70),
    );
    assert.equal(crossingGroups.length, 2, 'An interior crossing is not an electrical join.');
    input.routes[0][0].x = 900;
    assert.equal(core.getSnapshot(), after, 'The accepted candidate owns its inputs.');
    await host.execute('history.undo');
    assert.equal(core.getSnapshot().source, initial.source);
    await host.execute('history.redo');
    assert.equal(core.getSnapshot().source, after.source);
  } finally {
    dispose();
    host.dispose();
  }
});

test('batch rejects invalid later routes, global work overflow, stale revisions and Source/close gates atomically', async () => {
  const { project, circuit, routes } = fixture();
  const core = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, core);
  const initial = core.getSnapshot();
  try {
    await assert.rejects(
      host.execute('schematic.wires', {
        schematicId: circuit.id,
        routes: [routes[0], [{ x: 0, y: 0 }]],
      }),
    );
    assert.equal(core.getSnapshot(), initial);
    const tooMany = Array.from({ length: 100 }, () =>
      Array.from({ length: 301 }, (_, index) => ({ x: index, y: 80 })),
    );
    await assert.rejects(
      host.execute('schematic.wires', { schematicId: circuit.id, routes: tooMany }),
      /30,000-point/,
    );
    assert.equal(core.getSnapshot(), initial);
    await assert.rejects(
      host.execute(
        'schematic.wires',
        { schematicId: circuit.id, routes },
        { expectedRevision: 'stale' },
      ),
      /changed|revision/i,
    );
    assert.equal(core.getSnapshot(), initial);
    core.updateSource('{ invalid');
    const pending = core.getSnapshot();
    await assert.rejects(
      host.execute('schematic.wires', { schematicId: circuit.id, routes }),
      /Source|source/,
    );
    assert.equal(core.getSnapshot(), pending);
    core.discardSource();
    core.setEditingBlocked('Project is closing.');
    const closing = core.getSnapshot();
    await assert.rejects(
      host.execute('schematic.wires', { schematicId: circuit.id, routes }),
      /closing/,
    );
    assert.equal(core.getSnapshot(), closing);
  } finally {
    dispose();
    host.dispose();
  }
});

test('drafting query returns validated-sheet geometry without mutating native bytes, Source or undo', async () => {
  const { project, circuit, resistor } = fixture();
  const core = new ProjectCore(project);
  core.updateSource('{ invalid');
  const before = core.getSnapshot();
  const files = core.getNativeFiles();
  const host = createCapabilityHost();
  const dispose = registerProjectCapabilities(host, core);
  try {
    const report = (await host.query(
      'schematic.drafting',
      { schematicId: circuit.id },
      { actor: 'agent' },
    )) as {
      revision: string;
      sourcePending: boolean;
      advisory: boolean;
      components: { items: { partId: string; pins: { items: { position: Point }[] } }[] };
    };
    assert.equal(report.revision, String(before.revision));
    assert.equal(report.sourcePending, true);
    assert.equal(report.advisory, true);
    const item = report.components.items.find((item) => item.partId === resistor.id)!;
    assert.deepEqual(
      item.pins.items[0].position,
      pinPositions(before.project!.schematic.parts[0], circuit.libraries[resistor.libId])[0],
    );
    item.pins.items[0].position.x = 100;
    assert.equal(core.getSnapshot(), before);
    assert.deepEqual(core.getNativeFiles(), files);
    await assert.rejects(host.query('schematic.drafting', { schematicId: uid() }), /no longer/);
    assert.equal(core.getSnapshot(), before);
  } finally {
    dispose();
    host.dispose();
  }
});

test('drafting annotation IDs can position the observed field through the shared text command', async () => {
  const { project, circuit, resistor } = fixture();
  const core = new ProjectCore(project);
  const initial = core.getSnapshot();
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, core);
  try {
    const query = () =>
      host.query('schematic.drafting', { schematicId: circuit.id }) as Promise<
        SchematicDraftingReport & { revision: string }
      >;
    const before = await query();
    const annotations = before.components.items.find(
      (item) => item.partId === resistor.id,
    )!.annotations;
    const reference = annotations.find((item) => item.field === 'Reference')!;
    const value = annotations.find((item) => item.field === 'Value')!;
    const position = { x: 20.32, y: 25.4 };
    await host.execute(
      'schematic.text.position',
      { schematicId: circuit.id, id: reference.id, position },
      {
        actor: 'agent',
        expectedRevision: before.revision,
      },
    );
    const after = await query();
    const observed = after.components.items.find((item) => item.partId === resistor.id)!;
    assert.deepEqual(
      observed.annotations.find((item) => item.id === reference.id)!.position,
      position,
    );
    const retainedValue = observed.annotations.find((item) => item.id === value.id)!;
    assert.equal(retainedValue.field, value.field);
    assert.ok(Math.abs(retainedValue.position.x - value.position.x) < 1e-9);
    assert.ok(Math.abs(retainedValue.position.y - value.position.y) < 1e-9);
    assert.deepEqual(
      observed.pins,
      before.components.items.find((item) => item.partId === resistor.id)!.pins,
    );
    assert.deepEqual(
      projectNetGroups(core.getSnapshot().project!.schematic),
      projectNetGroups(initial.project!.schematic),
    );
    assert.equal(core.getSnapshot().undoDepth, 1);
    await host.execute('history.undo');
    assert.equal(core.getSnapshot().source, initial.source);
  } finally {
    dispose();
    host.dispose();
  }
});
