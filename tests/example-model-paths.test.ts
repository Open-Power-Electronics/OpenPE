import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exampleModelPath,
  modelReferenceKey,
  portableExampleModelSource,
  resolveExampleModelRelative,
} from '../lib/example-model-paths';
import boost from '../resources/example-catalog/footprints/manifest.json';
import emc from '../resources/example-catalog/emc-flyback-assets.json';

test('flat STEP filenames retain pinned identities and disambiguate different bytes with the same basename', () => {
  const seen = new Map<string, string>();
  for (const [relative, entry] of [
    ...Object.entries(boost.models),
    ...Object.entries(emc.models),
  ]) {
    const file = exampleModelPath(relative);
    assert.match(file, /^models\/[^/]+\.step$/);
    assert.equal(seen.get(file) ?? entry.sha256, entry.sha256);
    seen.set(file, entry.sha256);
    assert.equal(modelReferenceKey('$' + '{KIPRJMOD}/' + file), entry.sha256);
    for (const prefix of ['models/', 'footprints/models/'])
      assert.equal(modelReferenceKey('$' + '{KIPRJMOD}/' + prefix + relative), entry.sha256);
    for (const prefix of ['footprints/', '3D/']) {
      const legacy = '$' + '{KIPRJMOD}/' + prefix + file.slice('models/'.length);
      assert.equal(modelReferenceKey(legacy), entry.sha256);
      assert.equal(resolveExampleModelRelative([relative], legacy), relative);
    }
  }
  const name = 'SOIC-8_3.9x4.9mm_P1.27mm.step';
  assert.notEqual(
    exampleModelPath('Package_SO.3dshapes/' + name),
    exampleModelPath('emc-flyback-demo/' + name),
  );
  assert.equal(resolveExampleModelRelative(Object.keys(boost.models), '../secret.step'), undefined);
  assert.throws(() => exampleModelPath('../secret.step'));
});

test('build-only model relocation normalizes exact pinned aliases while retaining unknown references and transforms', () => {
  const relative = 'Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step';
  const portable = exampleModelPath(relative);
  const preserved =
    '(offset (xyz 1.25 -2.5 3.75)) (scale (xyz 1 2 3)) (rotate (xyz 90 0 180)) hide';
  for (const alias of [
    'models/' + relative,
    'footprints/models/' + relative,
    'footprints/' + portable.slice('models/'.length),
    '3D/' + portable.slice('models/'.length),
    portable,
  ])
    assert.equal(
      portableExampleModelSource(`(model "\${KIPRJMOD}/${alias}" ${preserved})`),
      `(model "\${KIPRJMOD}/${portable}" ${preserved})`,
    );
  const unknown = '(model "${KIPRJMOD}/footprints/personal.step" (offset (xyz 1 2 3)))';
  assert.equal(portableExampleModelSource(unknown), unknown);
});
