import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { uid } from '../lib/circuit';
import type { Footprint, PCB } from '../lib/pcb';
import { analyzePCBConnectivity } from '../lib/pcb-connectivity';
import { createEmptyPCB, type PCBSelection } from '../lib/pcb-layout';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { pointSegmentDistance, trackTouchesPolygon } from '../lib/pcb-collision';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import { createPCBRouter } from '../lib/pcb-routing';
import { preparePCBTrackAnchors } from '../lib/pcb-track-anchors';
import { createPCBTrackDrag } from '../lib/pcb-track-drag';
import { expandPCBTrackSelection } from '../lib/pcb-track-selection';
import { createProject, parseProject, serializeProject } from '../lib/project';

const fixture = (): PCB => ({
  ...createEmptyPCB(),
  nets: [
    { id: 'out', name: 'OUT' },
    { id: 'gnd', name: 'GND' },
  ],
});
const track = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): PCB['tracks'][number] => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  width: 0.4,
  layer: 'F.Cu',
  netId: 'out',
});
const selection = (...ids: string[]): PCBSelection[] => ids.map((id) => ({ kind: 'track', id }));
const filters = { footprint: true, track: true, via: true, graphic: true, zone: true };
const connected = (board: PCB, id: string) =>
  new Set(
    expandPCBTrackSelection(board, selection(id), defaultPCBDisplay(), filters, 'connected').map(
      (item) => item.id,
    ),
  );
const pad = (): Footprint => ({
  id: 'part',
  libraryId: 'Test:Drag',
  symbolId: null,
  x: 0,
  y: 0,
  rotation: 0,
  side: 'front',
  graphics: [],
  pads: [
    {
      id: 'pad',
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'thru_hole',
      shape: 'rect',
      size: { x: 2, y: 2 },
      drill: 0.3,
      netId: 'out',
    },
  ],
});

for (const [name, id, deltas] of [
  [
    'diagonal continues above the L1 terminal after its horizontal lead contracts',
    '42542234-16c8-433d-81d7-0123c6d0fc18',
    [
      { x: 1, y: -1 },
      { x: 1.25, y: -1.25 },
    ],
  ],
  [
    'feedback bridge moves past short pad-contained leads in both directions',
    '2b2db639-95c5-4d56-859c-9f7b696af64d',
    [
      { x: 0, y: -0.5 },
      { x: 0, y: 0.5 },
      { x: 0, y: 1 },
      { x: 0, y: 1.5 },
      { x: 0, y: 2 },
      { x: 0, y: 2.5 },
      { x: 0, y: 3 },
    ],
  ],
] as const)
  test(`native LM2596 ${name}`, async () => {
    const native = await readFile(
      'examples/lm2596-to220-5-buck/lm2596-to220-5-buck.kicad_pcb',
      'utf8',
    );
    const project = createProject();
    const original = parseKiCadPCB(native, project.schematic, 'lm2596-track-drag').board;
    const withoutFills = (value: PCB): PCB => ({
      ...value,
      zones: [],
      footprints: value.footprints.map((footprint) => ({ ...footprint, zones: [] })),
    });
    for (const reversed of [false, true])
      for (const obstacleMode of ['walk-around', 'shove'] as const) {
        const board = reversed
          ? {
              ...original,
              tracks: original.tracks.map((item) => ({
                ...item,
                start: item.end,
                end: item.start,
              })),
            }
          : original;
        const before = structuredClone(board);
        const selected = board.tracks.find((item) => item.id === id)!;
        const originalIds = new Set(board.tracks.map((item) => item.id));
        const connectedIds = connected(withoutFills(board), id);
        const terminals = preparePCBTrackAnchors(board, {
          netId: selected.netId,
          layer: selected.layer,
          centers: true,
          limitMessage: 'Unexpected fixture size.',
        }).filter((anchor) =>
          board.tracks.some(
            (item) =>
              connectedIds.has(item.id) && trackTouchesPolygon(item, anchor.polygon, () => {}),
          ),
        );
        const plan = createPCBTrackDrag(board, selection(id), { clearance: 0.25, obstacleMode });
        for (const posture of [false, true])
          for (const delta of deltas) {
            const result = plan.preview(delta, posture);
            assert.equal(result.error, '');
            const moved = result.board.tracks.find((item) => item.id === id)!;
            assert.ok(moved);
            const dx = selected.end.x - selected.start.x,
              dy = selected.end.y - selected.start.y;
            const expectedOffset = dx * delta.y - dy * delta.x;
            for (const point of [moved.start, moved.end])
              assert.ok(
                Math.abs(
                  dx * (point.y - selected.start.y) -
                    dy * (point.x - selected.start.x) -
                    expectedOffset,
                ) < 0.00001,
                'The selected span reaches the requested parallel line beyond the old lead endpoint.',
              );
            assert.equal(moved.width, selected.width);
            assert.equal(moved.layer, selected.layer);
            assert.ok(
              (moved.end.x - moved.start.x) * dx + (moved.end.y - moved.start.y) * dy > 0,
              'The selected span retains its original direction.',
            );
            if (id === '2b2db639-95c5-4d56-859c-9f7b696af64d')
              assert.ok(
                Math.hypot(moved.end.x - moved.start.x, moved.end.y - moved.start.y) >=
                  Math.min(Math.hypot(dx, dy), selected.width) - 0.000001,
                'Opposing terminal rays retain a width-long selected span instead of a sliver.',
              );
            for (const endpoint of ['start', 'end'] as const) {
              const joint = moved[endpoint];
              if (
                terminals.some((terminal) =>
                  trackTouchesPolygon(
                    { ...moved, start: joint, end: joint },
                    terminal.polygon,
                    () => {},
                  ),
                )
              )
                continue;
              const outgoing = moved[endpoint === 'start' ? 'end' : 'start'];
              const joins = result.board.tracks.flatMap((item) => {
                if (
                  item.id === moved.id ||
                  item.netId !== moved.netId ||
                  item.layer !== moved.layer
                )
                  return [];
                for (const attached of ['start', 'end'] as const)
                  if (Math.hypot(item[attached].x - joint.x, item[attached].y - joint.y) < 0.000001)
                    return [item[attached === 'start' ? 'end' : 'start']];
                return [];
              });
              assert.ok(joins.length, 'Every endpoint outside fixed pad copper retains a lead.');
              for (const incoming of joins)
                assert.ok(
                  (joint.x - incoming.x) * (outgoing.x - joint.x) +
                    (joint.y - incoming.y) * (outgoing.y - joint.y) >
                    0.000001,
                  `Both terminal leads meet the moved span with a forward bend (${endpoint}, delta ${delta.x},${delta.y}, ${obstacleMode}, reversed ${reversed}, posture ${posture}).`,
                );
            }
            const retainedIds = new Set(result.board.tracks.map((item) => item.id));
            const added = result.board.tracks.filter((item) => !originalIds.has(item.id));
            const connectedAfter = connected(withoutFills(result.board), id);
            assert.deepEqual(
              connectedAfter,
              new Set([
                ...[...connectedIds].filter((item) => retainedIds.has(item)),
                ...added.map((item) => item.id),
              ]),
              'Every surviving original span remains connected without relying on saved pours.',
            );
            for (const terminal of terminals)
              assert.ok(
                result.board.tracks.some(
                  (item) =>
                    connectedAfter.has(item.id) &&
                    trackTouchesPolygon(item, terminal.polygon, () => {}),
                ),
                `Fixed terminal ${terminal.id} retains actual copper contact.`,
              );
            assert.deepEqual(
              result.board.tracks.filter((item) => originalIds.has(item.id)).map((item) => item.id),
              board.tracks.filter((item) => retainedIds.has(item.id)).map((item) => item.id),
              'Surviving native identities keep their original order.',
            );
            assert.deepEqual(result.board.footprints, board.footprints);
            assert.deepEqual(result.board.vias, board.vias);
            assert.deepEqual(result.board.graphics, board.graphics);
            const changedIds = new Set(result.changedIds);
            if (id === '2b2db639-95c5-4d56-859c-9f7b696af64d' && delta.y === 2) {
              const shapes = (items: Pick<PCB['tracks'][number], 'start' | 'end'>[]) =>
                items
                  .map((item) =>
                    JSON.stringify([item.start, item.end].sort((a, b) => a.x - b.x || a.y - b.y)),
                  )
                  .sort();
              assert.deepEqual(
                shapes(
                  result.board.tracks.filter((item) => changedIds.has(item.id) && item.id !== id),
                ),
                shapes([
                  { start: { x: 43.2125, y: 65.4375 }, end: { x: 43.2125, y: 66.48125 } },
                  { start: { x: 43.2125, y: 66.48125 }, end: { x: 42.14375, y: 67.55 } },
                  { start: { x: 41.0125, y: 65.575 }, end: { x: 41.0125, y: 66.61875 } },
                  { start: { x: 41.0125, y: 66.61875 }, end: { x: 41.94375, y: 67.55 } },
                ]),
                'Each unobstructed terminal lead uses one vertical departure and one diagonal arrival.',
              );
            }
            const checkedJoints = new Set<string>();
            for (const item of result.board.tracks.filter((item) => changedIds.has(item.id)))
              for (const joint of [item.start, item.end]) {
                const key = `${item.layer}:${item.netId}:${joint.x},${joint.y}`;
                if (checkedJoints.has(key)) continue;
                checkedJoints.add(key);
                if (
                  terminals.some((terminal) =>
                    trackTouchesPolygon(
                      { ...item, start: joint, end: joint },
                      terminal.polygon,
                      () => {},
                    ),
                  )
                )
                  continue;
                const atJoint = (point: { x: number; y: number }) =>
                  Math.hypot(point.x - joint.x, point.y - joint.y) < 0.000001;
                const incident = result.board.tracks.filter(
                  (other) =>
                    other.netId === item.netId &&
                    other.layer === item.layer &&
                    pointSegmentDistance(joint, other.start, other.end) <= 0.000001 ** 2,
                );
                const arms = incident.reduce(
                  (count, other) => count + (atJoint(other.start) || atJoint(other.end) ? 1 : 2),
                  0,
                );
                if (
                  arms !== 2 ||
                  incident.length !== 2 ||
                  !incident.every((other) => changedIds.has(other.id))
                )
                  continue;
                const [incoming, outgoing] = incident.map((other) =>
                  atJoint(other.start) ? other.end : other.start,
                );
                assert.ok(
                  (joint.x - incoming.x) * (outgoing.x - joint.x) +
                    (joint.y - incoming.y) * (outgoing.y - joint.y) >
                    0.000001,
                  `Every exposed two-arm join in a rerouted lead retains a forward bend (${key}, delta ${delta.x},${delta.y}, ${obstacleMode}, reversed ${reversed}, posture ${posture}).`,
                );
              }
            assert.deepEqual(
              result.board.tracks.filter((item) => !changedIds.has(item.id)),
              board.tracks.filter((item) => !changedIds.has(item.id)),
              'Unchanged original copper keeps all native geometry and metadata.',
            );
            const serialized = serializeProject({ ...project, pcb: result.board });
            const restored = parseProject(serialized);
            assert.deepEqual(restored.pcb!.tracks, result.board.tracks);
            assert.equal(serializeProject(restored), serialized);
            assert.deepEqual(plan.preview(delta, posture), result);
          }
        assert.deepEqual(board, before);
      }
  });

test('LM2596 VIN drag retains its existing pad lead without growing a second terminal stub', async () => {
  const sources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
  const board = parseProject(sources['reference-lm2596-to220-5-buck']).pcb!;
  const selectedId = 'd2d0110b-b8f6-461a-b1eb-bb8be76afcf9';
  const leadId = '8e31c3be-7184-47e5-81e5-1f02058af19e';
  const before = structuredClone(board);
  const withoutFills = (value: PCB) => ({
    ...value,
    zones: [],
    footprints: value.footprints.map((footprint) => ({ ...footprint, zones: [] })),
  });
  const connectedIds = connected(withoutFills(board), selectedId);
  const selected = board.tracks.find((item) => item.id === selectedId)!;
  const terminals = preparePCBTrackAnchors(board, {
    netId: selected.netId,
    layer: selected.layer,
    centers: true,
    limitMessage: 'Unexpected fixture size.',
  }).filter((anchor) =>
    board.tracks.some(
      (item) => connectedIds.has(item.id) && trackTouchesPolygon(item, anchor.polygon, () => {}),
    ),
  );
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const plan = createPCBTrackDrag(board, selection(selectedId), {
      clearance: 0.25,
      obstacleMode,
    });
    for (const x of [-1, -2])
      for (const posture of [false, true]) {
        const result = plan.preview({ x, y: 0 }, posture);
        assert.equal(result.error, '');
        const joint = { x: 39.425 + x, y: 48.25 - x };
        const lead = result.board.tracks.find((item) => item.id === leadId)!;
        assert.deepEqual(lead, {
          ...board.tracks.find((item) => item.id === leadId)!,
          start: joint,
        });
        assert.deepEqual(result.board.tracks.find((item) => item.id === selectedId)!.end, joint);
        const newTracks = result.board.tracks.filter(
          (item) => !board.tracks.some((old) => old.id === item.id),
        );
        assert.ok(
          newTracks.every((item) => Math.min(item.start.y, item.end.y) > 50),
          'Only the remote U1 pad may need a new lead; C1 keeps its one original diagonal.',
        );
        assert.equal(newTracks.length, x === -1 ? 0 : 1);
        assert.deepEqual(
          new Set(
            [...connected(withoutFills(result.board), selectedId)].filter((id) =>
              board.tracks.some((track) => track.id === id),
            ),
          ),
          connectedIds,
        );
        assert.deepEqual(plan.preview({ x, y: 0 }, posture), result);
      }
    for (const posture of [false, true]) {
      const extended = plan.preview({ x: 2, y: 0 }, posture);
      assert.equal(extended.error, '');
      const moved = extended.board.tracks.find((item) => item.id === selectedId)!;
      assert.equal(moved.start.x, 41.425);
      assert.equal(moved.end.x, 41.425);
      const connectedAfter = connected(withoutFills(extended.board), selectedId);
      assert.deepEqual(
        new Set([...connectedAfter].filter((id) => board.tracks.some((item) => item.id === id))),
        connectedIds,
      );
      for (const terminal of terminals)
        assert.ok(
          extended.board.tracks.some(
            (item) =>
              connectedAfter.has(item.id) && trackTouchesPolygon(item, terminal.polygon, () => {}),
          ),
        );
      assert.deepEqual(extended.board.footprints, board.footprints);
      assert.deepEqual(extended.board.vias, board.vias);
      assert.deepEqual(plan.preview({ x: 2, y: 0 }, posture), extended);
    }
  }
  assert.deepEqual(board, before);
});

test('EMC VBUS drag slides its short diagonal neighbour without redundant width-contact doglegs', async () => {
  const board = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')).pcb!;
  const id = '55e76c6c-a882-41a3-85b9-455b1a2d200e';
  const leftId = '37c40dcd-8ba4-4959-8a4b-71e2c870ffd1';
  const rightId = '99584615-cbf3-4d62-834f-a3dc112a6d99';
  const before = structuredClone(board);
  const withoutFills = (value: PCB) => ({
    ...value,
    zones: [],
    footprints: value.footprints.map((footprint) => ({ ...footprint, zones: [] })),
  });
  const connectedIds = connected(withoutFills(board), id);
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const plan = createPCBTrackDrag(board, selection(id), { clearance: 0.25, obstacleMode });
    for (const delta of [
      { x: 0, y: 0.5 },
      { x: 0, y: -0.5 },
    ])
      for (const posture of [false, true]) {
        const result = plan.preview(delta, posture);
        assert.equal(result.error, '');
        const start = { x: 114.3, y: Number((64.9017 + delta.y).toFixed(6)) };
        const end = { x: Number((118.7931 - delta.y).toFixed(6)), y: start.y };
        assert.deepEqual(
          result.board.tracks,
          board.tracks.map((item) =>
            item.id === id
              ? { ...item, start, end }
              : item.id === leftId
                ? { ...item, end: start }
                : item.id === rightId
                  ? { ...item, start: end }
                  : item,
          ),
        );
        assert.deepEqual(new Set(result.changedIds), new Set([id, leftId, rightId]));
        assert.deepEqual(
          connected(withoutFills(result.board), id),
          connectedIds,
          'Physical pad/via/copper connectivity is preserved without saved fill bridges.',
        );
        assert.deepEqual(
          plan.preview(delta, posture),
          result,
          'The exact preview and generated identity remain stable.',
        );
      }
  }
  assert.deepEqual(board, before);
});

test('EMC VIN_P diagonal drag stretches its drilled J1 lead without a backtracking corner', async () => {
  const original = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')).pcb!;
  const id = 'f5f58608-884a-4ddc-9afc-1ddfccfc586e';
  const leadId = '1d86d449-e059-45b0-ae66-5414983dc04d';
  const netId = original.tracks.find((item) => item.id === id)!.netId;
  const withoutFills = (value: PCB): PCB => ({
    ...value,
    zones: [],
    footprints: value.footprints.map((footprint) => ({ ...footprint, zones: [] })),
  });
  for (const reversed of [false, true])
    for (const obstacleMode of ['walk-around', 'shove'] as const) {
      const board = reversed
        ? {
            ...original,
            tracks: original.tracks.map((item) => ({
              ...item,
              start: item.end,
              end: item.start,
            })),
          }
        : original;
      const before = structuredClone(board);
      const originalIds = new Set(board.tracks.map((item) => item.id));
      const connectedIds = connected(withoutFills(board), id);
      const plan = createPCBTrackDrag(board, selection(id), { clearance: 0.25, obstacleMode });
      for (const posture of [false, true])
        for (const amount of [-1.6, -0.5, 0.5]) {
          const delta = { x: amount, y: amount };
          const result = plan.preview(delta, posture);
          assert.equal(result.error, '');
          const selected = board.tracks.find((item) => item.id === id)!;
          const lead = board.tracks.find((item) => item.id === leadId)!;
          const joint = { x: 61, y: Number((57.6625 + 2 * amount).toFixed(6)) };
          const fuseJoint =
            amount === -1.6
              ? { x: 61.6625, y: 53.8 }
              : {
                  x: Number((64.8625 + amount).toFixed(6)),
                  y: Number((53.8 + amount).toFixed(6)),
                };
          assert.deepEqual(
            result.board.tracks.find((item) => item.id === id),
            {
              ...selected,
              start: reversed ? joint : fuseJoint,
              end: reversed ? fuseJoint : joint,
            },
          );
          assert.deepEqual(
            result.board.tracks.find((item) => item.id === leadId),
            {
              ...lead,
              [reversed ? 'end' : 'start']: joint,
            },
          );
          const reconnects = result.board.tracks.filter((item) => !originalIds.has(item.id));
          assert.equal(reconnects.length, amount === -1.6 ? 1 : 0);
          if (reconnects.length)
            assert.deepEqual(reconnects[0], {
              ...selected,
              id: reconnects[0].id,
              start: { x: 64.8625, y: 53.8 },
              end: fuseJoint,
            });
          assert.deepEqual(
            result.board.tracks.filter(
              (item) => originalIds.has(item.id) && item.id !== id && item.id !== leadId,
            ),
            board.tracks.filter((item) => item.id !== id && item.id !== leadId),
          );
          assert.deepEqual(
            new Set(result.changedIds),
            new Set([id, leadId, ...reconnects.map((item) => item.id)]),
          );
          const fillFree = withoutFills(result.board);
          assert.deepEqual(
            connected(fillFree, id),
            new Set([...connectedIds, ...reconnects.map((item) => item.id)]),
          );
          assert.deepEqual(
            analyzePCBConnectivity(fillFree).edges.filter((edge) => edge.netId === netId),
            [],
            'J1 and F1 remain physically connected without relying on saved pours.',
          );
          assert.deepEqual(result.board.footprints, board.footprints);
          assert.deepEqual(plan.preview(delta, posture), result);
        }
      assert.deepEqual(board, before);
    }
});

test('drilled terminal slides retain real annular contact after shortening', () => {
  for (const kind of ['pad', 'via'])
    for (const obstacleMode of ['walk-around', 'shove'] as const)
      for (const reversed of [false, true]) {
        const orient = (items: PCB['tracks']): PCB['tracks'] =>
          items.map((item) => ({
            ...item,
            width: 0.2,
            ...(reversed ? { start: item.end, end: item.start } : {}),
          }));
        const board = fixture();
        board.tracks = orient([
          track('left', 0, -4, -4, 0),
          track('selected', -4, 0, 4, 0),
          track('right', 4, 0, 0, -4),
          { ...track('back', 0, -4, 0, -7), layer: 'B.Cu' },
        ]);
        if (kind === 'via')
          board.vias = [{ id: 'via', x: 0, y: -4, diameter: 2, drill: 1.6, netId: 'out' }];
        else
          board.footprints = [
            {
              ...pad(),
              y: -4,
              pads: [{ ...pad().pads[0], shape: 'circle', size: { x: 2, y: 2 }, drill: 1.6 }],
            },
          ];
        const before = structuredClone(board);
        const plan = createPCBTrackDrag(board, selection('selected'), {
          clearance: 0.25,
          obstacleMode,
        });
        const accepted = plan.preview({ x: 0, y: -3 });
        assert.equal(accepted.error, '');
        assert.ok(connected(accepted.board, 'selected').has('back'));
        const rejected = plan.preview({ x: 0, y: -3.6 });
        assert.match(rejected.error, /terminal|contact|connect/i);
        assert.equal(rejected.board, board);
        assert.deepEqual(rejected.changedIds, []);
        assert.deepEqual(plan.preview({ x: 0, y: -3 }), accepted);
        assert.deepEqual(board, before);

        const extended = {
          ...board,
          tracks: orient([
            track('left', 0, -4, 4, 0),
            track('selected', 4, 0, 8, 0),
            track('right', 8, 0, 8, 8),
            { ...track('back', 0, -4, 0, -7), layer: 'B.Cu' },
          ]),
        };
        const shortened = createPCBTrackDrag(extended, selection('selected'), {
          clearance: 0.25,
          obstacleMode,
        }).preview({ x: 0, y: -3.8 });
        assert.equal(shortened.error, '');
        assert.ok(
          connected(shortened.board, 'selected').has('back'),
          'The moved selected span may preserve annular contact for a shortened neighbour.',
        );
      }
});

test('a translated group can retain drilled terminal contact through its checked reconnects', () => {
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const board = fixture();
    board.tracks = [
      track('a', -1, 0, 0, 0),
      track('bridge', 0, 0, 1, 0),
      track('b', 1, 0, 2, 0),
    ].map((item) => ({ ...item, width: 0.2 }));
    board.vias = [{ id: 'via', x: 1, y: 0, diameter: 4, drill: 1.6, netId: 'out' }];
    const before = structuredClone(board);
    const plan = createPCBTrackDrag(board, selection('a', 'b'), { clearance: 0.25, obstacleMode });
    const result = plan.preview({ x: 5, y: 0 });
    assert.equal(result.error, '');
    assert.deepEqual(
      result.board.tracks.slice(0, 3),
      board.tracks.map((item) => ({
        ...item,
        start: { x: item.start.x + 5, y: item.start.y },
        end: { x: item.end.x + 5, y: item.end.y },
      })),
    );
    assert.ok(connected(result.board, 'a').has('via'));
    assert.deepEqual(result.board.vias, board.vias);
    assert.deepEqual(plan.preview({ x: 5, y: 0 }), result);
    assert.deepEqual(board, before);
  }
});

test('redundant width contacts use a retained neighbour cap, while interior branches stay fixed', () => {
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const board = fixture();
    board.tracks = [
      track('left', 0, -5, 0, 0),
      track('selected', 0, 0, 10, 0),
      track('short', 10, 0, 10.7, -0.7),
      track('fixed', 10.7, -0.7, 15, -0.7),
      track('contact', 10.7, 0, 10.7, 4),
    ].map((item) => ({ ...item, width: 1 }));
    const before = structuredClone(board);
    const plan = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    });
    const result = plan.preview({ x: 0, y: 1 });
    assert.equal(result.error, '');
    assert.deepEqual(
      result.board.tracks,
      before.tracks.map((item) =>
        item.id === 'selected'
          ? { ...item, start: { x: 0, y: 1 }, end: { x: 9, y: 1 } }
          : item.id === 'left'
            ? { ...item, end: { x: 0, y: 1 } }
            : item.id === 'short'
              ? { ...item, start: { x: 9, y: 1 } }
              : item,
      ),
    );
    assert.deepEqual(
      connected(result.board, 'selected'),
      new Set(board.tracks.map((item) => item.id)),
    );
    assert.deepEqual(board, before);

    const branched = { ...board, tracks: [...board.tracks, track('interior', 5, 0, 5, -3)] };
    const branchResult = createPCBTrackDrag(branched, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    }).preview({ x: 0, y: 1 });
    assert.equal(branchResult.error, '');
    assert.deepEqual(
      branchResult.board.tracks.find((item) => item.id === 'interior'),
      branched.tracks.at(-1),
    );
    assert.ok(connected(branchResult.board, 'selected').has('interior'));
    assert.ok(
      branchResult.board.tracks.length > branched.tracks.length,
      'An interior contact cannot be discarded as an endpoint-cap redundancy.',
    );
  }
});

test('EMC reconnects never append duplicate reversed copper with identical layer, net and width', async () => {
  const board = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')).pcb!;
  const id = '4c12230e-3317-490c-aeea-0b1cd44a22fa';
  const originalIds = new Set(board.tracks.map((item) => item.id));
  const result = createPCBTrackDrag(board, selection(id), { clearance: 0.25 }).preview({
    x: 0,
    y: 0.5,
  });
  assert.equal(result.error, '');
  const key = (item: PCB['tracks'][number]) =>
    JSON.stringify([
      item.layer,
      item.netId,
      item.width,
      Boolean(item.locked),
      [item.start, item.end].sort((a, b) => a.x - b.x || a.y - b.y),
    ]);
  const seen = new Set(result.board.tracks.filter((item) => originalIds.has(item.id)).map(key));
  for (const item of result.board.tracks.filter((item) => !originalIds.has(item.id))) {
    assert.equal(
      seen.has(key(item)),
      false,
      'New reconnects do not duplicate existing or newly added copper.',
    );
    seen.add(key(item));
  }
  assert.deepEqual(
    result.board.tracks.slice(0, board.tracks.length).map((item) => item.id),
    board.tracks.map((item) => item.id),
  );
});

test('single horizontal track slides perpendicular while attached bends stretch with original IDs', () => {
  const board = fixture();
  board.tracks = [
    track('left', 2, -3, 2, 0),
    track('selected', 2, 0, 6, 0),
    track('right', 6, 0, 6, 3),
  ];
  const before = structuredClone(board),
    plan = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 });
  const result = plan.preview({ x: 3, y: 1 });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.board.tracks.map((item) => item.id),
    ['left', 'selected', 'right'],
  );
  assert.deepEqual(result.board.tracks[1], {
    ...board.tracks[1],
    start: { x: 2, y: 1 },
    end: { x: 6, y: 1 },
  });
  assert.deepEqual(result.board.tracks[0].end, { x: 2, y: 1 });
  assert.deepEqual(result.board.tracks[2].start, { x: 6, y: 1 });
  assert.deepEqual(connected(result.board, 'selected'), new Set(['left', 'selected', 'right']));
  assert.deepEqual(board, before);
});

test('45-degree and arbitrary existing straight tracks preserve angle under perpendicular movement', () => {
  for (const [end, expectedStart, expectedEnd] of [
    [
      { x: 4, y: 4 },
      { x: 1, y: -1 },
      { x: 5, y: 3 },
    ],
    [
      { x: 4, y: 2 },
      { x: 0.4, y: -0.8 },
      { x: 4.4, y: 1.2 },
    ],
  ]) {
    const board = fixture();
    board.tracks = [{ ...track('selected', 0, 0, end.x, end.y) }];
    const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
      x: 2,
      y: 0,
    });
    assert.equal(result.error, '');
    assert.deepEqual(result.board.tracks[0].start, expectedStart);
    assert.deepEqual(result.board.tracks[0].end, expectedEnd);
  }
});

test('a diagonal segment slides its joints along the original attached H/V tracks without doglegs', () => {
  for (const obstacleMode of ['walk-around', 'shove'] as const)
    for (const reversed of [false, true])
      for (const posture of [false, true]) {
        const board = fixture();
        board.tracks = [
          track('left', 0, 0, 4, 0),
          { ...track('selected', 4, 0, 8, 4), width: 0.6 },
          { ...track('right', 8, 4, 8, 8), width: 0.8 },
        ].map((item) => (reversed ? { ...item, start: item.end, end: item.start } : item));
        const before = structuredClone(board);
        const plan = createPCBTrackDrag(board, selection('selected'), {
          clearance: 0.25,
          obstacleMode,
        });
        for (const [delta, joints] of [
          [
            { x: 1, y: -1 },
            [
              { x: 6, y: 0 },
              { x: 8, y: 2 },
            ],
          ],
          [
            { x: -1, y: 1 },
            [
              { x: 2, y: 0 },
              { x: 8, y: 6 },
            ],
          ],
        ] as const) {
          const result = plan.preview(delta, posture);
          assert.equal(result.error, '');
          const points = [
            before.tracks[0][reversed ? 'end' : 'start'],
            ...joints,
            before.tracks[2][reversed ? 'start' : 'end'],
          ];
          assert.deepEqual(
            result.board.tracks,
            before.tracks.map((item, i) => ({
              ...item,
              start: points[reversed ? i + 1 : i],
              end: points[reversed ? i : i + 1],
            })),
          );
          assert.deepEqual(
            connected(result.board, 'selected'),
            new Set(['left', 'selected', 'right']),
          );
          assert.deepEqual(plan.preview(delta, posture), result);
        }
        assert.deepEqual(board, before);
      }
});

test('sliding a horizontal segment retains the original diagonal directions at both ends', () => {
  const board = fixture();
  board.tracks = [
    track('left', 0, -4, 4, 0),
    track('selected', 4, 0, 8, 0),
    track('right', 8, 0, 12, 4),
  ];
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: 2,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks, [
    { ...board.tracks[0], end: { x: 5, y: 1 } },
    { ...board.tracks[1], start: { x: 5, y: 1 }, end: { x: 9, y: 1 } },
    { ...board.tracks[2], start: { x: 9, y: 1 } },
  ]);
});

test('fixed pad and via endpoints join a dragged segment with forward 45-degree bends', () => {
  for (const kind of ['pad', 'via'])
    for (const obstacleMode of ['walk-around', 'shove'] as const)
      for (const reversed of [false, true])
        for (const [end, delta, startJoint, endJoint] of [
          [
            { x: 10, y: 0 },
            { x: 0, y: 2 },
            { x: 2, y: 2 },
            { x: 8, y: 2 },
          ],
          [
            { x: 10, y: 0 },
            { x: 0, y: -2 },
            { x: 2, y: -2 },
            { x: 8, y: -2 },
          ],
          [
            { x: 0, y: 10 },
            { x: -2, y: 0 },
            { x: -2, y: 2 },
            { x: -2, y: 8 },
          ],
          [
            { x: 10, y: 10 },
            { x: -1, y: 1 },
            { x: 0, y: 2 },
            { x: 8, y: 10 },
          ],
        ]) {
          const board = fixture();
          board.tracks = [track('selected', 0, 0, end.x, end.y)];
          if (reversed)
            board.tracks[0] = {
              ...board.tracks[0],
              start: board.tracks[0].end,
              end: board.tracks[0].start,
            };
          const terminals = [{ x: 0, y: 0 }, end];
          if (kind === 'via')
            board.vias = terminals.map((point, i) => ({
              ...point,
              id: `via-${i}`,
              diameter: 0.6,
              drill: 0.2,
              netId: 'out',
            }));
          else
            board.footprints = terminals.map((point, i) => {
              const part = pad();
              return {
                ...part,
                ...point,
                id: `part-${i}`,
                pads: [{ ...part.pads[0], id: `pad-${i}`, size: { x: 0.6, y: 0.6 }, drill: 0.2 }],
              };
            });
          const before = structuredClone(board),
            plan = createPCBTrackDrag(board, selection('selected'), {
              clearance: 0.25,
              obstacleMode,
            });
          for (const posture of [false, true]) {
            const result = plan.preview(delta, posture);
            assert.equal(result.error, '');
            assert.deepEqual(result.board.tracks[0], {
              ...board.tracks[0],
              start: reversed ? endJoint : startJoint,
              end: reversed ? startJoint : endJoint,
            });
            assert.equal(result.board.tracks.length, 3);
            for (const [i, joint] of [startJoint, endJoint].entries()) {
              const reconnect = result.board.tracks.find(
                (item) => item.start.x === terminals[i].x && item.start.y === terminals[i].y,
              );
              assert.ok(reconnect);
              assert.deepEqual(reconnect.end, joint);
              const incoming = { x: joint.x - terminals[i].x, y: joint.y - terminals[i].y },
                other = i === 0 ? endJoint : startJoint,
                outgoing = { x: other.x - joint.x, y: other.y - joint.y };
              assert.ok(incoming.x * outgoing.x + incoming.y * outgoing.y > 0);
            }
            assert.deepEqual(
              connected(result.board, 'selected'),
              new Set([...result.board.tracks, ...result.board.vias].map((item) => item.id)),
            );
            assert.deepEqual(plan.preview(delta, posture), result);
            assert.deepEqual(result.board.footprints, board.footprints);
            assert.deepEqual(result.board.vias, board.vias);
          }
          assert.deepEqual(board, before);
        }
});

test('a small drag retaining pad or via copper contact needs no reconnect stub', () => {
  for (const kind of ['pad', 'via']) {
    const board = fixture();
    board.tracks = [track('selected', 0, 0, 10, 0)];
    if (kind === 'pad') board.footprints = [pad()];
    else board.vias = [{ id: 'via', x: 0, y: 0, diameter: 1, drill: 0.3, netId: 'out' }];
    const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
      x: 0,
      y: 0.1,
    });
    assert.equal(result.error, '');
    assert.deepEqual(result.board.tracks, [
      { ...board.tracks[0], start: { x: 0, y: 0.1 }, end: { x: 10, y: 0.1 } },
    ]);
  }
});

test('fixed-terminal reconnects preserve arbitrary source angles and use a forward routing ray', () => {
  const board = fixture();
  board.tracks = [track('selected', 0, 0, 8, 4)];
  board.vias = [{ id: 'via', x: 0, y: 0, diameter: 0.6, drill: 0.2, netId: 'out' }];
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: -0.5,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[0], {
    ...board.tracks[0],
    start: { x: 2.5, y: 2.5 },
    end: { x: 7.5, y: 5 },
  });
  assert.deepEqual(result.board.tracks[1].start, { x: 0, y: 0 });
  assert.deepEqual(result.board.tracks[1].end, { x: 2.5, y: 2.5 });
});

test('an obstructed fixed-terminal reconnect retains its diagonal arrival at the moved span', () => {
  const board = fixture();
  board.tracks = [track('selected', 0, 0, 10, 0)];
  board.vias = [
    { id: 'via', x: 0, y: 0, diameter: 0.6, drill: 0.2, netId: 'out' },
    { id: 'foreign', x: 1, y: 1, diameter: 0.6, drill: 0.2, netId: 'gnd' },
  ];
  for (const posture of [false, true]) {
    const plan = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode: 'walk-around',
    });
    const result = plan.preview({ x: 0, y: 2 }, posture);
    assert.equal(result.error, '');
    const joint = result.board.tracks[0].start,
      arrival = result.board.tracks
        .slice(1)
        .find((item) => item.end.x === joint.x && item.end.y === joint.y);
    assert.ok(arrival);
    assert.ok(arrival.end.x > arrival.start.x);
    assert.ok(arrival.end.y > arrival.start.y);
    assert.ok(
      Math.abs(arrival.end.x - arrival.start.x - (arrival.end.y - arrival.start.y)) < 0.000001,
    );
    for (const item of result.board.tracks)
      assert.equal(
        createPCBRouter(result.board, {
          layer: item.layer,
          netId: item.netId,
          width: item.width,
          clearance: 0.25,
        }).validate([item.start, item.end]),
        '',
      );
    assert.deepEqual(plan.preview({ x: 0, y: 2 }, posture), result);
  }
});

test('overlapping terminal anchors retain only H/V/45 reconnects after the farthest endpoint trim', () => {
  const board = fixture();
  board.tracks = [{ ...track('selected', 0, 0, 10, 0), width: 0.2 }];
  board.footprints = [0, -0.2].map((x, i) => {
    const part = pad();
    return {
      ...part,
      x,
      id: `part-${i}`,
      pads: [
        {
          ...part.pads[0],
          id: `pad-${i}`,
          type: 'smd' as const,
          drill: undefined,
          size: { x: 1, y: 1 },
        },
      ],
    };
  });
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const result = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    }).preview({ x: 0, y: 2 });
    assert.equal(result.error, '');
    assert.deepEqual(result.board.tracks[0].start, { x: 2, y: 2 });
    for (const item of result.board.tracks.slice(1)) {
      const dx = Math.abs(item.end.x - item.start.x),
        dy = Math.abs(item.end.y - item.start.y);
      assert.ok(dx < 0.000001 || dy < 0.000001 || Math.abs(dx - dy) < 0.000001);
    }
    assert.deepEqual(
      connected(result.board, 'selected'),
      new Set(result.board.tracks.map((item) => item.id)),
    );
  }
});

test('opposing fixed-terminal bends cannot collapse or reverse the dragged span', () => {
  const board = fixture();
  board.tracks = [track('selected', 0, 0, 4, 0)];
  board.vias = [0, 4].map((x) => ({
    id: `via-${x}`,
    x,
    y: 0,
    diameter: 0.6,
    drill: 0.2,
    netId: 'out',
  }));
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const plan = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    });
    assert.equal(plan.preview({ x: 0, y: 1 }).error, '');
    for (const y of [2, 3]) {
      const result = plan.preview({ x: 0, y });
      assert.match(result.error, /collapse|reverse/);
      assert.equal(result.board, board);
      assert.deepEqual(result.changedIds, []);
    }
    assert.equal(plan.preview({ x: 0, y: 1 }).error, '');
  }
});

test('sliding joints retain arbitrary source angles instead of normalizing attached copper to 45 degrees', () => {
  const board = fixture();
  board.tracks = [
    track('left', 0, -2, 4, 0),
    track('selected', 4, 0, 8, 4),
    track('right', 8, 4, 10, 8),
  ];
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: -0.5,
    y: 0.5,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks, [
    { ...board.tracks[0], end: { x: 2, y: -1 } },
    { ...board.tracks[1], start: { x: 2, y: -1 }, end: { x: 9, y: 6 } },
    { ...board.tracks[2], start: { x: 9, y: 6 } },
  ]);
});

test('sliding cannot reverse an attached track or collapse or reverse the selected segment', () => {
  const board = fixture();
  board.tracks = [
    track('left', 0, 0, 4, 0),
    track('selected', 4, 0, 8, 4),
    track('right', 8, 4, 8, 8),
  ];
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const plan = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    });
    assert.equal(plan.preview({ x: 1, y: -1 }).error, '');
    for (const amount of [-3, 2, 3]) {
      const result = plan.preview({ x: amount, y: -amount });
      assert.match(result.error, /collapse|reverse/);
      assert.equal(result.board, board);
      assert.deepEqual(result.changedIds, []);
    }
    assert.equal(plan.preview({ x: 1, y: -1 }).error, '');
  }
});

test('a simple same-width neighbour disappears when its sliding joint reaches the fixed endpoint', () => {
  for (const obstacleMode of ['walk-around', 'shove'] as const)
    for (const reversed of [false, true]) {
      const board = fixture();
      board.tracks = [
        track('unrelated', 30, 30, 35, 30),
        track('short', 0, -4, 4, 0),
        track('selected', 4, 0, 8, 0),
        track('right', 8, 0, 8, 8),
        { ...track('back', -3, -4, 0, -4), layer: 'B.Cu' as const },
      ].map((item) => (reversed ? { ...item, start: item.end, end: item.start } : item));
      board.vias = [{ id: 'via', x: 0, y: -4, diameter: 0.8, drill: 0.2, netId: 'out' }];
      const before = structuredClone(board),
        plan = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25, obstacleMode }),
        result = plan.preview({ x: 0, y: -4 });
      assert.equal(result.error, '');
      assert.deepEqual(
        result.board.tracks.map((item) => item.id),
        ['unrelated', 'selected', 'right', 'back'],
      );
      const selected = result.board.tracks[1];
      assert.deepEqual(selected.start, reversed ? { x: 8, y: -4 } : { x: 0, y: -4 });
      assert.deepEqual(selected.end, reversed ? { x: 0, y: -4 } : { x: 8, y: -4 });
      assert.ok(result.changedIds.includes('short'));
      assert.deepEqual(
        connected(result.board, 'selected'),
        new Set(['selected', 'right', 'back', 'via']),
      );
      assert.deepEqual(result.board.vias, before.vias);
      assert.deepEqual(plan.preview({ x: 0, y: -4 }), result);
      const beyond = plan.preview({ x: 0, y: -5 });
      assert.equal(beyond.error, '');
      assert.deepEqual(
        beyond.board.tracks.find((item) => item.id === 'selected'),
        {
          ...board.tracks[2],
          start: reversed ? { x: 8, y: -5 } : { x: 1, y: -5 },
          end: reversed ? { x: 1, y: -5 } : { x: 8, y: -5 },
        },
      );
      assert.deepEqual(
        connected(beyond.board, 'selected'),
        new Set(['short', 'selected', 'right', 'back', 'via']),
      );
      assert.deepEqual(beyond.board.vias, before.vias);
      assert.deepEqual(plan.preview({ x: 0, y: -5 }), beyond);
      assert.deepEqual(plan.preview({ x: 0, y: -4 }), result);
      assert.deepEqual(board, before);
    }
});

test('both simple end neighbours may contract into the retained selected span without losing fixed pads', () => {
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const board = fixture();
    board.tracks = [
      track('left', 0, 0, 4, 0),
      track('selected', 4, 0, 8, 4),
      track('right', 8, 4, 8, 8),
    ];
    board.footprints = [
      { ...pad(), id: 'left-pad' },
      { ...pad(), id: 'right-pad', x: 8, y: 8, pads: [{ ...pad().pads[0], id: 'right-pin' }] },
    ];
    const result = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    }).preview({ x: -2, y: 2 });
    assert.equal(result.error, '');
    assert.deepEqual(result.board.tracks, [
      { ...board.tracks[1], start: { x: 0, y: 0 }, end: { x: 8, y: 8 } },
    ]);
    assert.deepEqual(new Set(result.changedIds), new Set(['left', 'selected', 'right']));
    assert.deepEqual(result.board.footprints, board.footprints);
  }
});

test('terminal lead posture changes retain complete checked detours and fixed contacts', () => {
  for (const obstacleMode of ['walk-around', 'shove'] as const)
    for (const reversed of [false, true]) {
      const board = fixture();
      board.tracks = [
        track('lead', 0, -4, 4, 0),
        track('selected', 4, 0, 8, 0),
        track('right', 8, 0, 8, 8),
        { ...track('back', -3, -4, 0, -4), layer: 'B.Cu' as const },
      ].map((item) => (reversed ? { ...item, start: item.end, end: item.start } : item));
      board.vias = [
        { id: 'terminal', x: 0, y: -4, diameter: 0.8, drill: 0.2, netId: 'out' },
        { id: 'obstacle', x: 0.45, y: -4.45, diameter: 0.2, drill: 0.1, netId: 'gnd' },
      ];
      const before = structuredClone(board);
      const plan = createPCBTrackDrag(board, selection('selected'), {
        clearance: 0.25,
        obstacleMode,
      });
      for (const posture of [false, true]) {
        const result = plan.preview({ x: 0, y: -5 }, posture);
        assert.equal(result.error, '');
        assert.ok(result.board.tracks.length > board.tracks.length);
        assert.deepEqual(
          connected(result.board, 'selected'),
          new Set([...result.board.tracks.map((item) => item.id), 'terminal']),
        );
        for (const item of result.board.tracks)
          assert.equal(
            createPCBRouter(result.board, {
              netId: item.netId,
              layer: item.layer,
              width: item.width,
              clearance: 0.25,
            }).validate([item.start, item.end]),
            '',
          );
        assert.deepEqual(result.board.vias, board.vias);
        assert.deepEqual(plan.preview({ x: 0, y: -5 }, posture), result);
      }
      // A fixed obstacle on the moved span still blocks the whole transaction.
      board.vias[1] = { ...board.vias[1], x: 1, y: -5 };
      const blocked = createPCBTrackDrag(board, selection('selected'), {
        clearance: 0.25,
        obstacleMode,
      }).preview({ x: 0, y: -5 });
      assert.match(blocked.error, /blocked/);
      assert.equal(blocked.board, board);
      assert.deepEqual(blocked.changedIds, []);
      board.vias = before.vias;
      assert.deepEqual(board, before);
    }
});

test('a width transition cannot disappear when its sliding neighbour reaches its endpoint', () => {
  const board = fixture();
  board.tracks = [
    track('short', 0, -4, 4, 0),
    { ...track('selected', 4, 0, 8, 0), width: 0.6 },
    track('right', 8, 0, 8, 8),
  ];
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const result = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    }).preview({ x: 0, y: -4 });
    assert.match(result.error, /collapse/);
    assert.equal(result.board, board);
    assert.deepEqual(result.changedIds, []);
  }
});

test('locked selected tracks fail while locked neighbours retain their complete original copper', () => {
  const board = fixture();
  board.tracks = [
    { ...track('short', 0, -4, 4, 0), locked: true },
    track('selected', 4, 0, 8, 0),
    track('right', 8, 0, 8, 8),
  ];
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const result = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    }).preview({ x: 0, y: -4 });
    assert.equal(result.error, '');
    assert.deepEqual(result.board.tracks[0], board.tracks[0]);
    assert.ok(connected(result.board, 'selected').has('short'));
    const locked = createPCBTrackDrag(board, selection('short'), {
      clearance: 0.25,
      obstacleMode,
    }).preview({ x: 0, y: -1 });
    assert.match(locked.error, /Unlock selected tracks/);
    assert.equal(locked.board, board);
  }
});

test('interior branches, width contacts and vias keep their original neighbour instead of being consumed', () => {
  for (const kind of ['branch', 'width', 'via'])
    for (const obstacleMode of ['walk-around', 'shove'] as const) {
      const board = fixture();
      board.tracks = [
        track('short', 0, -4, 4, 0),
        track('selected', 4, 0, 8, 0),
        track('right', 8, 0, 8, 8),
      ];
      if (kind === 'branch') board.tracks.push(track('contact', 2, -2, 2, -5));
      if (kind === 'width') board.tracks.push(track('contact', 2, -1.7, 3, -0.7));
      if (kind === 'via') {
        board.vias = [{ id: 'via', x: 2, y: -2, diameter: 0.8, drill: 0.2, netId: 'out' }];
        board.tracks.push({ ...track('contact', 2, -2, -3, -2), layer: 'B.Cu' });
      }
      const before = structuredClone(board),
        result = createPCBTrackDrag(board, selection('selected'), {
          clearance: 0.25,
          obstacleMode,
        }).preview({ x: 0, y: -4 });
      assert.equal(result.error, '');
      assert.deepEqual(result.board.tracks[0], board.tracks[0]);
      assert.deepEqual(
        result.board.tracks.find((item) => item.id === 'contact'),
        board.tracks[3],
      );
      assert.ok(connected(result.board, 'selected').has('contact'));
      assert.deepEqual(result.board.vias, before.vias);
      assert.deepEqual(board, before);
    }
});

test('foreign fixed copper blocks a contraction atomically after a successful shorter preview', () => {
  const board = fixture();
  board.tracks = [
    track('short', 0, -4, 4, 0),
    track('selected', 4, 0, 8, 0),
    track('right', 8, 0, 8, 8),
  ];
  board.vias = [{ id: 'foreign', x: 6, y: -4, diameter: 0.8, drill: 0.2, netId: 'gnd' }];
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const plan = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    });
    assert.equal(plan.preview({ x: 0, y: -3 }).error, '');
    const blocked = plan.preview({ x: 0, y: -4 });
    assert.match(blocked.error, /blocked/);
    assert.equal(blocked.board, board);
    assert.deepEqual(blocked.changedIds, []);
  }
});

test('contracted neighbour deletion preserves remaining native identities and canonical source order', () => {
  const board = fixture(),
    netId = uid();
  board.nets = [{ id: netId, name: 'OUT' }];
  board.tracks = [
    track('left', 0, 0, 4, 0),
    track('selected', 4, 0, 8, 4),
    track('right', 8, 4, 8, 8),
  ].map((item) => ({ ...item, id: uid(), netId }));
  const result = createPCBTrackDrag(board, selection(board.tracks[1].id), {
    clearance: 0.25,
    obstacleMode: 'shove',
  }).preview({ x: -2, y: 2 });
  assert.equal(result.error, '');
  assert.equal(result.board.tracks.length, 1);
  assert.equal(result.board.tracks[0].id, board.tracks[1].id);
  assert.deepEqual(
    parseProject(serializeProject({ ...createProject(), pcb: result.board })).pcb,
    result.board,
  );
});

test('a via at one joint stays fixed while the other joint slides along its attached track', () => {
  const board = fixture();
  board.tracks = [
    track('left', 0, 0, 4, 0),
    track('selected', 4, 0, 8, 4),
    track('right', 8, 4, 8, 8),
  ];
  board.vias = [{ id: 'via', x: 4, y: 0, diameter: 1, drill: 0.3, netId: 'out' }];
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: 1,
    y: -1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[0], board.tracks[0]);
  assert.deepEqual(result.board.tracks[1], {
    ...board.tracks[1],
    start: { x: 6, y: 0 },
    end: { x: 8, y: 2 },
  });
  assert.deepEqual(result.board.tracks[2].start, { x: 8, y: 2 });
  assert.deepEqual(result.board.vias, board.vias);
  assert.ok(connected(result.board, 'selected').has('left'));
});

test('a shortening slide reconnects interior anchors to the actual retained segment', () => {
  const board = fixture();
  board.tracks = [
    track('left', 0, 0, 4, 0),
    track('selected', 4, 0, 8, 4),
    track('right', 8, 4, 8, 8),
    { ...track('back', 4.75, 0.75, 4.75, -3), layer: 'B.Cu' },
  ];
  board.vias = [{ id: 'via', x: 4.75, y: 0.75, diameter: 0.4, drill: 0.1, netId: 'out' }];
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: 1,
    y: -1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[1].start, { x: 6, y: 0 });
  assert.deepEqual(result.board.vias, board.vias);
  assert.deepEqual(result.board.tracks[3], board.tracks[3]);
  assert.ok(connected(result.board, 'selected').has('back'));
});

test('collision checks cover the full extended sliding segment, including beyond its translated endpoints', () => {
  const board = fixture();
  board.tracks = [
    track('left', -4, 0, 4, 0),
    track('selected', 4, 0, 8, 4),
    track('right', 8, 4, 8, 12),
  ];
  board.vias = [{ id: 'foreign', x: 1, y: 1, diameter: 0.5, drill: 0.2, netId: 'gnd' }];
  for (const obstacleMode of ['walk-around', 'shove'] as const) {
    const result = createPCBTrackDrag(board, selection('selected'), {
      clearance: 0.25,
      obstacleMode,
    }).preview({ x: -2, y: 2 });
    assert.match(result.error, /blocked/);
    assert.equal(result.board, board);
    assert.deepEqual(result.changedIds, []);
  }
});

test('a selected track group keeps relative geometry and shares one connected preview transaction', () => {
  const board = fixture();
  board.tracks = [track('left', -2, 0, 0, 0), track('a', 0, 0, 2, 0), track('b', 2, 0, 2, 2)];
  const result = createPCBTrackDrag(board, selection('a', 'b'), { clearance: 0.25 }).preview({
    x: 1,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.board.tracks.find((item) => item.id === 'a'),
    { ...board.tracks[1], start: { x: 1, y: 1 }, end: { x: 3, y: 1 } },
  );
  assert.deepEqual(
    result.board.tracks.find((item) => item.id === 'b'),
    { ...board.tracks[2], start: { x: 3, y: 1 }, end: { x: 3, y: 3 } },
  );
  assert.ok(connected(result.board, 'a').has('left'));
  assert.ok(connected(result.board, 'a').has('b'));
});

test('a straight bridge attached to two moved group endpoints translates without angle normalization', () => {
  const board = fixture();
  board.tracks = [track('a', -2, 0, 0, 0), track('bridge', 0, 0, 4, 2), track('b', 4, 2, 6, 2)];
  const result = createPCBTrackDrag(board, selection('a', 'b'), { clearance: 0.25 }).preview({
    x: 1,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.equal(result.board.tracks.length, 3);
  assert.deepEqual(result.board.tracks[1], {
    ...board.tracks[1],
    start: { x: 1, y: 1 },
    end: { x: 5, y: 3 },
  });
});

test('shared branches stay fixed and gain a reconnect without moving their original copper', () => {
  const board = fixture();
  board.tracks = [
    track('selected', 0, 0, 4, 0),
    track('left', -2, 0, 0, 0),
    track('branch', 0, -2, 0, 0),
  ];
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: 0,
    y: 1,
  });
  assert.equal(result.error, '');
  for (const id of ['left', 'branch'])
    assert.deepEqual(
      result.board.tracks.find((item) => item.id === id),
      board.tracks.find((item) => item.id === id),
    );
  assert.equal(result.board.tracks.length, 4);
  assert.deepEqual(
    connected(result.board, 'selected'),
    new Set(result.board.tracks.map((item) => item.id)),
  );
});

test('interior T and crossing contacts remain connected without translating the fixed pass-through track', () => {
  const board = fixture();
  board.tracks = [track('selected', -4, 0, 4, 0), track('crossing', 0, -3, 0, 3)];
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: 0,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.board.tracks.find((item) => item.id === 'crossing'),
    board.tracks[1],
  );
  assert.ok(connected(result.board, 'selected').has('crossing'));
});

test('an interior T branch endpoint stays fixed and receives a reconnect stub', () => {
  const board = fixture();
  board.tracks = [track('selected', -4, 0, 4, 0), track('branch', 0, 0, 0, -3)];
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: 0,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.board.tracks.find((item) => item.id === 'branch'),
    board.tracks[1],
  );
  assert.equal(result.board.tracks.length, 3);
  assert.ok(connected(result.board, 'selected').has('branch'));
});

test('drag reconnects preserve existing source order and canonical UUID/order uniqueness through roundtrip', () => {
  const board = fixture(),
    netId = uid();
  board.nets = [{ id: netId, name: 'OUT' }];
  board.tracks = [
    track('selected', 0, 0, 4, 0),
    track('left', -2, 0, 0, 0),
    track('branch', 0, -2, 0, 0),
  ].map((item) => ({ ...item, id: uid(), netId }));
  const originalIds = board.tracks.map((item) => item.id);
  const result = createPCBTrackDrag(board, selection(originalIds[0]), { clearance: 0.25 }).preview({
    x: 0,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.board.tracks.slice(0, 3).map((item) => item.id),
    originalIds,
  );
  assert.equal(result.board.tracks.length, 4);
  const project = { ...createProject(), pcb: result.board };
  const source = serializeProject(project),
    document = JSON.parse(source);
  const tracks = document.schematic.nets.flatMap(
    (net: { pcb?: { tracks?: { id: string; order: number }[] } }) => net.pcb?.tracks ?? [],
  );
  assert.equal(new Set(tracks.map((item: { id: string }) => item.id)).size, tracks.length);
  assert.equal(new Set(tracks.map((item: { order: number }) => item.order)).size, tracks.length);
  assert.deepEqual(
    tracks.map((item: { order: number }) => item.order),
    [0, 1, 2, 3],
  );
  assert.deepEqual(parseProject(source).pcb, result.board);
});

test('via-anchored detour reconnects contain coordinate-only points and survive canonical roundtrip', () => {
  const board = fixture(),
    out = uid(),
    ground = uid(),
    selectedId = uid();
  board.nets = [
    { id: out, name: 'OUT' },
    { id: ground, name: 'GND' },
  ];
  board.tracks = [{ ...track(selectedId, -3, 0, 3, 0), netId: out }];
  board.vias = [
    { id: uid(), x: 0, y: 0, diameter: 1, drill: 0.3, netId: out },
    { id: uid(), x: 0, y: 1.5, diameter: 0.6, drill: 0.2, netId: ground },
  ];
  const before = structuredClone(board),
    result = createPCBTrackDrag(board, selection(selectedId), { clearance: 0.25 }).preview({
      x: 0,
      y: 3,
    });
  assert.equal(result.error, '');
  assert.ok(
    result.board.tracks.length > 2,
    'The fixed via reconnect detours around the foreign via.',
  );
  for (const item of result.board.tracks)
    for (const point of [item.start, item.end])
      assert.deepEqual(Object.keys(point).sort(), ['x', 'y']);
  assert.deepEqual(
    parseProject(serializeProject({ ...createProject(), pcb: result.board })).pcb,
    result.board,
  );
  assert.deepEqual(board, before);
});

test('width-only copper contacts reconnect even when their centerlines and endpoints differ', () => {
  const board = fixture();
  board.tracks = [track('selected', -3, 0, 3, 0), track('touching', -1, 0.3, 1, 0.3)];
  const before = structuredClone(board);
  assert.ok(connected(board, 'selected').has('touching'));
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: 0,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.ok(connected(result.board, 'selected').has('touching'));
  assert.deepEqual(board, before);
});

test('width-only endpoint contacts keep the original neighbouring copper fixed', () => {
  const board = fixture();
  board.tracks = [track('selected', 0, 0, 4, 0), track('touching', 0, 0.3, 4, 0.3)];
  const before = structuredClone(board);
  const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
    x: 0,
    y: 1,
  });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.board.tracks.find((item) => item.id === 'touching'),
    board.tracks[1],
  );
  assert.ok(connected(result.board, 'selected').has('touching'));
  assert.ok(
    result.board.tracks.length > board.tracks.length,
    'A checked reconnect retains the width contact.',
  );
  assert.deepEqual(board, before);
});

test('off-center pass-through pads and via annuli remain fixed electrical anchors across layers', () => {
  for (const kind of ['pad', 'via']) {
    const board = fixture(),
      part = pad();
    board.tracks = [
      track('selected', -3, 0.3, 3, 0.3),
      { ...track('back', 0, 0, 0, -3), layer: 'B.Cu' },
    ];
    if (kind === 'pad') {
      part.rotation = 30;
      board.footprints = [part];
    } else board.vias = [{ id: 'via', x: 0, y: 0, diameter: 1, drill: 0.3, netId: 'out' }];
    const before = structuredClone(board),
      result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
        x: 0,
        y: 2,
      });
    assert.equal(result.error, '');
    assert.ok(connected(result.board, 'selected').has('back'));
    assert.deepEqual(result.board.footprints, board.footprints);
    assert.deepEqual(result.board.vias, board.vias);
    assert.deepEqual(
      result.board.tracks.find((item) => item.id === 'back'),
      board.tracks[1],
    );
    assert.deepEqual(board, before);
  }
});

test('reconnects walk around hidden foreign copper and reuse stable fresh IDs across previews', () => {
  const board = fixture();
  board.tracks = [track('selected', -3, 0, 3, 0)];
  board.footprints = [pad()];
  board.vias = [{ id: 'foreign', x: 0, y: 1.5, diameter: 0.6, drill: 0.2, netId: 'gnd' }];
  const plan = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 });
  const a = plan.preview({ x: 0, y: 3 }),
    b = plan.preview({ x: 0, y: 3 });
  assert.equal(a.error, '');
  assert.ok(a.board.tracks.length > 2, 'The fixed-pad reconnect detours around the foreign via.');
  assert.deepEqual(a, b, 'Repeated previews keep the same generated reconnect identities.');
  assert.equal(new Set(a.board.tracks.map((item) => item.id)).size, a.board.tracks.length);
  for (const item of a.board.tracks) {
    assert.equal(item.width, board.tracks[0].width);
    assert.equal(item.netId, 'out');
    assert.equal(item.layer, 'F.Cu');
    assert.equal(
      createPCBRouter(a.board, {
        layer: item.layer,
        netId: item.netId,
        width: item.width,
        clearance: 0.25,
      }).validate([item.start, item.end]),
      '',
    );
  }
});

test('a blocked terminal reconnect discards an earlier valid pose and leaves later retries exact', () => {
  const board = fixture();
  board.tracks = [track('selected', -1, 0, 1, 0)];
  board.vias = [{ id: 'terminal', x: 0, y: 0, diameter: 1, drill: 0.3, netId: 'out' }];
  const rectangle = (extent: number) => [
    { x: -extent, y: -extent },
    { x: extent, y: -extent },
    { x: extent, y: extent },
    { x: -extent, y: extent },
  ];
  board.zones = [
    {
      id: 'closed-rule-area',
      netId: null,
      layer: 'F.Cu',
      outline: rectangle(3),
      holes: [rectangle(2)],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      keepout: { tracks: true, vias: false, pads: false, copperpour: false, footprints: false },
    },
  ];
  const before = structuredClone(board);
  for (const posture of [false, true]) {
    const engine = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 });
    const valid = engine.preview({ x: 0, y: 1 }, posture);
    assert.equal(valid.error, '');
    assert.ok(valid.board.tracks.length > board.tracks.length, 'The fixed via needs a reconnect.');
    const blocked = engine.preview({ x: 0, y: 5 }, posture);
    assert.match(blocked.error, /Route blocked/);
    assert.equal(blocked.board, board);
    assert.deepEqual(blocked.changedIds, []);
    assert.deepEqual(engine.preview({ x: 0, y: 1 }, posture), valid);
    assert.deepEqual(engine.preview({ x: 0, y: 0 }, posture), { board, error: '', changedIds: [] });
  }
  assert.deepEqual(board, before);
});

test('collision, board-edge and explicit keepout failures return the untouched complete basis', () => {
  for (const obstacle of ['copper', 'edge', 'keepout', 'lettering']) {
    const board = fixture();
    board.tracks = [track('selected', -2, 0, 2, 0)];
    if (obstacle === 'copper')
      board.tracks.push({ ...track('foreign', -3, 2, 3, 2), netId: 'gnd' });
    if (obstacle === 'edge')
      board.graphics = [
        {
          id: 'edge',
          kind: 'polygon',
          layer: 'Edge.Cuts',
          width: 0.1,
          start: { x: -3, y: -1 },
          points: [
            { x: 3, y: -1 },
            { x: 3, y: 2.3 },
          ],
          end: { x: -3, y: 2.3 },
        },
      ];
    if (obstacle === 'keepout')
      board.zones = [
        {
          id: 'keepout',
          netId: null,
          layer: 'F.Cu',
          outline: [
            { x: -3, y: 1 },
            { x: 3, y: 1 },
            { x: 3, y: 3 },
            { x: -3, y: 3 },
          ],
          clearance: 0.25,
          minThickness: 0.2,
          thermalGap: 0.3,
          thermalBridge: 0.3,
          keepout: { tracks: true, vias: false, pads: false, copperpour: false, footprints: false },
        },
      ];
    if (obstacle === 'lettering')
      board.graphics = [
        {
          id: 'text',
          kind: 'text',
          layer: 'F.Cu',
          start: { x: 0, y: 2 },
          end: { x: 0, y: 2 },
          width: 0.1,
          text: { value: 'X', rotation: 0, size: { x: 0.1, y: 0.1 }, thickness: 0.05 },
        },
      ];
    const before = structuredClone(board),
      result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
        x: 0,
        y: 2,
      });
    assert.match(result.error, /blocked/);
    assert.equal(result.board, board);
    assert.deepEqual(result.changedIds, []);
    assert.deepEqual(board, before);
  }
});

test('source widths outside new-track controls remain exact and saved fills are never recalculated', () => {
  for (const width of [0.000001, 25]) {
    const board = fixture();
    board.tracks = [{ ...track('selected', -2, 0, 2, 0), width }];
    board.zones = [
      {
        id: 'pour',
        netId: 'out',
        layer: 'F.Cu',
        outline: [
          { x: -3, y: -3 },
          { x: 3, y: -3 },
          { x: 3, y: 3 },
          { x: -3, y: 3 },
        ],
        clearance: 0.25,
        minThickness: 0.2,
        thermalGap: 0.3,
        thermalBridge: 0.3,
        filledPolygons: [],
      },
    ];
    const result = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 }).preview({
      x: 0,
      y: 1,
    });
    assert.equal(result.error, '');
    assert.equal(result.board.tracks[0].width, width);
    assert.equal(result.board.zones, board.zones);
  }
});

test('zero/parallel motion stays clean; invalid settings/selections and geometry fail visibly and atomically', () => {
  const board = fixture();
  board.tracks = [track('selected', -2, 0, 2, 0)];
  const plan = createPCBTrackDrag(board, selection('selected'), { clearance: 0.25 });
  for (const delta of [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
  ])
    assert.deepEqual(plan.preview(delta), { board, error: '', changedIds: [] });
  assert.match(plan.preview({ x: NaN, y: 0 }).error, /coordinates/);
  assert.match(
    createPCBTrackDrag(board, [{ kind: 'via', id: 'missing' }], { clearance: 0.25 }).preview({
      x: 0,
      y: 1,
    }).error,
    /Select existing tracks/,
  );
  assert.match(
    createPCBTrackDrag(board, selection('selected'), { clearance: 0 }).preview({ x: 0, y: 1 })
      .error,
    /clearance/,
  );
  const large = fixture();
  large.tracks = Array.from({ length: 257 }, (_, i) => track(`track-${i}`, i, 0, i + 0.5, 0));
  const result = createPCBTrackDrag(large, selection(...large.tracks.map((item) => item.id)), {
    clearance: 0.25,
  }).preview({ x: 0, y: 1 });
  assert.match(result.error, /geometry limit/);
  assert.equal(result.board, large);
  assert.deepEqual(result.changedIds, []);
});
