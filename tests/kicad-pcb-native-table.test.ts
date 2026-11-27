import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectCore } from '../core/project-core';
import { pcbTableDrawings } from '../lib/kicad-pcb';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { parseProject, serializeProject } from '../lib/project';
import { children, parseSExpr } from '../lib/sexpr';

const name = 'Table.kicad_pcb';
const cell = (row: number, column: number) => {
  const x = column ? 145 : 140;
  const y = 40 + row * 3;
  const id = `b1308a10-16da-4d5b-9ca8-0d19372e7ae${row * 2 + column}`;
  return `(table_cell "${row},${column}" (start ${x} ${y})
    (end ${x + (column ? 7 : 5)} ${y + 3})
    (margins 0.1 0.2 0.3 0.4) (span 1 1) (layer "Dwgs.User") (uuid "${id}")
    (effects (font (size 1.27 1.27)) (justify left)))`;
};
const source = `(kicad_pcb
  (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (17 "Dwgs.User" user))
  (setup (pad_to_mask_clearance 0))
  (table (column_count 2) (uuid "a2c3e025-5d7e-4d16-8f9a-48ce25156ea1") (layer "Dwgs.User")
    (border (external yes) (header yes) (stroke (width 0.12) (type dash)))
    (separators (rows no) (cols yes) (stroke (width 0.22) (type dot)))
    (column_widths 5 7) (row_heights 3 3)
    (cells ${cell(0, 0)} ${cell(0, 1)} ${cell(1, 0)} ${cell(1, 1)}))
)
`;
const load = (text: string) =>
  projectFromNativeFiles({ entry: name, files: [{ name, source: text }] });

test('native PCB table paints distinct header, separator and outer strokes', () => {
  const project = load(source);
  const board = parseProject(serializeProject(project)).pcb!;
  const records = children(parseSExpr(source), 'table');
  assert.deepEqual(board.nativeTables, records);
  const [table] = pcbTableDrawings(board.nativeTables);
  assert.equal(table.layer, 'Dwgs.User');
  assert.deepEqual(
    table.graphics.slice(0, 4).map((graphic) => graphic.text?.value),
    ['0,0', '0,1', '1,0', '1,1'],
  );
  assert.deepEqual(table.graphics[0].textBox?.margins, [0.1, 0.2, 0.3, 0.4]);
  const borders = table.graphics.slice(4);
  assert.equal(borders.length, 8);
  assert.deepEqual(
    borders.slice(0, 2).map(({ start, end, width, stroke }) => ({ start, end, width, stroke })),
    [
      { start: { x: 145, y: 40 }, end: { x: 145, y: 43 }, width: 0.12, stroke: 'dash' },
      { start: { x: 145, y: 43 }, end: { x: 145, y: 46 }, width: 0.22, stroke: 'dot' },
    ],
  );
  const core = new ProjectCore(project);
  assert.equal(core.getNativeFiles().files.find((file) => file.name === name)?.source, source);
  assert.ok(core.replaceBoard({ ...core.getSnapshot().project!.pcb!, thickness: 1.7 }));
  const edited = core.getNativeFiles();
  const next = edited.files.find((file) => file.name === name)!.source;
  assert.deepEqual(children(parseSExpr(next), 'table'), records);
  assert.deepEqual(projectFromNativeFiles(edited).pcb?.nativeTables, records);
});

test('native PCB tables reject merged spans and non-rectangular cell extents', () => {
  assert.throws(
    () => load(source.replace('(span 1 1)', '(span 2 1)')),
    /Unsupported native PCB table/,
  );
  assert.throws(
    () => load(source.replace('(end 145 43)', '(end 145.5 43)')),
    /Unsupported native PCB table/,
  );
});
