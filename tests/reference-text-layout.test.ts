import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import manifest from '../resources/example-catalog/manifest.json';
import snapshots from '../lib/reference-examples.json';
import { arrangeExampleText } from '../lib/example-layout';
import { pinPositions, serializeCircuit, type Circuit } from '../lib/circuit';
import { importDocument, parseProject, serializeProject } from '../lib/project';
import { symbolAnnotation, unitGraphics } from '../lib/library';
import { child, children, num, parseSExpr, val, type SExpr } from '../lib/sexpr';
import { prepareReferenceSimulation } from '../scripts/reference-simulation';
import { spiceNets } from '../plugins/spice-simulation/domain/spice';

// Ignore only the two fields' placement. Everything else in the native document,
// including property contents, visibility, pin mappings and library data, remains
// part of the comparison.
function withoutAnnotationPlacement(source: string) {
  const root = parseSExpr(source);
  for (const symbol of children(root, 'symbol'))
    for (const property of children(symbol, 'property')) {
      if (!['Reference', 'Value'].includes(val(property))) continue;
      const at = child(property, 'at');
      if (at) property.splice(property.indexOf(at), 1);
      const effects = child(property, 'effects');
      const justify = effects && child(effects, 'justify');
      if (effects && justify) effects.splice(effects.indexOf(justify), 1);
    }
  return root;
}

function geometry(circuit: Circuit) {
  return {
    parts: circuit.parts.map(({ raw: _raw, ...part }) => ({
      ...part,
      pins: pinPositions(part, circuit.libraries[part.libId]),
    })),
    wires: circuit.wires,
    labels: circuit.labels,
    junctions: circuit.junctions,
    noConnects: circuit.noConnects,
    libraries: circuit.libraries,
  };
}

function field(symbol: SExpr, name: 'Reference' | 'Value') {
  const property = children(symbol, 'property').find((property) => val(property) === name);
  assert.ok(property, `Missing ${name} instance field.`);
  return property;
}

function connectorRowSeparator(circuit: Circuit) {
  const connectors = circuit.parts.filter(
    (part) => /^J\d+$/.test(part.ref) && /^Connector(?:_|:)/.test(part.libId),
  );
  const connectorIds = new Set(connectors.map((part) => part.id));
  const rowBottom = Math.max(
    ...connectors.flatMap((part) =>
      pinPositions(part, circuit.libraries[part.libId]).map((pin) => pin.y),
    ),
  );
  const circuitTop = Math.min(
    ...circuit.parts
      .filter((part) => !connectorIds.has(part.id) && !part.libId.startsWith('power:'))
      .flatMap((part) => [
        part.y,
        ...pinPositions(part, circuit.libraries[part.libId]).map((pin) => pin.y),
      ]),
  );
  assert.ok(circuitTop > rowBottom, 'The connector row is separate from the physical circuit.');
  return (rowBottom + circuitTop) / 2;
}

// Solver node names depend on traversal order, so compare the complete partition
// of original terminals instead. This also covers excluded connector pins.
function originalConnections(circuit: Circuit, original: Circuit) {
  const nets = spiceNets(circuit);
  const groups = new Map<string, string[]>();
  const add = (node: string, terminal: string) => {
    const group = groups.get(node) ?? [];
    group.push(terminal);
    groups.set(node, group);
  };
  for (const previous of original.parts) {
    const part = circuit.parts.find((candidate) => candidate.id === previous.id);
    assert.ok(part, `${previous.ref} retains its source identity.`);
    for (const pin of unitGraphics(original.libraries[previous.libId], previous.unit || 1).flatMap(
      (group) => children(group, 'pin'),
    ))
      add(nets.node(part, val(child(pin, 'number'))), `${part.id}:${val(child(pin, 'number'))}`);
  }
  const probes = nets.probeNodes();
  for (const label of original.labels) {
    const probe = probes.find((candidate) => candidate.target.id === label.id);
    assert.ok(probe, `${label.text} retains its source label identity.`);
    add(probe.node, `label:${label.id}`);
  }
  return [...groups.values()].map((group) => group.sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

for (const entry of manifest.examples) {
  test(`${entry.id}: connector arrangement preserves original terminal and rail connectivity`, () => {
    const original = importDocument(readFileSync(entry.source.schematic.path, 'utf8')).schematic;
    const expected = originalConnections(original, original);
    const prepared = structuredClone(original);
    prepareReferenceSimulation(prepared, entry.id, entry.modelId);
    arrangeExampleText(prepared, entry.id);
    assert.deepEqual(originalConnections(prepared, original), expected);
    assert.deepEqual(
      originalConnections(importDocument(serializeCircuit(prepared)).schematic, original),
      expected,
      'Native export retains every original connection after the row is rearranged.',
    );
  });

  test(`${entry.id}: text arrangement preserves prepared electrical and native data`, () => {
    const circuit = importDocument(readFileSync(entry.source.schematic.path, 'utf8')).schematic;
    const original = structuredClone(circuit);
    const rowSeparator = connectorRowSeparator(original);
    prepareReferenceSimulation(circuit, entry.id, entry.modelId);
    const beforeGeometry = structuredClone(geometry(circuit));
    const beforeNative = serializeCircuit(circuit);

    arrangeExampleText(circuit, entry.id);
    const arrangedNative = serializeCircuit(circuit);

    assert.deepEqual(geometry(circuit), beforeGeometry);
    assert.deepEqual(
      withoutAnnotationPlacement(arrangedNative),
      withoutAnnotationPlacement(beforeNative),
      'Arrangement changes only Reference/Value placement and reading direction.',
    );
    const oldSymbols = children(parseSExpr(beforeNative), 'symbol');
    const newSymbols = children(parseSExpr(arrangedNative), 'symbol');
    for (const part of circuit.parts) {
      const before = oldSymbols.find((symbol) => val(child(symbol, 'uuid')) === part.id)!;
      const after = newSymbols.find((symbol) => val(child(symbol, 'uuid')) === part.id)!;
      for (const name of ['Reference', 'Value'] as const) {
        const previous = field(before, name);
        const current = field(after, name);
        if (JSON.stringify(previous) === JSON.stringify(current)) continue;
        assert.ok(
          Math.abs((num(child(current, 'at'), 3) - part.rotation) % 180) < 1e-8,
          `${part.ref} ${name} is upright in the native rotated instance.`,
        );
      }
    }
    for (const part of original.parts) {
      const retained = circuit.parts.find((candidate) => candidate.id === part.id);
      assert.ok(retained, `${part.ref} retains its source identity.`);
      assert.deepEqual(
        [retained.rotation, retained.mirror, retained.unit],
        [part.rotation, part.mirror, part.unit],
      );
      // Connector columns and their attached markers move as complete clusters;
      // every part in the lower circuit retains its original electrical geometry.
      if (part.y > rowSeparator) {
        assert.deepEqual([retained.x, retained.y], [part.x, part.y]);
        assert.deepEqual(
          pinPositions(retained, circuit.libraries[retained.libId]),
          pinPositions(part, original.libraries[part.libId]),
        );
      }
      // The controller's project-local library identity changes during simulation
      // preparation, while its source-embedded body and pins remain the same.
      assert.deepEqual(
        unitGraphics(circuit.libraries[retained.libId], retained.unit).map((group) =>
          group.slice(2),
        ),
        unitGraphics(original.libraries[part.libId], part.unit).map((group) => group.slice(2)),
      );
    }
    for (const wire of original.wires.filter(
      (wire) => wire.a.y > rowSeparator && wire.b.y > rowSeparator,
    ))
      assert.deepEqual(
        circuit.wires.find((candidate) => candidate.id === wire.id),
        wire,
      );
    for (const label of original.labels.filter((label) => label.y > rowSeparator))
      assert.deepEqual(
        circuit.labels.find((candidate) => candidate.id === label.id),
        label,
      );
  });

  test(`${entry.id}: stable template text anchors survive native roundtrip and repeat arrangement`, () => {
    const source = (snapshots as Record<string, string>)[entry.id];
    const project = parseProject(source);
    arrangeExampleText(project.schematic, entry.id);
    assert.equal(
      serializeProject(project),
      source,
      'Generated templates already contain the layout.',
    );
    arrangeExampleText(project.schematic, entry.id);
    assert.equal(serializeProject(project), source, 'Arrangement is idempotent.');

    const native = serializeCircuit(project.schematic);
    const root = parseSExpr(native);
    const reopened = importDocument(native).schematic;
    for (const part of project.schematic.parts) {
      const symbol = children(root, 'symbol').find((node) => val(child(node, 'uuid')) === part.id);
      assert.ok(symbol);
      const reopenedPart = reopened.parts.find((candidate) => candidate.id === part.id);
      assert.ok(reopenedPart);
      for (const name of ['Reference', 'Value'] as const) {
        const property = field(symbol, name);
        const at = child(property, 'at');
        assert.ok(at);
        const canvas = symbolAnnotation(part, project.schematic.libraries[part.libId], name);
        const roundtrip = symbolAnnotation(
          reopenedPart,
          reopened.libraries[reopenedPart.libId],
          name,
        );
        assert.ok(canvas);
        assert.ok(roundtrip);
        assert.equal(roundtrip.anchor, canvas.anchor);
        assert.ok(Math.abs(roundtrip.x - canvas.x) < 0.0001);
        assert.ok(Math.abs(roundtrip.y - canvas.y) < 0.0001);
        assert.ok(Math.abs(num(at) - canvas.x) < 0.0001);
        assert.ok(Math.abs(num(at, 2) - canvas.y) < 0.0001);
        const justify = child(child(property, 'effects') || [], 'justify');
        const anchor = justify?.includes('left')
          ? 'start'
          : justify?.includes('right')
            ? 'end'
            : 'middle';
        assert.equal(anchor, canvas.anchor);
      }
    }
  });
}
