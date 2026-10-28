import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSExpr, child, children, val, exampleModelPath } from '../server/library-format.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repository, 'resources/example-catalog/sources/emc-flyback');
const supplementalRoot = path.join(repository, 'resources/example-catalog/footprints/emc-flyback');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const sourceManifest = JSON.parse(await readFile(path.join(root, 'source-manifest.json'), 'utf8'));
if (sourceManifest.commit !== 'e1b9a64ac9ac306647fa30094932fb792d17e373')
  throw new Error('Unexpected pinned EMC source commit.');
for (const entry of sourceManifest.files) {
  if (
    !entry.path ||
    path.isAbsolute(entry.path) ||
    entry.path.split(/[\\/]/).some((segment) => !segment || segment === '..' || segment === '.')
  )
    throw new Error('Invalid pinned EMC source path.');
  if (hash(await readFile(path.join(root, entry.path))) !== entry.sha256)
    throw new Error(`Pinned EMC source checksum mismatch: ${entry.path}`);
}
const sourcePrefix = '${KIPRJMOD}/EMC_Demo.3dshapes/';
const models = {};
for (const name of (await readdir(path.join(root, 'design/EMC_Demo.3dshapes'))).sort()) {
  if (name === 'README.md') continue;
  if (!/^[\w().+-]+\.step$/i.test(name)) throw new Error('Unexpected EMC STEP asset name.');
  const file = `design/EMC_Demo.3dshapes/${name}`;
  const bytes = await readFile(path.join(root, file));
  models[`emc-flyback-demo/${name}`] = { file, sha256: hash(bytes), size: bytes.length };
}
const footprints = new Map();
const descriptor = (model) => {
  const original = val(model);
  if (!original.startsWith(sourcePrefix)) throw new Error('Unexpected EMC model reference.');
  const name = original.slice(sourcePrefix.length);
  if (!/^[\w().+-]+\.step$/i.test(name)) throw new Error('Unexpected EMC model reference name.');
  const relative = `emc-flyback-demo/${name}`;
  models[relative] ??= { missing: true };
  return {
    path: '${KIPRJMOD}/' + exampleModelPath(relative),
    offset: child(model, 'offset'),
    scale: child(model, 'scale'),
    rotate: child(model, 'rotate'),
  };
};
const board = parseSExpr(await readFile(path.join(root, 'design/emc_flyback.kicad_pcb'), 'utf8'));
for (const footprint of children(board, 'footprint')) {
  const id = val(footprint);
  const entry = footprints.get(id) ?? { id, models: [] };
  for (const model of children(footprint, 'model')) {
    const value = descriptor(model);
    if (!entry.models.some((previous) => JSON.stringify(previous) === JSON.stringify(value)))
      entry.models.push(value);
  }
  footprints.set(id, entry);
}
for (const name of (await readdir(path.join(root, 'design/EMC_Demo.pretty'))).sort()) {
  if (!/^[\w().+-]+\.kicad_mod$/.test(name))
    throw new Error('Unexpected EMC footprint asset name.');
  const id = `EMC_Demo:${name.slice(0, -'.kicad_mod'.length)}`;
  const file = `design/EMC_Demo.pretty/${name}`,
    bytes = await readFile(path.join(root, file));
  const entry = footprints.get(id) ?? { id, models: [] };
  Object.assign(entry, { file, sha256: hash(bytes) });
  footprints.set(id, entry);
}
// Manufacturer assets supplement only the original missing references. Keep the
// pinned upstream source and every native model path/transform unchanged.
const supplemental = JSON.parse(
  await readFile(path.join(supplementalRoot, 'manifest.json'), 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      'Missing EMC manufacturer model manifest. Restore resources/example-catalog/footprints/emc-flyback/manifest.json and its pinned assets before building OpenPE.',
    );
  }),
);
if (
  supplemental.version !== 1 ||
  !supplemental.models ||
  Array.isArray(supplemental.models) ||
  !Array.isArray(supplemental.licenses) ||
  !supplemental.licenses.length
)
  throw new Error('Invalid EMC manufacturer model manifest.');
async function verifiedSupplement(entry) {
  if (
    typeof entry.file !== 'string' ||
    !/^(?:models\/[\w().+-]+\.step|[\w().+-]+\.(?:md|txt))$/i.test(entry.file) ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new Error('Invalid pinned EMC manufacturer asset.');
  let target = supplementalRoot;
  for (const segment of entry.file.split('/')) {
    target = path.join(target, segment);
    const info = await lstat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(
        `Missing pinned EMC manufacturer asset: ${entry.file}. Restore the official file listed in resources/example-catalog/footprints/emc-flyback/manifest.json before building OpenPE.`,
      );
    });
    if (
      info.isSymbolicLink() ||
      normalize(path.resolve(target)) !== normalize(await realpath(target))
    )
      throw new Error('EMC manufacturer assets must not use linked paths.');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size < 1 || info.size > 30000000)
    throw new Error('Invalid pinned EMC manufacturer asset file.');
  const bytes = await readFile(target);
  if (hash(bytes) !== entry.sha256 || (entry.size !== undefined && bytes.length !== entry.size))
    throw new Error(`Pinned EMC manufacturer checksum mismatch: ${entry.file}`);
  return bytes;
}
for (const [relative, entry] of Object.entries(supplemental.models)) {
  if (
    !models[relative]?.missing ||
    entry.file !== `models/${relative.split('/').at(-1)}` ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1 ||
    ![entry.manufacturer, entry.partNumber, entry.sourceUrl].every(
      (value) => typeof value === 'string' && value.trim().length,
    ) ||
    !entry.sourceUrl.startsWith('https://')
  )
    throw new Error(`Invalid EMC manufacturer model reference: ${relative}`);
  const bytes = await verifiedSupplement(entry);
  if (
    !bytes.subarray(0, 100).toString('ascii').trimStart().startsWith('ISO-10303-21;') ||
    !bytes.subarray(-100).toString('ascii').trimEnd().endsWith('END-ISO-10303-21;')
  )
    throw new Error(`Invalid EMC manufacturer STEP content: ${entry.file}`);
  models[relative] = { ...entry, supplemental: true };
}
const missing = Object.entries(models).filter(([, entry]) => entry.missing);
if (missing.length)
  throw new Error(
    `Missing EMC manufacturer STEP assets: ${missing.map(([name]) => name).join(', ')}`,
  );
for (const entry of supplemental.licenses) {
  if (!/^[\w().+-]+\.(?:md|txt)$/i.test(entry.file))
    throw new Error('Invalid EMC manufacturer notice name.');
  await verifiedSupplement(entry);
}
const licenses = await Promise.all(
  ['LICENSE', 'design/EMC_Demo.3dshapes/README.md'].map(async (file) => ({
    file,
    sha256: hash(await readFile(path.join(root, file))),
  })),
);
const manifest = {
  version: 1,
  source: 'https://github.com/ChengminLi/AI-PCB-layout/tree/main/examples/emc-flyback-demo',
  commit: sourceManifest.commit,
  footprints: [...footprints.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')),
  models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b, 'en'))),
  licenses,
  supplementalLicenses: supplemental.licenses,
  kicadLicense: {
    file: 'LICENSE.md',
    sha256: hash(
      await readFile(path.join(repository, 'resources/example-catalog/footprints/LICENSE.md')),
    ),
  },
};
await writeFile(
  path.join(repository, 'resources/example-catalog/emc-flyback-assets.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  `Pinned ${manifest.footprints.length} EMC footprint identities, ${Object.values(models).filter((entry) => !entry.missing).length} STEP assets and ${Object.values(models).filter((entry) => entry.missing).length} unavailable references.`,
);
