import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectCore } from '../core/project-core';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { defaultPCBDisplay, pcbDisplayBounds, pcbDisplayLayers } from '../lib/pcb-display';
import { pcbReferenceImages } from '../lib/pcb-reference-image';
import { parseProject, serializeProject } from '../lib/project';
import { children, parseSExpr } from '../lib/sexpr';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XmfcAAAAASUVORK5CYII=';
const id = 'b1308a10-16da-4d5b-9ca8-0d19372e7ae0';
const name = 'Artwork.kicad_pcb';
const source = `(kicad_pcb
  (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (17 "Dwgs.User" user))
  (setup (pad_to_mask_clearance 0))
  (image (at 140 42) (layer "Dwgs.User") (scale 2) (locked yes) (uuid "${id}")
    (data "${png}"))
)
`;
const load = (text: string) =>
  projectFromNativeFiles({
    entry: name,
    files: [{ name, source: text }],
  });

test('native PCB PNG references retain original data and present their scaled position', () => {
  const opened = load(source);
  const board = parseProject(serializeProject(opened)).pcb!;
  const records = children(parseSExpr(source), 'image');
  assert.deepEqual(board.referenceImages, records);
  const [image] = pcbReferenceImages(board.referenceImages);
  assert.equal(image.id, id);
  assert.equal(image.layer, 'Dwgs.User');
  assert.equal(image.href, `data:image/png;base64,${png}`);
  assert.equal(image.width, (25.4 * 2) / 300);
  assert.equal(image.x, 140 - image.width / 2);
  assert.ok(pcbDisplayLayers(board).includes(image.layer));
  const display = defaultPCBDisplay();
  const withoutImage = pcbDisplayBounds(board, 'all', display);
  const withImage = pcbDisplayBounds(board, 'all', { ...display, [image.layer]: true });
  assert.equal(withImage.maxX, image.x + image.width);
  assert.ok(withoutImage.maxX < withImage.maxX);

  const core = new ProjectCore(opened);
  assert.equal(core.getNativeFiles().files.find((file) => file.name === name)?.source, source);
  const before = core.getSnapshot().project!.pcb!;
  assert.ok(core.replaceBoard({ ...before, thickness: 1.7 }));
  const saved = core.getNativeFiles();
  const sourceAfter = saved.files.find((file) => file.name === name)!.source;
  assert.deepEqual(children(parseSExpr(sourceAfter), 'image'), records);
  assert.deepEqual(projectFromNativeFiles(saved).pcb?.referenceImages, records);
});

test('native PCB reference images reject external artwork and duplicate fields', () => {
  assert.throws(() => load(source.replace(png, 'PHN2Zz4=')), /Unsupported reference image/);
  assert.throws(
    () => load(source.replace('(scale 2)', '(layer "F.Cu") (scale 2)')),
    /Unsupported reference image/,
  );
});
