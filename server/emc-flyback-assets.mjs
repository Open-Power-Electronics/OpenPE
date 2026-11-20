import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../resources/example-catalog/emc-flyback-assets.json' with { type: 'json' };
import analyticalPin from '../resources/example-catalog/footprints/emc-flyback/manifest.json' with { type: 'json' };
import {
  parseSExpr,
  children,
  child,
  val,
  quote,
  exampleModelPath,
  modelReferenceKey,
  resolveExampleModelRelative,
} from './library-format.mjs';
import { assertContainedPath, canonicalDirectory } from './host-path.cjs';

const root = fileURLToPath(
  new URL('../resources/example-catalog/sources/emc-flyback/', import.meta.url),
);
const supplementalRoot = fileURLToPath(
  new URL('../resources/example-catalog/footprints/emc-flyback/', import.meta.url),
);
const kicadLicenseRoot = fileURLToPath(
  new URL('../resources/example-catalog/footprints/', import.meta.url),
);
const prefix = '${KIPRJMOD}/models/';
const models = new Map(Object.entries(manifest.models));
const footprints = new Map(manifest.footprints.map((entry) => [entry.id, entry]));
const supplementalLicenses = manifest.supplementalLicenses;
function catalogRoot(entry) {
  return entry.supplemental === true || entry.analytical === true ? supplementalRoot : root;
}
function analyticalReplacement(filename) {
  if (!analyticalPin.analyticalModels || Array.isArray(analyticalPin.analyticalModels))
    throw new Error('Invalid pinned EMC Flyback analytical models.');
  for (const [relative, entry] of Object.entries(analyticalPin.analyticalModels))
    if (entry.replaces === filename) return { relative, entry };
  return null;
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (
  manifest.version !== 1 ||
  footprints.size !== manifest.footprints.length ||
  !Array.isArray(manifest.mechanicalSources) ||
  manifest.mechanicalSources.some(
    (entry) => typeof entry.file !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256),
  ) ||
  !Array.isArray(supplementalLicenses) ||
  ([...models.values()].some((entry) => entry.supplemental) && !supplementalLicenses.length) ||
  supplementalLicenses.some(
    (entry) =>
      !/^[\w.()+-]+\.(?:md|txt)$/i.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256),
  ) ||
  manifest.footprints.some(
    (entry) =>
      !/^[\w.()+,-]+:[\w.()+,-]+$/.test(entry.id) ||
      !Array.isArray(entry.models) ||
      entry.models.some(
        (model) =>
          !model.path?.startsWith(prefix) ||
          !resolveExampleModelRelative([...models.keys()], model.path),
      ),
  ) ||
  [...models].some(
    ([relative, entry]) =>
      !/^emc-flyback-demo\/[\w.()+-]+\.step$/i.test(relative) ||
      entry.missing !== undefined ||
      (entry.supplemental !== undefined && entry.supplemental !== true) ||
      (entry.analytical !== undefined && entry.analytical !== true) ||
      (entry.supplemental === true && entry.analytical === true) ||
      ((entry.supplemental === true || entry.analytical === true) &&
        entry.file !== `models/${relative.split('/').at(-1)}`) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > 30000000,
  )
)
  throw new Error('Invalid pinned EMC Flyback asset manifest. Repair the OpenPE installation.');

async function readAsset(entry, assetRoot = catalogRoot(entry)) {
  const missing = (error) => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      `Missing pinned EMC Flyback asset: ${entry.file}. Restore the pinned example assets and rebuild OpenPE, or repair the OpenPE installation.`,
    );
  };
  const segments = entry.file?.split('/');
  if (
    !segments?.length ||
    path.isAbsolute(entry.file) ||
    segments.some((part) => !part || part === '..' || part === '.' || part.includes('\\'))
  )
    throw new Error('Invalid pinned EMC Flyback asset path.');
  const rooted = await canonicalDirectory(assetRoot, {
    message: 'Pinned EMC Flyback assets must not use linked paths.',
  }).catch((error) => {
    if (error.code === 'ENOENT') missing(error);
    throw error;
  });
  let target = assetRoot;
  for (const segment of segments) {
    target = path.join(target, segment);
    const info = await lstat(target).catch(missing);
    if (info.isSymbolicLink())
      throw new Error('Pinned EMC Flyback assets must not use linked paths.');
  }
  await assertContainedPath(rooted, target, {
    message: 'Pinned EMC Flyback assets must not use linked paths.',
    kind: 'file',
  });
  const info = await lstat(target).catch(missing);
  if (!info.isFile() || info.size > 30000000)
    throw new Error('Invalid pinned EMC Flyback asset file.');
  const bytes = await readFile(target).catch(missing);
  if (digest(bytes) !== entry.sha256 || (entry.size !== undefined && bytes.length !== entry.size))
    throw new Error(
      `EMC Flyback asset checksum mismatch: ${entry.file}. Repair the OpenPE installation.`,
    );
  return bytes;
}

export async function verifyEmcFlybackAssets(
  assetRoot = root,
  manufacturerRoot = supplementalRoot,
) {
  const entries = [...models.values()];
  entries.push(
    ...manifest.footprints.filter((entry) => entry.file),
    ...manifest.mechanicalSources,
    ...manifest.licenses,
  );
  for (const entry of entries)
    await readAsset(
      entry,
      entry.supplemental || entry.analytical ? manufacturerRoot : assetRoot,
    );
  for (const entry of supplementalLicenses) await readAsset(entry, manufacturerRoot);
  await readAsset(manifest.kicadLicense, kicadLicenseRoot);
  return entries.length + supplementalLicenses.length + 1;
}

/** Append fixed instance model paths while retaining official catalog identity,
 * geometry and existing model choices for shared standard footprints. */
export function appendEmcFootprintModels(id, detail) {
  const entry = footprints.get(id);
  if (!entry || !detail) return detail;
  const existing = detail.models ?? [];
  const extra = entry.models.filter(
    (model) => !existing.some((previous) => previous.path === model.path),
  );
  return extra.length ? { ...detail, models: [...existing, ...structuredClone(extra)] } : detail;
}

export async function emcFootprintDetail(id) {
  const entry = footprints.get(id);
  if (!entry?.file) return null;
  const footprint = parseSExpr((await readAsset(entry)).toString('utf8'));
  const visit = (node) => {
    if (node[0] === 'model') {
      const prefix = '${KIPRJMOD}/EMC_Demo.3dshapes/';
      const original = val(node);
      if (!original.startsWith(prefix)) throw new Error('Unexpected EMC footprint model.');
      const name = original.slice(prefix.length);
      const replacement = analyticalReplacement(name);
      node[1] = quote(
        '${KIPRJMOD}/' +
          exampleModelPath(replacement ? replacement.relative : `emc-flyback-demo/${name}`),
      );
      if (replacement)
        for (const [key, values] of [
          ['offset', replacement.entry.offset],
          ['scale', replacement.entry.scale],
          ['rotate', replacement.entry.rotate],
        ]) {
          const xyz = child(child(node, key), 'xyz');
          if (!xyz || xyz.length !== 4) throw new Error(`EMC model ${name} is missing ${key}.`);
          values.forEach((value, index) => {
            xyz[index + 1] = String(value);
          });
        }
    }
    if (node[0] === 'version') node[1] = '20260206';
    if (node[0] === 'tstamp') node[0] = 'uuid';
    for (const value of node) if (Array.isArray(value)) visit(value);
  };
  visit(footprint);
  return appendEmcFootprintModels(id, {
    id,
    library: 'EMC_Demo',
    name: id.split(':')[1],
    keywords: '',
    description: val(child(footprint, 'descr')),
    footprint,
    pads: [
      ...new Set(
        children(footprint, 'pad')
          .map((pad) => val(pad))
          .filter(Boolean),
      ),
    ],
    models: children(footprint, 'model').map((model) => ({
      path: val(model),
      offset: child(model, 'offset'),
      scale: child(model, 'scale'),
      rotate: child(model, 'rotate'),
    })),
  });
}

export async function emcModelBytes(id, relative) {
  const entry = footprints.get(id);
  if (!entry?.models.some((model) => modelReferenceKey(model.path) === modelReferenceKey(relative)))
    return null;
  relative = resolveExampleModelRelative([...models.keys()], relative);
  const model = models.get(relative);
  if (!model || model.missing)
    throw new Error(
      `The pinned EMC Flyback model ${relative.split('/').at(-1)} is unavailable. Repair the OpenPE installation; the 2D footprint remains available.`,
    );
  return readAsset(model);
}

/** The caller owns checked destination directories and atomic asset writes. */
export async function emcProjectAssets(project) {
  const selected = new Map();
  for (const footprint of project.pcb?.footprints ?? []) {
    const entry = footprints.get(footprint.libraryId);
    for (const model of footprint.models ?? []) {
      if (
        !model.path.startsWith('${KIPRJMOD}/') ||
        !entry?.models.some(
          (fixed) => modelReferenceKey(fixed.path) === modelReferenceKey(model.path),
        )
      )
        continue;
      const relative = resolveExampleModelRelative([...models.keys()], model.path);
      const pinned = models.get(relative);
      if (!pinned || pinned.missing)
        throw new Error(`Missing pinned EMC Flyback model: ${relative}`);
      selected.set(model.path.slice('${KIPRJMOD}/'.length), relative);
    }
  }
  const assets = [];
  for (const [file, relative] of selected)
    assets.push({ file, bytes: await readAsset(models.get(relative)) });
  return assets;
}
