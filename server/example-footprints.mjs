import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  lstat,
  realpath,
  mkdir,
  writeFile,
  rename,
  unlink,
  rmdir,
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

const root = fileURLToPath(new URL('../resources/example-catalog/footprints/', import.meta.url));
const packages = new Map(manifest.footprints.map((entry) => [entry.id, entry]));
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

async function writeAsset(target, bytes, label, previousBytes = []) {
  try {
    const info = await lstat(target);
    const allowed = [bytes, ...previousBytes];
    const existing =
      info.isFile() &&
      !info.isSymbolicLink() &&
      allowed.some((candidate) => candidate.length === info.size)
        ? await readFile(target)
        : null;
    if (!existing || !allowed.some((candidate) => existing.equals(candidate)))
      throw new Error(
        `Existing example asset differs: ${label}. Preserved unchanged; choose another destination.`,
      );
    if (existing.equals(bytes)) return;
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

// Exact legacy bytes are retained only to recognize removable generated copies.
function retiredAssetNotice(notices) {
  const header =
    'OpenPE project asset notices\n\nOriginal license terms, credits and provenance are reproduced below. Section names identify their bundled source documents.\n\n';
  return Buffer.concat([
    Buffer.from(header),
    ...[...notices]
      .sort((a, b) => a.file.localeCompare(b.file, 'en'))
      .map(({ file, bytes }) =>
        Buffer.concat([Buffer.from('===== ' + file + ' =====\n'), bytes, Buffer.from('\n\n')]),
      ),
  ]);
}
function retiredAssetNotices(notices) {
  const groups = [
    ...new Set(
      notices.map(({ file }) =>
        file.startsWith('licenses/footprints/')
          ? 'boost'
          : file.includes('/manufacturer/')
            ? 'manufacturer'
            : 'emc',
      ),
    ),
  ];
  return Array.from({ length: 2 ** groups.length - 1 }, (_, index) =>
    retiredAssetNotice(
      notices.filter(({ file }) => {
        const group = file.startsWith('licenses/footprints/')
          ? 'boost'
          : file.includes('/manufacturer/')
            ? 'manufacturer'
            : 'emc';
        return (index + 1) & (1 << groups.indexOf(group));
      }),
    ),
  );
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
    const info = await lstat(dir);
    const normalize = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      normalize(await realpath(dir)) !== normalize(path.resolve(dir))
    )
      throw new Error('The example footprints folder must be a real directory beside the project.');
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
  for (const { file, bytes, previousBytes } of emcAssets) {
    if (file.startsWith('licenses/')) continue;
    let parent = directory;
    for (const part of file.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      await safeDirectory(parent);
    }
    await writeAsset(path.join(directory, file), bytes, file, previousBytes);
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

// Remove only known obsolete copies after the complete new native set is on disk.
// Changed/unknown files and live legacy references retain their original paths.
export async function cleanupExampleLayout(project, projectFile, bundle) {
  const directory = path.resolve(path.dirname(projectFile));
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  async function regular(relative) {
    const parts = relative.split('/');
    if (
      parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')) ||
      path.isAbsolute(relative)
    )
      throw new Error('Invalid example cleanup path.');
    let target = directory;
    for (const part of ['', ...parts]) {
      target = path.join(target, part);
      const info = await lstat(target).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) return null;
      if (
        info.isSymbolicLink() ||
        normalize(await realpath(target)) !== normalize(path.resolve(target))
      )
        throw new Error('Example cleanup cannot follow linked paths.');
    }
    return (await lstat(target)).isFile() ? target : null;
  }
  for (const file of bundle.files) {
    const target = await regular(file.name);
    if (
      !target ||
      !(await readFile(target)).equals(Buffer.from(file.source, file.encoding ?? 'utf8'))
    )
      return;
  }
  const pairs = new Map();
  for (const file of bundle.files) {
    if (
      /^footprints\/[^/]+\.pretty\//.test(file.name) ||
      /^symbols\/[^/]+\.kicad_sym$/.test(file.name)
    )
      pairs.set(file.name.replace(/^(footprints|symbols)\//, ''), file.name);
  }
  for (const [tableName, suffix] of [
    ['fp-lib-table', '.pretty'],
    ['sym-lib-table', '.kicad_sym'],
  ]) {
    const table = bundle.files.find((file) => file.name === tableName);
    if (!table) continue;
    for (const entry of children(parseSExpr(table.source), 'lib')) {
      const library = val(child(entry, 'name'));
      const uri = val(child(entry, 'uri'));
      if (!uri.startsWith('${KIPRJMOD}/') || !/^[\w.()+,-]+$/.test(library)) continue;
      const relative = uri.slice('${KIPRJMOD}/'.length);
      for (const file of bundle.files) {
        if (suffix === '.pretty' && file.name.startsWith(relative + '/')) {
          const leaf = file.name.slice(relative.length);
          for (const prefix of ['', 'footprints/'])
            pairs.set(prefix + library + suffix + leaf, file.name);
        } else if (suffix === '.kicad_sym' && file.name === relative)
          pairs.set(library + suffix, file.name);
      }
    }
  }
  for (const fp of project.pcb?.footprints ?? [])
    for (const model of fp.models ?? []) {
      for (const relative of [
        ...Object.keys(manifest.models),
        ...Object.keys(emcManifest.models),
      ]) {
        const after = exampleModelPath(relative);
        if (model.path !== '$' + '{KIPRJMOD}/' + after) continue;
        for (const prefix of ['models/', 'footprints/models/']) pairs.set(prefix + relative, after);
        pairs.set('footprints/' + path.basename(after), after);
        pairs.set('3D/' + path.basename(after), after);
      }
    }
  const normalizeSource = (bytes) => portableExampleModelSource(bytes.toString('utf8'));
  async function discard(file) {
    await unlink(file);
    let parent = path.dirname(file);
    while (parent !== directory) {
      const relative = path.relative(directory, parent);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Invalid example cleanup directory.');
      try {
        await rmdir(parent);
      } catch (error) {
        if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) break;
        throw error;
      }
      parent = path.dirname(parent);
    }
  }
  for (const [before, after] of pairs) {
    if (before === after || bundle.files.some((file) => file.name === before)) continue;
    const oldReference = '${KIPRJMOD}/' + before;
    if (
      project.pcb?.footprints.some((fp) =>
        fp.models?.some((model) => model.path === oldReference),
      ) ||
      bundle.files.some((file) => file.source.includes(oldReference))
    )
      continue;
    const oldFile = await regular(before);
    const newFile = await regular(after);
    if (!oldFile || !newFile) continue;
    if ((await lstat(oldFile)).size > (await lstat(newFile)).size + 4096) continue;
    const oldBytes = await readFile(oldFile),
      newBytes = await readFile(newFile);
    if (
      !oldBytes.equals(newBytes) &&
      !(before.endsWith('.kicad_mod') || before.endsWith('.kicad_sym'))
    )
      continue;
    if (!oldBytes.equals(newBytes) && normalizeSource(oldBytes) !== normalizeSource(newBytes))
      continue;
    await discard(oldFile);
  }
  const licenses = (await emcProjectAssets(project)).filter((asset) =>
    asset.file.startsWith('licenses/'),
  );
  for (const name of ['LICENSE.md', 'CREDITS.md', 'NOTICE.txt'])
    licenses.push({ file: 'licenses/footprints/' + name, bytes: await readAsset(name) });
  for (const asset of licenses) {
    const aliases = [asset.file, 'footprints/' + asset.file];
    if (asset.file.startsWith('licenses/footprints/'))
      aliases.push('footprints/' + path.basename(asset.file));
    for (const alias of aliases) {
      const target = await regular(alias);
      if (!target) continue;
      const candidates = [asset.bytes, ...(asset.previousBytes ?? [])];
      const info = await lstat(target);
      if (!candidates.some((bytes) => bytes.length === info.size)) continue;
      const existing = await readFile(target);
      if (candidates.some((bytes) => bytes.equals(existing))) await discard(target);
    }
  }
  const noticeFile = await regular('NOTICE.txt');
  if (noticeFile) {
    const candidates = retiredAssetNotices(licenses);
    const size = (await lstat(noticeFile)).size;
    if (candidates.some((bytes) => bytes.length === size)) {
      const existing = await readFile(noticeFile);
      if (candidates.some((bytes) => bytes.equals(existing))) await discard(noticeFile);
    }
  }
}
