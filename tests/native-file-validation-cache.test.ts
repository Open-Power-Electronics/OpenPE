import test from 'node:test';
import assert from 'node:assert/strict';
import { ownProjectData } from '../lib/immutable-project';
import { MAX_PROJECT_BYTES } from '../lib/project';
import {
  validateKiCadProjectFiles,
  type KiCadProjectFile,
  type KiCadProjectFiles,
} from '../lib/kicad-project';

const entry: KiCadProjectFile = { name: 'Root.kicad_pro', source: '' };
const bundle = (files: KiCadProjectFile[], name = entry.name): KiCadProjectFiles => ({
  entry: name,
  files,
});
const own = (file: KiCadProjectFile) => ownProjectData(file);

test('owned native packets retain exact ASCII, Unicode and Latin-1 encoded byte limits', () => {
  for (const source of [
    'x'.repeat(MAX_PROJECT_BYTES),
    'é'.repeat(MAX_PROJECT_BYTES / 2),
    '😀'.repeat(MAX_PROJECT_BYTES / 4),
    '\ud800'.repeat(Math.floor(MAX_PROJECT_BYTES / 3)) + 'aa',
  ]) {
    const file = own({ name: 'models/Unicode.lib', source });
    const files = bundle([own(entry), file]);
    validateKiCadProjectFiles(files);
    validateKiCadProjectFiles({ ...files, files: files.files.slice() });
    validateKiCadProjectFiles(structuredClone(files));
    for (const changed of [
      own({ ...file, source: source + 'x' }),
      { ...file, source: source + 'x' },
    ])
      assert.throws(() => validateKiCadProjectFiles(bundle([entry, changed])), /exceeds 8 MB/);
  }
  const vendor = own({
    name: 'models/Vendor.lib',
    source: 'ÿ'.repeat(MAX_PROJECT_BYTES),
    encoding: 'latin1',
  });
  validateKiCadProjectFiles(bundle([own(entry), vendor]));
  validateKiCadProjectFiles(bundle([own(entry), vendor]));
  for (const source of [vendor.source + 'x', 'Ω', '\ud800', '\0'])
    assert.throws(() => validateKiCadProjectFiles(bundle([entry, own({ ...vendor, source })])));
  for (const name of ['Other.kicad_pro', 'Other.kicad_sch', 'Other.kicad_pcb'])
    assert.throws(
      () => validateKiCadProjectFiles(bundle([entry, own({ ...vendor, name, source: 'ÿ' })])),
      /must be UTF-8/,
    );
});

test('every bundle rechecks names, entry, supported counts and aggregate bytes around cached packets', () => {
  const files = [
    own(entry),
    own({ name: 'parts.lib', source: 'x' }),
    own({ name: 'PARTS.lib', source: 'x' }),
    own({ name: 'parts.lib/child.lib', source: 'x' }),
    own({ name: 'Second.kicad_pro', source: '{}' }),
    ...Array.from({ length: 2 }, (_, index) => own({ name: `${index}.kicad_pcb`, source: '' })),
    ...Array.from({ length: 13 }, (_, index) => own({ name: `${index}.kicad_sch`, source: '' })),
  ];
  for (const file of files)
    validateKiCadProjectFiles(
      /\.kicad_(?:pro|sch|pcb)$/i.test(file.name)
        ? bundle([file], file.name)
        : bundle([files[0], file]),
    );
  const verify = (candidate: KiCadProjectFiles, error: RegExp) => {
    assert.throws(() => validateKiCadProjectFiles(candidate), error);
    assert.throws(() => validateKiCadProjectFiles(structuredClone(candidate)), error);
  };
  verify(bundle([files[0], files[1], files[2]]), /duplicate file/);
  verify(bundle([files[0], files[1], files[3]]), /overlap/);
  verify(bundle([files[0]], 'Missing.kicad_pro'), /entry file is missing/);
  verify(bundle([files[0], files[4]]), /one KiCad project/);
  verify(bundle([files[0], files[5], files[6]]), /one PCB/);
  verify(bundle([files[0], ...files.slice(7)]), /up to 12 schematic/);
  verify(bundle([]), /1–128 text files/);
  verify(
    bundle([
      files[0],
      ...Array.from({ length: 128 }, (_, i) => own({ name: `${i}.lib`, source: '' })),
    ]),
    /1–128 text files/,
  );
  const source = 'x'.repeat(MAX_PROJECT_BYTES);
  const large = Array.from({ length: 12 }, (_, i) => own({ name: `${i}.lib`, source }));
  const maximum = bundle([files[0], ...large]);
  validateKiCadProjectFiles(maximum);
  validateKiCadProjectFiles({ ...maximum, files: maximum.files.slice().reverse() });
  assert.throws(
    () =>
      validateKiCadProjectFiles(
        bundle([...maximum.files, own({ name: 'Extra.lib', source: 'x' })]),
      ),
    /exceeds 96 MB/,
  );
  validateKiCadProjectFiles(maximum);
});

test('new packets recheck changed text, encoding, names and unknown keys after successful validation', () => {
  const file = own({ name: 'models/Vendor.lib', source: 'Valid' });
  validateKiCadProjectFiles(bundle([own(entry), file]));
  for (const invalid of [
    { ...file, source: 'Invalid\0text' },
    { ...file, source: 42 },
    { ...file, encoding: 'utf16' },
    { ...file, name: '../Vendor.lib' },
    { ...file, name: 'models/unsupported.txt' },
    { ...file, extra: 'Unsupported key' },
    { ...file, encoding: 'latin1', source: 'Ω' },
  ]) {
    assert.throws(() => validateKiCadProjectFiles(bundle([entry, invalid as KiCadProjectFile])));
    assert.throws(() =>
      validateKiCadProjectFiles(bundle([entry, own(invalid as KiCadProjectFile)])),
    );
  }
  assert.throws(() => validateKiCadProjectFiles({ ...bundle([entry, file]), extra: true }));
  validateKiCadProjectFiles(bundle([entry, file]));
});

test('mutable and caller-frozen getter packets cannot reuse internally owned acceptance', () => {
  const mutable = { name: 'models/Mutable.lib', source: 'Valid' };
  validateKiCadProjectFiles(bundle([entry, mutable]));
  mutable.source = '\0';
  assert.throws(() => validateKiCadProjectFiles(bundle([entry, mutable])), /supported KiCad text/);
  let source = 'Valid';
  const frozen = Object.freeze({
    name: 'models/Frozen.lib',
    get source() {
      return source;
    },
  });
  validateKiCadProjectFiles(bundle([entry, frozen]));
  const detached = own(frozen);
  validateKiCadProjectFiles(bundle([own(entry), detached]));
  source = '\0';
  assert.throws(() => validateKiCadProjectFiles(bundle([entry, frozen])), /supported KiCad text/);
  assert.equal(detached.source, 'Valid');
  validateKiCadProjectFiles(bundle([entry, detached]));
});
