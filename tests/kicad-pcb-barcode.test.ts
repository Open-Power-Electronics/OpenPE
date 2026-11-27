import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { pcbBarcodes } from '../lib/pcb-barcode';
import { parseProject, serializeProject } from '../lib/project';

const name = 'Barcode.kicad_pcb';
const source = `(kicad_pcb (version 20260206) (generator "pcbnew")
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (barcode (at 125 102 0) (size 16 16) (layer "Edge.Cuts") (text "OPENPE QR TEST")
    (text_height 1) (type qr) (ecc_level L) (uuid "800b831e-bdad-4262-a72f-2b366ec9a516")))\n`;

test('native QR codes preserve their payload, layer and unmodified Save As bytes', () => {
  const open = (source: string) =>
    projectFromNativeFiles({ entry: name, files: [{ name, source }] });
  const project = parseProject(serializeProject(open(source)));
  const [barcode] = pcbBarcodes(project.pcb!.barcodes);
  assert.equal(barcode.value, 'OPENPE QR TEST');
  assert.equal(barcode.layer, 'Edge.Cuts');
  assert.equal(barcode.showText, true);
  assert.equal(
    projectNativeFiles(project, 'Copy.kicad_pro').files.find(
      (file) => file.name === 'Copy.kicad_pcb',
    )?.source,
    source,
  );
  assert.throws(() => open(source.replace('(type qr)', '(type code_128)')), /unsupported barcode/i);
});
