import { resolveExampleModelRelative } from '../lib/example-model-paths';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { footprintModels, resolveFootprintModels } from '../lib/pcb-models';
import { flipPCBFootprint } from '../lib/pcb-layout';
import { parseProject, serializeProject } from '../lib/project';
import { parseSExpr } from '../lib/sexpr';
import manifest from '../resources/example-catalog/manifest.json';
import assets from '../resources/example-catalog/footprints/manifest.json';

function official(id: string) {
  const [library, name] = id.split(':');
  const jst = library === 'Connector_JST';
  assert.ok(jst || library === 'Connector_PinHeader_2.00mm');
  // Minimal official anchors keep unit tests independent of downloaded libraries.
  // Complete KiCad details and real STEP geometry are covered by the renderer check.
  return parseSExpr(`(footprint "${name}"
    (pad "1" thru_hole rect (at 0 0))
    (pad "2" thru_hole oval (at ${jst ? '2 0' : '0 2'}))
    (model "\${KICAD10_3DMODEL_DIR}/${library}.3dshapes/${name}.step"))`);
}
const project = () =>
  parseProject(readFileSync('tests/fixtures/reference/lm2735-msop8-sepic.json', 'utf8'));

test('reanchored JST and pin-header models align with their embedded pads without changing project data', () => {
  const p = project();
  const connectors = p.pcb!.footprints.filter((f) => f.libraryId.startsWith('Connector_'));
  assert.equal(connectors.length, 3);
  for (const f of connectors) {
    const expected = structuredClone(f.models!);
    // Fallback metadata keeps the official library reference; portable example
    // links name the same STEP bytes beside the project.
    expected.forEach((model) => {
      model.path =
        '${KICAD10_3DMODEL_DIR}/' +
        resolveExampleModelRelative(Object.keys(assets.models), model.path)!;
    });
    delete f.models;
    const source = serializeProject(p);
    const detail = official(f.libraryId);
    assert.notDeepEqual(
      footprintModels(detail),
      expected,
      'The official origin differs from the embedded origin.',
    );
    assert.deepEqual(resolveFootprintModels(f, detail), expected);
    assert.deepEqual(
      resolveFootprintModels(flipPCBFootprint(f), detail),
      expected,
      'Back-side native pad mirroring does not change model-local offsets.',
    );
    assert.equal(serializeProject(p), source, 'Loading models is read-only.');
  }
});

test('explicit model transforms and explicit empty model assignments remain authoritative', () => {
  const f = project().pcb!.footprints.find((f) => f.libraryId.startsWith('Connector_JST:'))!;
  const detail = official(f.libraryId);
  f.models![0].offset.z = 2;
  f.models![0].rotation.z = 30;
  f.models![0].scale.x = 1.5;
  assert.equal(resolveFootprintModels(f, detail), f.models);
  f.models = [];
  assert.deepEqual(resolveFootprintModels(f, detail), []);
});

test('fallback refuses inconsistent pad positions, missing pins and mismatched duplicate pads', () => {
  const f = project().pcb!.footprints.find((f) => f.libraryId.startsWith('Connector_JST:'))!;
  delete f.models;
  const detail = official(f.libraryId);
  const mismatch = structuredClone(f);
  mismatch.pads[1].y += 0.5;
  assert.throws(() => resolveFootprintModels(mismatch, detail), /cannot be aligned/);
  mismatch.pads = [mismatch.pads[0]];
  assert.throws(() => resolveFootprintModels(mismatch, detail), /cannot be aligned/);
  mismatch.pads = [...f.pads, { ...f.pads[0], id: 'duplicate' }];
  assert.throws(() => resolveFootprintModels(mismatch, detail), /cannot be aligned/);
});

test('every curated example retains its original model placements through load and save', () => {
  for (const entry of manifest.examples) {
    const p = parseProject(readFileSync(`tests/fixtures/reference/${entry.file}.json`, 'utf8'));
    const saved = parseProject(serializeProject(p));
    for (const f of p.pcb!.footprints) {
      assert.ok(f.models?.length, `${entry.id}: ${f.libraryId} retains model metadata.`);
      assert.deepEqual(saved.pcb!.footprints.find((n) => n.id === f.id)!.models, f.models);
    }
  }
});
