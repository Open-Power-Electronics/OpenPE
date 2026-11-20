import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  lstat,
  realpath,
  mkdir,
  writeFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../resources/example-catalog/footprints/manifest.json' with { type: 'json' };
import emcManifest from '../resources/example-catalog/emc-flyback-assets.json' with { type: 'json' };
import {
  parseSExpr,
  children,
  child,
  val,
  exampleModelPath,
  modelReferenceKey,
  resolveExampleModelRelative,
  portableExampleModelSource,
} from './library-format.mjs';
import {
  emcFootprintDetail,
  emcModelBytes,
  emcProjectAssets,
  verifyEmcFlybackAssets,
} from './emc-flyback-assets.mjs';
import { canonicalDirectory } from './host-path.cjs';

const root = fileURLToPath(new URL('../resources/example-catalog/footprints/', import.meta.url));
const packages = new Map(manifest.footprints.map((entry) => [entry.id, entry]));
const emcPackages = new Map(emcManifest.footprints.map((entry) => [entry.id, entry]));

/** Build the searchable view without changing the official KiCad index or reading CAD. */
export function exampleFootprintSearchCatalog(official) {
  const entries = new Map(official.map((entry) => [entry.id, entry]));
  function include(record, modelPaths) {
    const original = entries.get(record.id);
    if (!original && !record.file) return;
    const [library, name] = record.id.split(':');
    const filenames = new Set(modelPaths.map((model) => model.split('/').at(-1)));
    entries.set(record.id, {
      ...(original ?? {
        id: record.id,
        library,
        name,
        description: 'Bundled example footprint',
        keywords: '',
      }),
      keywords: [original?.keywords, ...filenames].filter(Boolean).join(' '),
    });
  }
  for (const entry of packages.values())
    include(entry, entry.models.flatMap((model) => [model, exampleModelPath(model)]));
  for (const entry of emcPackages.values())
    include(entry, entry.models.map((model) => model.path));
  return [...entries.values()];
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function readAsset(file, hash, assetRoot = root) {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some((p) => p === '..' || !p))
    throw new Error('Invalid bundled example asset.');
  const target = path.join(assetRoot, file);
  const relative = path.relative(await realpath(assetRoot), await realpath(target));
  const info = await lstat(target);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 30_000_000
  )
    throw new Error('Invalid bundled example asset file.');
  const bytes = await readFile(target);
  if (hash && digest(bytes) !== hash)
    throw new Error(
      `Example footprint/model checksum mismatch: ${file}. Repair the OpenPE installation.`,
    );
  return bytes;
}

// Build-time verification covers the whole pinned subset, including assets not
// reached by the current examples. Runtime destination checks remain separate.
export async function verifyExampleFootprints(assetRoot = root) {
  const files = new Map();
  for (const entry of manifest.footprints) if (entry.file) files.set(entry.file, entry.sha256);
  for (const entry of Object.values(manifest.models)) files.set(entry.file, entry.sha256);
  for (const file of ['LICENSE.md', 'CREDITS.md', 'NOTICE.txt']) files.set(file, undefined);
  for (const [file, hash] of files) await readAsset(file, hash, assetRoot);
  await verifyEmcFlybackAssets();
  return files.size;
}

// Only fixed bundled IDs/references are resolved. Project model strings never
// become filesystem paths, and these assets never trigger network downloads.
export async function exampleFootprintDetail(id) {
  const entry = packages.get(id);
  if (!entry?.file) return emcFootprintDetail(id);
  const footprint = parseSExpr(
    portableExampleModelSource((await readAsset(entry.file, entry.sha256)).toString()),
  );
  return {
    id,
    library: id.split(':')[0],
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
  };
}
export async function exampleModelBytes(id, relative) {
  const emc = await emcModelBytes(id, relative);
  if (emc) return emc;
  relative = resolveExampleModelRelative(packages.get(id)?.models ?? [], relative);
  if (!relative) return null;
  const model = manifest.models[relative];
  if (!model) throw new Error('Missing pinned example model.');
  return readAsset(model.file, model.sha256);
}

export async function portableExampleModelBytes(id, reference) {
  if (emcPackages.get(id)?.models.some((model) => model.path === reference))
    return emcModelBytes(id, reference);
  const relative = packages
    .get(id)
    ?.models.find((item) => reference === '${KIPRJMOD}/' + exampleModelPath(item));
  if (!relative) return null;
  const model = manifest.models[relative];
  return readAsset(model.file, model.sha256);
}

async function writeAsset(target, bytes, label) {
  try {
    const info = await lstat(target);
    const existing =
      info.isFile() && !info.isSymbolicLink() && info.size === bytes.length
        ? await readFile(target)
        : null;
    if (!existing?.equals(bytes))
      throw new Error(
        `Existing example asset differs: ${label}. Preserved unchanged; choose another destination.`,
      );
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, target);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

// Native project destinations are supplied by Electron, never the renderer.
export async function prepareExampleFootprints(project, projectFile) {
  const emcAssets = await emcProjectAssets(project);
  const nativeFiles = project.nativeFiles?.files ?? [];
  const nativeTable = nativeFiles.find((file) => file.name === 'fp-lib-table');
  const nativeLibraries = new Map(
    (nativeTable ? children(parseSExpr(nativeTable.source), 'lib') : []).map((entry) => [
      val(child(entry, 'name')),
      val(child(entry, 'uri')),
    ]),
  );
  const retainedCustomPackage = (entry) => {
    const [library, name] = entry.id.split(':');
    const uri = nativeLibraries.get(library);
    return (
      uri?.startsWith('${KIPRJMOD}/') &&
      nativeFiles.some(
        (file) => file.name === `${uri.slice('${KIPRJMOD}/'.length)}/${name}.kicad_mod`,
      )
    );
  };
  const entries = [
    ...new Set(
      (project.pcb?.footprints ?? [])
        .filter((fp) =>
          fp.models?.some((model) =>
            packages
              .get(fp.libraryId)
              ?.models.some(
                (relative) =>
                  model.path.startsWith('${KIPRJMOD}/') &&
                  modelReferenceKey(model.path) === modelReferenceKey(relative),
              ),
          ),
        )
        .map((fp) => fp.libraryId),
    ),
  ]
    .map((id) => packages.get(id))
    .filter(Boolean);
  if (!entries.length && !emcAssets.length) return;
  const directory = path.dirname(projectFile);
  async function safeDirectory(dir) {
    await mkdir(dir).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await canonicalDirectory(dir, {
      message: 'The example footprints folder must be a real directory beside the project.',
    });
  }
  await safeDirectory(directory);
  const files = new Map();
  for (const entry of entries) {
    if (entry.file && !retainedCustomPackage(entry))
      files.set('footprints/' + entry.file, { source: entry.file, hash: entry.sha256 });
    for (const relative of entry.models) {
      const model = manifest.models[relative];
      for (const fp of project.pcb.footprints)
        if (fp.libraryId === entry.id)
          for (const item of fp.models ?? [])
            if (
              item.path.startsWith('$' + '{KIPRJMOD}/') &&
              modelReferenceKey(item.path) === modelReferenceKey(relative)
            )
              files.set(item.path.slice('${KIPRJMOD}/'.length), {
                source: model.file,
                hash: model.sha256,
              });
    }
  }
  for (const [file, { source, hash }] of files) {
    let bytes = await readAsset(source, hash);
    if (file.endsWith('.kicad_mod')) {
      const source = portableExampleModelSource(bytes.toString('utf8')).replace(
        /\$\{KIPRJMOD\}\/models\/[^"\r\n]+\.step/g,
        (reference) => {
          const selected = project.pcb.footprints
            .flatMap((fp) => fp.models ?? [])
            .find(
              (model) =>
                model.path.startsWith('$' + '{KIPRJMOD}/') &&
                modelReferenceKey(model.path) === modelReferenceKey(reference),
            );
          return selected?.path ?? reference;
        },
      );
      bytes = Buffer.from(source);
    }
    let parent = directory;
    for (const part of file.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      await safeDirectory(parent);
    }
    await writeAsset(path.join(directory, file), bytes, file);
  }
  for (const { file, bytes } of emcAssets) {
    let parent = directory;
    for (const part of file.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      await safeDirectory(parent);
    }
    await writeAsset(path.join(directory, file), bytes, file);
  }
  const customLibraries = [
    ...new Set(
      entries
        .filter((entry) => entry.file && !retainedCustomPackage(entry))
        .map((entry) => entry.id.split(':')[0]),
    ),
  ];
  if (customLibraries.length) {
    const table =
      '(fp_lib_table\n  (version 7)\n' +
      customLibraries
        .map(
          (library) =>
            `  (lib (name ${JSON.stringify(library)})(type "KiCad")(uri "\${KIPRJMOD}/footprints/${library}.pretty")(options "")(descr "Reference source package"))\n`,
        )
        .join('') +
      ')\n';
    await writeAsset(
      path.join(path.dirname(projectFile), 'fp-lib-table'),
      Buffer.from(table),
      'fp-lib-table',
    );
  }
}
