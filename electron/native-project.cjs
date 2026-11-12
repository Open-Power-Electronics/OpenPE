const path = require('node:path');
const fs = require('node:fs/promises');
const { isUtf8 } = require('node:buffer');

const maxFiles = 128;
const maxFileBytes = 8_000_000;
const maxProjectBytes = 96_000_000;
const maxDepth = 8;
const privateDirectory = (name) =>
  [
    '.git',
    'history.git',
    'node_modules',
    '.cache',
    'cache',
    'simulation-cache',
    'spice',
    'thermal',
    'upstream',
  ].includes(name.toLowerCase()) || /-backups$/i.test(name);
const safeSegment = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 160 &&
  name !== '.' &&
  name !== '..' &&
  !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
  !/[. ]$/.test(name) &&
  !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
const nativeName = (name) =>
  typeof name === 'string' &&
  name.length <= 240 &&
  name.split('/').length <= maxDepth + 1 &&
  name.split('/').every(safeSegment) &&
  !name.split('/').slice(0, -1).some(privateDirectory) &&
  (/\.kicad_(?:pro|sch|pcb|dru|wks|sym|mod|jobset)$/i.test(name) ||
    /\.(?:lib|cir|spice|dcm)$/i.test(name) ||
    ['sym-lib-table', 'fp-lib-table'].includes(path.posix.basename(name)));

async function regularDirectory(directory) {
  const info = await fs.lstat(directory);
  // Ancestor symlinks are outside this folder. A link at the folder itself is rejected.
  if (info.isSymbolicLink())
    throw new Error('Linked KiCad project folders are not supported.');
  if (!info.isDirectory()) throw new Error('The KiCad project location must be a regular folder.');
}

function validateNativeFiles(bundle) {
  if (
    !bundle ||
    typeof bundle !== 'object' ||
    !nativeName(bundle.entry) ||
    !Array.isArray(bundle.files) ||
    !bundle.files.length ||
    bundle.files.length > maxFiles
  )
    throw new Error('Invalid KiCad project files.');
  const seen = new Set();
  let bytes = 0;
  for (const file of bundle.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      !nativeName(file.name) ||
      typeof file.source !== 'string' ||
      file.source.includes('\0') ||
      (file.encoding !== undefined && file.encoding !== 'latin1') ||
      (file.encoding === 'latin1' &&
        (/\.kicad_(?:pro|sch|pcb)$/i.test(file.name) || /[^\u0000-\u00ff]/.test(file.source))) ||
      seen.has(file.name.toLowerCase())
    )
      throw new Error('Invalid or duplicate KiCad project filename.');
    seen.add(file.name.toLowerCase());
    const size = Buffer.byteLength(file.source, file.encoding ?? 'utf8');
    if (size > maxFileBytes) throw new Error('A KiCad project file exceeds 8 MB.');
    bytes += size;
    if (bytes > maxProjectBytes) throw new Error('The KiCad project exceeds 96 MB.');
  }
  if (!bundle.files.some((file) => file.name === bundle.entry))
    throw new Error('The KiCad project entry file is missing.');
  return bundle;
}

// A native picker grants the chosen project folder's bounded KiCad source files.
// Names come from disk, never a renderer-provided directory or absolute path.
async function readNativeProject(file) {
  const directory = path.dirname(file);
  let entry = path.basename(file);
  if (!nativeName(entry) || !/\.kicad_(?:pro|sch|pcb)$/i.test(entry))
    throw new Error('Choose a KiCad project, schematic or PCB file.');
  await regularDirectory(directory);
  const listing = await fs.readdir(directory, { withFileTypes: true });
  const matchingProject = entry.replace(/\.kicad_(?:sch|pcb)$/i, '.kicad_pro');
  const projectEntry = listing.find(
    (item) => item.name.toLowerCase() === matchingProject.toLowerCase(),
  );
  if (projectEntry) entry = projectEntry.name;
  const entryStem = entry.replace(/\.kicad_(?:pro|sch|pcb)$/i, '').toLowerCase();
  const otherProjects = new Set(
    listing
      .filter((item) => /\.kicad_pro$/i.test(item.name))
      .map((item) => item.name.replace(/\.kicad_pro$/i, '').toLowerCase())
      .filter((name) => name !== entryStem),
  );
  const belongsToOtherProject = (name) =>
    otherProjects.has(name.replace(/\.kicad_(?:sch|pcb|dru|wks|jobset)$/i, '').toLowerCase());
  const rootSchematics = listing.filter(
    (item) => /\.kicad_sch$/i.test(item.name) && !belongsToOtherProject(item.name),
  );
  const rootBoards = listing.filter(
    (item) => /\.kicad_pcb$/i.test(item.name) && !belongsToOtherProject(item.name),
  );
  const primaryBoard =
    rootBoards.find((item) => item.name.replace(/\.kicad_pcb$/i, '').toLowerCase() === entryStem) ??
    (rootBoards.length === 1 ? rootBoards[0] : undefined);
  if (!primaryBoard && rootBoards.length > 1)
    throw new Error(
      'Several PCB layouts have no matching KiCad project name. Open the intended .kicad_pcb file directly.',
    );
  const files = [];
  let bytes = 0,
    inspected = 0;
  const sources = new Map();
  const readSource = async (name) => {
    if (sources.has(name)) return sources.get(name);
    if (sources.size >= maxFiles)
      throw new Error('The KiCad project has too many source files (maximum 128).');
    const location = path.join(directory, ...name.split('/'));
    await regularDirectory(path.dirname(location));
    const info = await fs.lstat(location);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`The KiCad source file ${name} must be a regular file.`);
    if (info.size > maxFileBytes) throw new Error(`The KiCad source file ${name} exceeds 8 MB.`);
    bytes += info.size;
    if (bytes > maxProjectBytes) throw new Error('The KiCad project exceeds 96 MB.');
    const content = await fs.readFile(location);
    if (content.length !== info.size || content.includes(0))
      throw new Error(`The KiCad source file ${name} must contain bounded text without NUL bytes.`);
    const utf8 = isUtf8(content);
    if (!utf8 && /\.kicad_(?:pro|sch|pcb)$/i.test(name))
      throw new Error(`The KiCad source file ${name} must contain valid UTF-8 text.`);
    const file = {
      source: content.toString(utf8 ? 'utf8' : 'latin1'),
      ...(!utf8 ? { encoding: 'latin1' } : {}),
    };
    sources.set(name, file);
    return file;
  };
  const referencedSchematics = new Set();
  const references = rootSchematics.map((item) => item.name);
  for (let next = 0; next < references.length; next++) {
    const name = references[next];
    const { source } = await readSource(name);
    for (const match of source.matchAll(/\(\s*property\s+"Sheetfile"\s+("(?:[^"\\]|\\.)*")/gi)) {
      let reference;
      try {
        reference = JSON.parse(match[1]);
      } catch {
        throw new Error(`Invalid Sheetfile reference in ${name}.`);
      }
      if (
        typeof reference !== 'string' ||
        path.posix.isAbsolute(reference) ||
        reference.includes('\\')
      )
        throw new Error(`The Sheetfile reference in ${name} must stay inside its project folder.`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), reference));
      if (!nativeName(target) || !/\.kicad_sch$/i.test(target))
        throw new Error(
          `The Sheetfile reference in ${name} must be a contained KiCad schematic filename.`,
        );
      if (!referencedSchematics.has(target) && !references.includes(target)) {
        referencedSchematics.add(target);
        references.push(target);
      }
    }
  }
  const walk = async (current, relative = '', depth = 0) => {
    const items = relative ? await fs.readdir(current, { withFileTypes: true }) : listing;
    for (const item of items) {
      if (++inspected > 4096)
        throw new Error('The KiCad project folder contains too many entries (maximum 4096).');
      if (!safeSegment(item.name) || privateDirectory(item.name)) continue;
      const location = path.join(current, item.name);
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (depth >= maxDepth)
          throw new Error('KiCad project source folders exceed the maximum depth of 8.');
        await regularDirectory(location);
        await walk(location, name, depth + 1);
        continue;
      }
      if (item.isSymbolicLink())
        throw new Error('Linked files and folders inside KiCad projects are not supported.');
      if (!nativeName(name) || (/\.kicad_pro$/i.test(name) && name !== entry)) continue;
      if (
        /\.kicad_sch$/i.test(name) &&
        (relative ? !referencedSchematics.has(name) : belongsToOtherProject(item.name))
      )
        continue;
      if (/\.kicad_pcb$/i.test(name) && (relative || item.name !== primaryBoard?.name)) continue;
      if (
        !relative &&
        /\.kicad_(?:dru|wks|jobset)$/i.test(name) &&
        belongsToOtherProject(item.name)
      )
        continue;
      if (files.length >= maxFiles)
        throw new Error('The KiCad project has too many source files (maximum 128).');
      files.push({ name, ...(await readSource(name)) });
    }
  };
  await walk(directory);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return validateNativeFiles({ entry, files });
}

async function nativeTargetInfo(target, name) {
  const info = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes))
    throw new Error(`The KiCad destination ${name} is not a regular bounded file.`);
  return info;
}

async function preflightNativeProject(file, bundle) {
  validateNativeFiles(bundle);
  if (path.basename(file) !== bundle.entry)
    throw new Error('The KiCad project entry does not match the selected filename.');
  const directory = path.dirname(file);
  await regularDirectory(directory);
  const checked = new Set([directory]);
  const targets = [];
  for (const item of bundle.files) {
    const target = path.resolve(directory, ...item.name.split('/'));
    const relative = path.relative(directory, target);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
      throw new Error('Invalid KiCad project destination.');
    let parent = directory;
    for (const segment of item.name.split('/').slice(0, -1)) {
      parent = path.join(parent, segment);
      if (checked.has(parent)) continue;
      try {
        await regularDirectory(parent);
        checked.add(parent);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        break;
      }
    }
    targets.push({ item, target, info: await nativeTargetInfo(target, item.name) });
  }
  return targets;
}

// Capture the previous native files before publishing, then roll back written
// siblings if a later write fails.
async function writeNativeProject(file, bundle, atomicWrite, checkGrant = () => {}) {
  const targets = await preflightNativeProject(file, bundle);
  const directory = path.dirname(file);
  for (const target of targets) {
    target.source = Buffer.from(target.item.source, target.item.encoding ?? 'utf8');
    target.previous = target.info ? await fs.readFile(target.target) : null;
  }
  // Publish the entry last so a newly created project is not visible mid-save.
  targets.sort(
    (a, b) => Number(a.item.name === bundle.entry) - Number(b.item.name === bundle.entry),
  );
  const written = [];
  try {
    for (const target of targets) {
      if (target.previous?.equals(target.source)) continue;
      await checkGrant(target);
      let parent = directory;
      for (const segment of target.item.name.split('/').slice(0, -1)) {
        await regularDirectory(parent);
        parent = path.join(parent, segment);
        await fs.mkdir(parent).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
      const check = async () => {
        await regularDirectory(parent);
        await nativeTargetInfo(target.target, target.item.name);
        await checkGrant(target);
      };
      await check();
      await atomicWrite(target.target, target.source, check);
      written.push(target);
    }
    await checkGrant();
  } catch (error) {
    const failures = [];
    for (const target of written.reverse()) {
      try {
        await regularDirectory(path.dirname(target.target));
        if (target.previous === null) await fs.unlink(target.target);
        else await atomicWrite(target.target, target.previous);
      } catch (rollbackError) {
        failures.push(rollbackError.message);
      }
    }
    if (failures.length)
      throw new Error(
        `${error.message} Could not restore all KiCad project files: ${failures.join(' ')}`,
      );
    throw error;
  }
}

module.exports = {
  readNativeProject,
  writeNativeProject,
  preflightNativeProject,
  validateNativeFiles,
  nativeName,
};
