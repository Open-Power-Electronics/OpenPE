import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import manifest from '../resources/example-catalog/manifest.json';
import snapshots from '../lib/reference-examples.json';
import { createReferenceExample } from '../lib/reference-examples';
import {
  exportKiCad,
  parseProject,
  serializeProject,
  validateProject,
  projectNativeFiles,
} from '../lib/project';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import { exampleProject } from '../lib/project-example';
import { KICAD_PCB_VERSION, KICAD_SCHEMATIC_VERSION } from '../lib/kicad-version';
import { ProjectCore } from '../core/project-core';
import type { RuleCheckResult } from '../lib/design-rule-checks';
import { filledCopperPolygons, offsetPolygons, subtractPolygons } from '../lib/pcb-polygons';

const refilledExample = 'reference-tps61046-bga6-boost';
type NativeNode = ReturnType<typeof parseSExpr>;
const numeric = (node: NativeNode | undefined) =>
  node ? node.slice(1).map((_, index) => Number(val(node, index + 1))) : [];
const pose = (node: NativeNode) => {
  const values = numeric(child(node, 'at'));
  return [values[0], values[1], (((values[2] ?? 0) % 360) + 360) % 360];
};
const nativeNet = (node: NativeNode) => {
  const net = child(node, 'net');
  return net ? val(net, net.length > 2 ? 2 : 1) : '';
};
const semantic = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(semantic);
  if (typeof value !== 'string') return value;
  if (value.startsWith('"')) return JSON.parse(value);
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value) ? Number(value) : value;
};
const byUuid = <T extends { id: string }>(rows: T[]) =>
  rows.sort((left, right) => left.id.localeCompare(right.id));
function sourceCopperGeometry(root: NativeNode) {
  return {
    tracks: byUuid(
      ['segment', 'via', 'arc'].flatMap((kind) =>
        children(root, kind).map((item) => ({
          id: val(child(item, 'uuid')),
          kind,
          net: nativeNet(item),
          geometry: ['start', 'end', 'mid', 'at', 'width', 'size', 'drill', 'layer', 'layers'].map(
            (field) => [field, semantic(child(item, field) ?? null)],
          ),
        })),
      ),
    ),
    footprints: byUuid(
      children(root, 'footprint').map((footprint) => ({
        id: val(child(footprint, 'uuid')),
        position: pose(footprint),
        layer: val(child(footprint, 'layer')),
        pads: byUuid(
          children(footprint, 'pad').map((pad) => ({
            id: val(child(pad, 'uuid')),
            number: val(pad),
            type: val(pad, 2),
            shape: val(pad, 3),
            position: pose(pad),
            net: nativeNet(pad),
            geometry: [
              'size',
              'drill',
              'layers',
              'roundrect_rratio',
              'chamfer_ratio',
              'chamfer',
              'rect_delta',
              'primitives',
            ].map((field) => [field, semantic(child(pad, field) ?? null)]),
          })),
        ),
      })),
    ),
  };
}

async function verifyTPSRefill(
  project: ReturnType<typeof parseProject>,
  source: NativeNode,
  exported: NativeNode,
) {
  const board = project.pcb!;
  assert.deepEqual(
    sourceCopperGeometry(exported),
    sourceCopperGeometry(source),
    'TPS refill retains every source pad, track/via, association, pose and copper-object UUID.',
  );
  const edgePoints = (root: NativeNode) =>
    root
      .filter(Array.isArray)
      .filter(
        (item) => String(item[0]).startsWith('gr_') && val(child(item, 'layer')) === 'Edge.Cuts',
      )
      .flatMap((item) => {
        if (item[0] === 'gr_rect') {
          const [a, b] = [numeric(child(item, 'start')), numeric(child(item, 'end'))];
          return [a, [b[0], a[1]], b, [a[0], b[1]]];
        }
        return child(item, 'pts')
          ? children(child(item, 'pts')!, 'xy').map(numeric)
          : ['start', 'end', 'mid', 'center'].flatMap((field) =>
              child(item, field) ? [numeric(child(item, field))] : [],
            );
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const edges = edgePoints(source);
  assert.deepEqual(edgePoints(exported), edges, 'TPS board outline is unchanged.');
  const limits = [
    Math.min(...edges.map((p) => p[0])) + 0.5,
    Math.min(...edges.map((p) => p[1])) + 0.5,
    Math.max(...edges.map((p) => p[0])) - 0.5,
    Math.max(...edges.map((p) => p[1])) - 0.5,
  ];
  const sourceZones = children(source, 'zone');
  const actualZones = children(exported, 'zone');
  assert.equal(sourceZones.length, 3);
  assert.equal(actualZones.length, 3);
  const saved = filledCopperPolygons(board);
  assert.equal(saved.size, 3, 'All three enabled TPS zones have actual saved copper.');
  for (const original of sourceZones) {
    const id = val(child(original, 'uuid'));
    const actual = actualZones.find((zone) => val(child(zone, 'uuid')) === id);
    assert.ok(actual, `Zone UUID retained: ${id}`);
    const originalRings = children(original, 'polygon').map((polygon) =>
      children(child(polygon, 'pts')!, 'xy').map(numeric),
    );
    assert.equal(originalRings[0].length, 4);
    assert.equal(new Set(originalRings[0].map((p) => p[0])).size, 2);
    assert.equal(new Set(originalRings[0].map((p) => p[1])).size, 2);
    const expectedOuter = originalRings[0].map(([x, y]) => [
      Math.max(limits[0], Math.min(limits[2], x)),
      Math.max(limits[1], Math.min(limits[3], y)),
    ]);
    const actualRings = children(actual, 'polygon').map((polygon) =>
      children(child(polygon, 'pts')!, 'xy').map(numeric),
    );
    assert.deepEqual(
      actualRings,
      [expectedOuter, ...originalRings.slice(1)],
      'Only the declared board inset changes the owner boundary; holes stay exact.',
    );
    assert.equal(nativeNet(actual), nativeNet(original));
    assert.equal(val(child(actual, 'layer')), val(child(original, 'layer')));
    for (const field of ['priority', 'min_thickness', 'keepout'])
      assert.deepEqual(
        semantic(child(actual, field) ?? null),
        semantic(child(original, field) ?? null),
      );
    assert.deepEqual(
      semantic(child(actual, 'fill')),
      semantic(child(original, 'fill')),
      'Thermal relief, island rules and enabled fill state remain unchanged.',
    );
    const connection = (zone: NativeNode) =>
      child(zone, 'connect_pads')!.filter(
        (item) => !Array.isArray(item) || item[0] !== 'clearance',
      );
    assert.deepEqual(semantic(connection(actual)), semantic(connection(original)));
    const modelZone = board.zones.find((zone) => zone.id === id)!;
    assert.equal(modelZone.fillEnabled, true);
    assert.equal(
      modelZone.clearance,
      Math.max(0.25, Number(val(child(child(original, 'connect_pads')!, 'clearance')))),
    );
    assert.ok(modelZone.filledPolygons!.every((polygon) => polygon.points.length >= 3));
    const copper = saved.get(id)!;
    assert.ok(copper.length > 0);
    assert.deepEqual(
      subtractPolygons(
        copper,
        offsetPolygons([{ outer: modelZone.outline, holes: modelZone.holes ?? [] }], 0.0002),
      ),
      [],
      'Saved TPS copper stays inside its real owner and outside all cutouts within the 0.2 µm rounding band.',
    );
  }
  const core = new ProjectCore(project);
  const before = core.getSnapshot();
  const drc = (await core.query('layout.drc', { boardId: board.id })) as RuleCheckResult;
  assert.deepEqual(
    drc.issues.filter((issue) => issue.severity === 'error'),
    [],
    'The actual regenerated TPS board passes bounded Core DRC.',
  );
  assert.equal(core.getSnapshot().source, before.source);
  assert.equal(core.getSnapshot().revision, before.revision);
}

for (const entry of manifest.examples) {
  test(`${entry.id}: pinned source, complete project and serializer exports agree`, async () => {
    for (const source of [entry.source.schematic, entry.source.pcb])
      assert.equal(
        createHash('sha256').update(readFileSync(source.path)).digest('hex'),
        source.sha256,
      );
    const canonical = readFileSync(`tests/fixtures/reference/${entry.file}.json`, 'utf8');
    assert.equal((snapshots as Record<string, string>)[entry.id], canonical);
    const project = parseProject(canonical);
    assert.equal(serializeProject(project), canonical);
    assert.ok(project.schematic.parts.length > 0 && project.schematic.wires.length > 0);
    assert.ok(project.pcb && project.pcb.footprints.length && project.pcb.tracks.length);
    assert.deepEqual(
      project.extensions['org.openpe.reference-example'] &&
        (project.extensions['org.openpe.reference-example'] as { source: unknown }).source,
      entry.source,
    );
    const native = parseSExpr(readFileSync(entry.source.pcb.path, 'utf8'));
    const pcbSource = exportKiCad(project, 'pcb');
    const pcbTree = parseSExpr(pcbSource);
    const fills = (root: ReturnType<typeof parseSExpr>) =>
      children(root, 'zone').flatMap((zone) =>
        children(zone, 'filled_polygon').map((p) => ({
          net: val(child(zone, 'net')),
          layer: val(child(p, 'layer')),
          island: Boolean(child(p, 'island')),
          points: children(child(p, 'pts')!, 'xy').map((xy) => [
            Number(val(xy)),
            Number(val(xy, 2)),
          ]),
        })),
      );
    const sourceFills = fills(native);
    assert.ok(sourceFills.length > 0, 'The expert board includes actual filled copper contours.');
    if (entry.id === refilledExample) {
      await verifyTPSRefill(project, native, pcbTree);
    } else {
      assert.deepEqual(
        fills(pcbTree),
        sourceFills,
        'Native filled copper retains every source point, layer, net and island flag.',
      );
      assert.equal(
        project.pcb.zones.reduce((count, z) => count + (z.filledPolygons?.length ?? 0), 0),
        sourceFills.length,
      );
    }
    assert.equal(project.pcb.footprints.length, children(native, 'footprint').length);
    assert.equal(project.pcb.tracks.length, children(native, 'segment').length);
    assert.equal(project.pcb.vias.length, children(native, 'via').length);
    assert.equal(
      project.pcb.zones.length,
      children(native, 'zone').reduce(
        (sum, zone) =>
          sum + (child(zone, 'layers')?.length ? child(zone, 'layers')!.length - 1 : 1),
        0,
      ),
    );
    assert.equal(
      project.pcb.footprints.reduce((sum, footprint) => sum + footprint.pads.length, 0),
      children(native, 'footprint').reduce(
        (sum, footprint) => sum + children(footprint, 'pad').length,
        0,
      ),
    );
    for (const [kind, extension] of [
      ['schematic', 'kicad_sch'],
      ['pcb', 'kicad_pcb'],
    ] as const)
      assert.equal(
        kind === 'schematic'
          ? projectNativeFiles(project, entry.file + '.kicad_pro').files.find(
              (file) => file.name === entry.file + '.kicad_sch',
            )!.source
          : pcbSource,
        readFileSync(`examples/${entry.file}/${entry.file}.${extension}`, 'utf8'),
      );
    assert.equal(
      val(child(parseSExpr(exportKiCad(project, 'schematic')), 'version')),
      KICAD_SCHEMATIC_VERSION,
    );
    assert.equal(val(child(pcbTree, 'version')), KICAD_PCB_VERSION);
    for (const footprint of project.pcb.footprints) {
      if (footprint.symbolId)
        assert.ok(project.schematic.parts.some((part) => part.id === footprint.symbolId));
      else
        assert.ok(
          footprint.pads.every((pad) => pad.netId === null),
          'Unlinked mechanical objects cannot carry schematic nets.',
        );
    }
    const a = createReferenceExample(entry.id),
      b = createReferenceExample(entry.id);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.schematic.id, b.schematic.id);
    assert.notEqual(a.pcb!.id, b.pcb!.id);
    assert.deepEqual(a.schematic.libraries, project.schematic.libraries);
    const oldIDs = new Set([
      project.id,
      project.schematic.id,
      ...project.schematic.parts.map((p) => p.id),
      project.pcb.id,
      ...project.pcb.footprints.map((f) => f.id),
      ...project.pcb.nets.map((n) => n.id),
    ]);
    for (const id of [
      a.id,
      a.schematic.id,
      ...a.schematic.parts.map((p) => p.id),
      a.pcb!.id,
      ...a.pcb!.footprints.map((f) => f.id),
      ...a.pcb!.nets.map((n) => n.id),
    ])
      assert.ok(!oldIDs.has(id));
    const originalX = b.pcb!.footprints[0].x;
    a.pcb!.footprints[0].x += 1;
    assert.equal(
      b.pcb!.footprints[0].x,
      originalX,
      'Independent copies share no mutable board data.',
    );
    validateProject(a);
    assert.equal(val(child(parseSExpr(exportKiCad(a, 'pcb')), 'generator')), 'openpe');
  });
}

test('PCB source features reject invalid linked data before serialization', () => {
  const change = (edit: (project: ReturnType<typeof exampleProject>) => void) => {
    const project = exampleProject();
    edit(project);
    assert.throws(() => serializeProject(project));
  };
  change((p) => {
    p.pcb!.graphics[0].kind = 'arc';
  });
  change((p) => {
    p.pcb!.graphics[0].mid = { x: 10, y: 10 };
  });
  change((p) => {
    p.pcb!.tracks[0].layer = 'In1.Cu';
  });
  change((p) => {
    p.pcb!.footprints[0].pads[0].type = 'np_thru_hole';
  });
  change((p) => {
    p.pcb!.footprints[0].symbolId = null;
  });
  change((p) => {
    p.pcb!.footprints[0].reference = 'Ignored reference';
  });
  change((p) => {
    p.pcb!.footprints[0].value = '';
  });
  change((p) => {
    p.pcb!.footprints[0].pads[0].shape = 'roundrect';
  });
  change((p) => {
    const pad = p.pcb!.footprints[0].pads[0];
    pad.type = 'smd';
    delete pad.drill;
    pad.drillOffset = { x: 0.1, y: 0.2 };
  });
  change((p) => {
    p.pcb!.footprints[0].pads[0].roundrectRatio = 0.2;
  });
  change((p) => {
    p.pcb!.footprints[0].zones = [structuredClone(p.pcb!.zones[0])];
  });
});
