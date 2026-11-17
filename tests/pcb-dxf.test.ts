import assert from 'node:assert/strict';
import test from 'node:test';
import { uid } from '../lib/circuit';
import { exportBoardOutlineDxf } from '../lib/pcb-dxf';
import { manufacturingProject } from './manufacturing-fixture';

function readDxf(source: string) {
  const lines = source.trimEnd().split('\r\n');
  assert.equal(lines.length % 2, 0);
  const pairs: [number, string][] = [];
  for (let index = 0; index < lines.length; index += 2)
    pairs.push([Number(lines[index]), lines[index + 1]]);
  assert.deepEqual(pairs.slice(0, 2), [
    [0, 'SECTION'],
    [2, 'HEADER'],
  ]);
  assert.deepEqual(pairs.at(-1), [0, 'EOF']);
  const offset = pairs.findIndex(([code, value]) => code === 2 && value === 'ENTITIES');
  assert.ok(offset > 0);
  const header = new Map<string, string>();
  for (let index = 2; pairs[index][0] === 9; index += 2)
    header.set(pairs[index][1], pairs[index + 1][1]);
  const entities: { kind: string; groups: Map<number, string[]> }[] = [];
  for (const [code, value] of pairs.slice(offset + 1)) {
    if (code === 0) {
      if (value === 'ENDSEC') break;
      entities.push({ kind: value, groups: new Map() });
    } else {
      const groups = entities.at(-1)!.groups;
      groups.set(code, [...(groups.get(code) ?? []), value]);
    }
  }
  return { header, entities };
}

test('DXF retains native analytic board outline and footprint cutouts in upward-Y millimetres', () => {
  const board = manufacturingProject().pcb!;
  board.graphics[0] = { ...board.graphics[0], kind: 'arc', mid: { x: 20, y: -20 } };
  board.graphics.push({
    id: uid(),
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.05,
    start: { x: 10, y: 10 },
    points: [
      { x: 12, y: 10 },
      { x: 12, y: 12 },
      { x: 10, y: 12 },
    ],
    end: { x: 10, y: 10 },
  });
  board.graphics.push({ ...board.graphics[1], id: uid(), layer: 'F.SilkS' });
  const footprint = board.footprints[1];
  footprint.rotation = 90;
  footprint.graphics.push({
    id: uid(),
    kind: 'circle',
    layer: 'Edge.Cuts',
    width: 0.05,
    start: { x: 1, y: 0 },
    end: { x: 2, y: 0 },
  });

  const source = exportBoardOutlineDxf(board);
  assert.equal(exportBoardOutlineDxf(board), source);
  const { header, entities } = readDxf(source);
  assert.equal(header.get('$ACADVER'), 'AC1015');
  assert.equal(header.get('$INSUNITS'), '4');
  assert.match(
    source,
    /0\r\nLAYER\r\n5\r\nF\r\n330\r\n3\r\n100\r\nAcDbSymbolTableRecord\r\n100\r\nAcDbLayerTableRecord\r\n2\r\nEdge\.Cuts\r\n/,
  );
  assert.match(
    source,
    /0\r\nBLOCK_RECORD\r\n5\r\n13\r\n330\r\n9\r\n100\r\nAcDbSymbolTableRecord\r\n100\r\nAcDbBlockTableRecord\r\n2\r\n\*Model_Space\r\n/,
  );
  assert.deepEqual(
    entities.map(({ kind }) => kind),
    ['ARC', 'LINE', 'LINE', 'LINE', 'LWPOLYLINE', 'CIRCLE'],
  );
  assert.ok(entities.every(({ groups }) => groups.get(8)?.[0] === 'Edge.Cuts'));
  assert.ok(entities.every(({ groups }) => groups.get(330)?.[0] === '13'));
  assert.equal(new Set(entities.map(({ groups }) => groups.get(5)?.[0])).size, entities.length);
  const [arc, line, , , polygon, circle] = entities.map(({ groups }) => groups);
  assert.deepEqual(
    [10, 20, 40, 50, 51].map((code) => arc.get(code)?.[0]),
    ['20', '0', '20', '0', '180'],
  );
  assert.deepEqual(
    [10, 20, 11, 21].map((code) => line.get(code)?.[0]),
    ['40', '0', '40', '-30'],
  );
  assert.deepEqual(
    [90, 70].map((code) => polygon.get(code)?.[0]),
    ['4', '1'],
  );
  assert.deepEqual(polygon.get(10), ['10', '12', '12', '10']);
  assert.deepEqual(polygon.get(20), ['-10', '-10', '-12', '-12']);
  assert.deepEqual(
    [10, 20, 40].map((code) => circle.get(code)?.[0]),
    ['5', '-4', '1'],
  );
});

test('DXF preserves the major arc in either native sweep direction', () => {
  const board = manufacturingProject().pcb!;
  const start = { x: 35, y: 20 };
  const end = { x: 30, y: 15 };
  const mid = { x: 30, y: 25 };
  for (const [first, last] of [
    [start, end],
    [end, start],
  ]) {
    board.graphics = [
      { id: uid(), kind: 'arc', start: first, mid, end: last, width: 0.05, layer: 'Edge.Cuts' },
      { id: uid(), start: last, end: first, width: 0.05, layer: 'Edge.Cuts' },
    ];
    const arc = readDxf(exportBoardOutlineDxf(board)).entities[0].groups;
    assert.deepEqual(
      [10, 20, 40, 50, 51].map((code) => arc.get(code)?.[0]),
      ['30', '-20', '5', '90', '0'],
    );
  }
});

test('DXF rejects open, unsupported and oversized outlines', () => {
  const board = manufacturingProject().pcb!;
  const closed = board.graphics;
  board.graphics = closed.slice(1);
  assert.throws(() => exportBoardOutlineDxf(board), /open or ambiguous/);
  board.graphics = [{ ...closed[0], end: { ...closed[0].end, x: 39.99995 } }, ...closed.slice(1)];
  assert.throws(() => exportBoardOutlineDxf(board), /requires exact joins/);
  board.graphics = [{ ...closed[0], stroke: 'dash' }, ...closed.slice(1)];
  assert.throws(() => exportBoardOutlineDxf(board), /solid board outline/);
  const point = { x: 50, y: 50 };
  board.graphics = [...closed, { ...closed[0], start: point, end: point }];
  assert.throws(() => exportBoardOutlineDxf(board), /zero-length line/);
  board.graphics = Array.from({ length: 5001 }, () => closed[0]);
  assert.throws(() => exportBoardOutlineDxf(board), /graphic limit/);
});
