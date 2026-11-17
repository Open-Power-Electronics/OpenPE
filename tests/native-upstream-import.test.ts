import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import catalog from '../resources/example-catalog/manifest.json';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/project';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import {
  movePCBSelection,
  rotatePCBSelection,
  deletePCBSelection,
  flipPCBFootprint,
} from '../lib/pcb-layout';

for (const entry of catalog.examples) {
  test(`${entry.file}: unprepared upstream native files retain metadata, locks and copper through ordinary edits`, async () => {
    const schematic = await readFile(entry.source.schematic.path, 'utf8');
    const pcb = await readFile(entry.source.pcb.path, 'utf8');
    const native = {
      entry: 'Customer.kicad_sch',
      files: [
        { name: 'Customer.kicad_sch', source: schematic },
        { name: 'Customer.kicad_pcb', source: pcb },
      ],
    };
    const project = projectFromNativeFiles(native);
    const clean = projectNativeFiles(project);
    for (const file of native.files)
      assert.equal(clean.files.find((item) => item.name === file.name)?.source, file.source);
    const board = project.pcb!;
    const changed = {
      ...project,
      pcb: { ...board, thickness: Number((board.thickness + 0.1).toFixed(6)) },
    };
    const written = projectNativeFiles(changed);
    const reopened = projectFromNativeFiles(written);
    assert.equal(reopened.pcb!.thickness, changed.pcb.thickness);
    assert.deepEqual(
      reopened.pcb!.zones,
      board.zones,
      'Layer instances retain their identities, saved copper and rules.',
    );
    const before = parseSExpr(pcb);
    const after = parseSExpr(
      written.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source,
    );
    for (const old of children(before, 'footprint')) {
      const next = children(after, 'footprint').find(
        (item) => val(child(item, 'uuid')) === val(child(old, 'uuid')),
      )!;
      assert.ok(next);
      assert.deepEqual(child(next, 'units'), child(old, 'units'));
      for (const property of children(old, 'property').filter(
        (item) => !child(item, 'at') && !child(item, 'effects'),
      ))
        assert.deepEqual(
          children(next, 'property').find((item) => val(item) === val(property)),
          property,
        );
      for (const pad of children(old, 'pad')) {
        const nextPad = children(next, 'pad').find(
          (item) => val(child(item, 'uuid')) === val(child(pad, 'uuid')),
        )!;
        assert.ok(nextPad);
        for (const key of ['pinfunction', 'pintype'])
          assert.deepEqual(child(nextPad, key), child(pad, key));
      }
    }
    for (const footprint of board.footprints.filter((item) => item.locked)) {
      const selection = [{ kind: 'footprint' as const, id: footprint.id }];
      assert.throws(() => movePCBSelection(board, selection, { x: 1, y: 0 }), /Unlock/);
      assert.throws(() => rotatePCBSelection(board, selection), /Unlock/);
      assert.throws(() => deletePCBSelection(board, selection), /Unlock/);
      assert.throws(() => flipPCBFootprint(footprint), /Unlock/);
      assert.equal(reopened.pcb!.footprints.find((item) => item.id === footprint.id)!.locked, true);
    }
    for (const graphic of board.graphics.filter((item) => item.locked)) {
      assert.throws(
        () => movePCBSelection(board, [{ kind: 'graphic', id: graphic.id }], { x: 1, y: 0 }),
        /Unlock/,
      );
      assert.equal(reopened.pcb!.graphics.find((item) => item.id === graphic.id)!.locked, true);
    }
  });
}
