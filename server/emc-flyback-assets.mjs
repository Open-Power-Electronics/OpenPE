import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../resources/example-catalog/emc-flyback-assets.json' with { type: 'json' };
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
const supplementalLicenses =
  manifest.supplementalLicenses === undefined ? [] : manifest.supplementalLicenses;
const legacyMissingModels = new Set([
  'emc-flyback-demo/Bourns_SRN8040TA.step',
  'emc-flyback-demo/WE_750311591_EFD25-SMD_070-4476.step',
  'emc-flyback-demo/WE-CMB_744822222.step',
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

if (
  manifest.version !== 1 ||
  footprints.size !== manifest.footprints.length ||
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
      (entry.missing === true
        ? !legacyMissingModels.has(relative) || Object.keys(entry).some((key) => key !== 'missing')
        : entry.missing !== undefined ||
          (entry.supplemental !== undefined && entry.supplemental !== true) ||
          (entry.supplemental && entry.file !== `models/${relative.split('/').at(-1)}`) ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 1 ||
          entry.size > 30000000),
  )
)
  throw new Error('Invalid pinned EMC Flyback asset manifest. Repair the OpenPE installation.');

async function readAsset(entry, assetRoot = entry.supplemental ? supplementalRoot : root) {
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
  let target = assetRoot;
  for (const segment of segments) {
    target = path.join(target, segment);
    const info = await lstat(target).catch(missing);
    if (
      info.isSymbolicLink() ||
      normalize(await realpath(target)) !== normalize(path.resolve(target))
    )
      throw new Error('Pinned EMC Flyback assets must not use linked paths.');
  }
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
  const entries = [...models.values()].filter((entry) => !entry.missing);
  entries.push(...manifest.footprints.filter((entry) => entry.file), ...manifest.licenses);
  for (const entry of entries)
    await readAsset(entry, entry.supplemental ? manufacturerRoot : assetRoot);
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
    if (node[0] === 'model')
      node[1] = quote(
        '${KIPRJMOD}/' +
          exampleModelPath(
            'emc-flyback-demo/' + val(node).slice('${KIPRJMOD}/EMC_Demo.3dshapes/'.length),
          ),
      );
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
      if (pinned?.missing === true && legacyMissingModels.has(relative)) continue;
      if (!pinned || pinned.missing)
        throw new Error(`Missing pinned EMC Flyback model: ${relative}`);
      selected.set(model.path.slice('${KIPRJMOD}/'.length), relative);
    }
  }
  if (!selected.size) return [];
  const assets = [];
  for (const [file, relative] of selected)
    assets.push({ file, bytes: await readAsset(models.get(relative)) });
  for (const entry of manifest.licenses)
    assets.push({
      file: `licenses/emc-flyback-demo/${entry.file === 'LICENSE' ? 'LICENSE' : 'MODEL-SOURCES.md'}`,
      bytes: await readAsset(entry),
    });
  if ([...selected.values()].some((relative) => models.get(relative).supplemental)) {
    for (const entry of supplementalLicenses)
      assets.push({
        file: `licenses/emc-flyback-demo/manufacturer/${entry.file}`,
        bytes: await readAsset(entry, supplementalRoot),
      });
    const provenance = {
      version: 1,
      models: Object.fromEntries(
        [...models]
          .filter(([, entry]) => entry.supplemental)
          .map(([relative, { supplemental: _supplemental, ...entry }]) => [relative, entry]),
      ),
      licenses: supplementalLicenses,
    };
    assets.push({
      file: 'licenses/emc-flyback-demo/manufacturer/manifest.json',
      bytes: Buffer.from(JSON.stringify(provenance, null, 2) + '\n'),
    });
  }
  assets.push({
    file: 'licenses/emc-flyback-demo/KICAD-LICENSE.md',
    bytes: await readAsset(manifest.kicadLicense, kicadLicenseRoot),
  });
  const noticeHeader =
    'EMC Flyback demonstration, pinned from ChengminLi/AI-PCB-layout.\nSource commit: e1b9a64ac9ac306647fa30094932fb792d17e373\nSource: https://github.com/ChengminLi/AI-PCB-layout/tree/main/examples/emc-flyback-demo\nOriginal STEP bytes are copied without substitution. Project models use CC BY 4.0; copied KiCad models use CC BY-SA 4.0 with the KiCad library exception. See LICENSE and MODEL-SOURCES.md.\n';
  const notice =
    noticeHeader +
    ([...models.values()].some((entry) => entry.missing)
      ? `${[...models.values()].filter((entry) => entry.missing).length} unavailable manufacturer STEP references remain in the native project.\n`
      : 'The original manufacturer model references resolve to separately pinned official STEP bytes. Their sources and terms accompany copied manufacturer assets in manufacturer/.\n');
  assets.push({
    file: 'licenses/emc-flyback-demo/NOTICE.txt',
    bytes: Buffer.from(notice),
    // Only this exact app-generated predecessor may be refreshed. Edited
    // notices, licenses and model bytes retain the destination conflict guard.
    previousBytes: [
      Buffer.from(
        noticeHeader +
          'The three unavailable manufacturer STEP references remain in the native project.\n',
      ),
    ],
  });
  return assets;
}
