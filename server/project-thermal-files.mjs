import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analysisFilename,
  createAnalysisStaging,
  discardAnalysisStaging,
  publishAnalysisFiles,
  withAnalysisFiles,
} from './flat-analysis-files.mjs';
import {
  thermalFingerprint,
  validateThermalConfig,
  validateThermalResult,
} from './thermal-format.mjs';

const format = 'openpe-thermal-v1';
const flatFormat = 'openpe-thermal-v2';
const inputLimit = 24 * 1024 * 1024;
const resultLimit = 32 * 1024 * 1024;
const manifestLimit = 64 * 1024;
const artifacts = [
  'board.geo',
  'planar.msh',
  'board.msh',
  'case.sif',
  'gmsh.log',
  'gmsh-output.log',
  'elmer-grid.log',
  'solver.log',
];
const meshFiles = ['mesh.header', 'mesh.nodes', 'mesh.elements', 'mesh.boundary'];
const optionalMeshFiles = ['mesh.names'];
const vtuName = (name) => /^thermal[A-Za-z0-9._-]*\.vtu$/.test(name);
const meshSidecar = (name) => /^thermal[A-Za-z0-9._-]*\.(?:pvd|pvtu)$/.test(name);
const normalize = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ownKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const validKey = (key) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const missing = async (file) =>
  lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

function jsonSnapshot(value, limit) {
  const pending = [{ value, depth: 0 }];
  const seen = new Set();
  let count = 0;
  while (pending.length) {
    const item = pending.pop();
    const current = item.value;
    if (++count > 2000000 || item.depth > 32)
      throw new Error('Layout Thermal input exceeds the bounded JSON structure.');
    if (current === null || typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number' && Number.isFinite(current)) continue;
    if (!current || typeof current !== 'object')
      throw new Error('Layout Thermal input must contain finite JSON values.');
    if (seen.has(current)) continue;
    seen.add(current);
    if (
      !Array.isArray(current) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(current))
    )
      throw new Error('Layout Thermal input must contain plain JSON objects.');
    for (const child of Object.values(current))
      pending.push({ value: child, depth: item.depth + 1 });
  }
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit)
    throw new Error('The saved Layout Thermal JSON is too large.');
  return { value: JSON.parse(text), bytes: Buffer.from(text) };
}

function checkedModel(input) {
  const snapshot = jsonSnapshot(input, inputLimit);
  const model = snapshot.value;
  if (
    !ownKeys(model, [
      'version',
      'boardId',
      'units',
      'basis',
      'config',
      'board',
      'layers',
      'dielectricLayers',
      'barrels',
      'sources',
      'notices',
      'assumptions',
    ]) ||
    model.version !== 1 ||
    model.units !== 'mm' ||
    typeof model.boardId !== 'string' ||
    !model.boardId ||
    model.boardId.length > 256 ||
    typeof model.basis !== 'string' ||
    !Array.isArray(model.board) ||
    model.board.length !== 1 ||
    !Array.isArray(model.layers) ||
    ![2, 4].includes(model.layers.length) ||
    !Array.isArray(model.dielectricLayers) ||
    model.dielectricLayers.length !== model.layers.length - 1 ||
    !Array.isArray(model.barrels) ||
    model.barrels.length > 3000 ||
    !Array.isArray(model.sources) ||
    !model.sources.length ||
    model.sources.length > 256 ||
    !Array.isArray(model.notices) ||
    !Array.isArray(model.assumptions) ||
    [model.notices, model.assumptions].some(
      (items) =>
        items.length > 128 || items.some((item) => typeof item !== 'string' || item.length > 4096),
    )
  )
    throw new Error('Invalid saved Layout Thermal model.');
  const config = validateThermalConfig(model.config);
  if (
    config.copperThicknessMm.length !== model.layers.length ||
    !config.heatSources.some((source) => source.powerW > 0) ||
    !Object.values(config.convection).some((coefficient) => coefficient > 0)
  )
    throw new Error('Invalid saved Layout Thermal model settings.');
  const body = { ...model };
  delete body.basis;
  if (model.basis !== thermalFingerprint(body))
    throw new Error('The saved Layout Thermal model does not match its input basis.');
  return snapshot;
}

function checkedSolver(solver) {
  if (
    !ownKeys(solver, ['gmsh', 'elmer', 'identity']) ||
    !validKey(solver.identity) ||
    [solver.gmsh, solver.elmer].some(
      (version) => typeof version !== 'string' || !version || version.length > 256,
    )
  )
    throw new Error('Invalid saved Layout Thermal solver identity.');
  return { gmsh: solver.gmsh, elmer: solver.elmer, identity: solver.identity };
}

function checkedResult(input, model, solver) {
  const result = validateThermalResult(input);
  if (
    result.basis !== model.basis ||
    result.solver.gmsh !== solver.gmsh ||
    result.solver.elmer !== solver.elmer
  )
    throw new Error('The saved Layout Thermal result does not match its model and solver.');
  return jsonSnapshot(result, resultLimit);
}

/** The identity includes every retained input, mesh, field and diagnostic byte. */
export function thermalRunKey(model, solver, files) {
  const input = checkedModel(model).value;
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > 64 ||
    new Set(files.map((entry) => entry?.name)).size !== files.length ||
    files.some(
      (entry) =>
        !(
          ownKeys(entry, ['name', 'size', 'sha256']) ||
          (ownKeys(entry, ['name', 'file', 'size', 'sha256']) && typeof entry.file === 'string')
        ) ||
        typeof entry.name !== 'string' ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !validKey(entry.sha256),
    )
  )
    throw new Error('Invalid saved Layout Thermal artifact identity.');
  const sorted = files
    .map(({ name, size, sha256 }) => ({ name, size, sha256 }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return digest(
    JSON.stringify({ format, model: input, solver: checkedSolver(solver), files: sorted }),
  );
}

async function directory(parent, name, create = false) {
  const file = path.join(parent, name);
  if (create)
    await mkdir(file).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  const info = await missing(file);
  if (!info) return null;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    normalize(await realpath(file)) !== normalize(file)
  )
    throw new Error('Layout Thermal folders must be real directories without links.');
  return file;
}

async function regular(file) {
  const info = await missing(file);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.nlink > 1 ||
    !Number.isSafeInteger(info.size)
  )
    throw new Error('Saved Layout Thermal artifacts must be regular files without links.');
  return info;
}

const sameFile = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

async function readChunks(file, signal, limit, consume) {
  signal.throwIfAborted();
  const before = await regular(file);
  if (before.size > limit) throw new Error('The saved Layout Thermal file is too large.');
  const handle = await open(file, 'r');
  try {
    if (!sameFile(before, await handle.stat()))
      throw new Error('A Layout Thermal artifact changed while opening.');
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > before.size || size > limit)
        throw new Error('A Layout Thermal artifact changed while reading.');
      await consume(buffer.subarray(0, bytesRead));
    }
    if (
      size !== before.size ||
      !sameFile(before, await handle.stat()) ||
      !sameFile(before, await regular(file))
    )
      throw new Error('A Layout Thermal artifact changed while reading.');
    signal.throwIfAborted();
    return size;
  } finally {
    await handle.close();
  }
}

async function boundedRead(file, limit, signal) {
  const chunks = [];
  await readChunks(file, signal, limit, (chunk) => chunks.push(Buffer.from(chunk)));
  return Buffer.concat(chunks);
}

async function hashFile(file, signal, size = Infinity) {
  const identity = await regular(file);
  const hash = createHash('sha256');
  const actualSize = await readChunks(file, signal, size, (chunk) => hash.update(chunk));
  if (!sameFile(identity, await regular(file)))
    throw new Error('A Layout Thermal artifact changed while verifying.');
  return { size: actualSize, sha256: hash.digest('hex'), identity };
}

async function copyArtifact(source, destination, signal) {
  const target = await open(destination, 'wx');
  const hash = createHash('sha256');
  try {
    const size = await readChunks(source, signal, Infinity, async (chunk) => {
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        signal.throwIfAborted();
        const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Could not write a complete Layout Thermal artifact.');
        offset += bytesWritten;
      }
    });
    return { size, sha256: hash.digest('hex') };
  } finally {
    await target.close();
  }
}

async function inventory(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const top = entries.map((entry) => entry.name);
  if (artifacts.some((name) => !top.includes(name)) || !top.includes('mesh'))
    throw new Error('The Layout Thermal record is incomplete.');
  const mesh = await directory(folder, 'mesh');
  if (!mesh) throw new Error('The Layout Thermal native mesh is missing.');
  const nested = await readdir(mesh, { withFileTypes: true });
  if (
    meshFiles.some((name) => !nested.some((entry) => entry.name === name)) ||
    nested.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        (![...meshFiles, ...optionalMeshFiles].includes(entry.name) &&
          !vtuName(entry.name) &&
          !meshSidecar(entry.name)),
    )
  )
    throw new Error('The Layout Thermal native mesh contains missing, linked or unknown files.');
  const fields = [
    ...entries.filter((entry) => vtuName(entry.name)).map((entry) => entry.name),
    ...nested.filter((entry) => vtuName(entry.name)).map((entry) => `mesh/${entry.name}`),
  ];
  if (fields.length !== 1)
    throw new Error('The Layout Thermal record must contain exactly one temperature VTU field.');
  const names = [
    ...artifacts,
    ...entries.filter((entry) => meshSidecar(entry.name)).map((entry) => entry.name),
    ...nested.filter((entry) => !vtuName(entry.name)).map((entry) => `mesh/${entry.name}`),
    fields[0],
  ].sort();
  for (const name of names) {
    const info = await regular(path.join(folder, name));
    if (!info.size && !name.endsWith('.log') && name !== 'mesh/mesh.names')
      throw new Error('The Layout Thermal record contains an empty required artifact.');
  }
  return names;
}

/** Only Electron supplies this live native-destination resolver. */
export function createProjectThermalStore(resolveFile) {
  const granted = resolveFile();
  if (!granted) throw new Error('Save the project before running Layout Thermal.');
  const projectFile = path.resolve(granted);
  const projectName = path.basename(projectFile);
  const stem = path.basename(projectFile, path.extname(projectFile));
  const manifestName = analysisFilename(stem, 'manifest.json');
  const lockDirectory = path.join(path.dirname(projectFile), 'thermal');
  let nativeParent;

  async function root(create) {
    const current = resolveFile();
    if (!current || normalize(path.resolve(current)) !== normalize(projectFile))
      throw new Error('The Layout Thermal project grant or destination changed. Save and retry.');
    const parent = await realpath(path.dirname(projectFile));
    if (nativeParent && normalize(parent) !== normalize(nativeParent))
      throw new Error('The Layout Thermal project directory changed. Save and retry.');
    nativeParent = parent;
    return directory(parent, 'thermal', create);
  }

  async function verifyRecord(target, manifest, signal, identities) {
    const solver = checkedSolver(manifest.solver);
    const stored = (name) => manifest.files.find((entry) => entry.name === name).file;
    for (const entry of manifest.files) {
      const actual = await hashFile(path.join(target, entry.file), signal, entry.size);
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256)
        throw new Error('Layout Thermal artifact failed its integrity check: ' + entry.name + '.');
      identities.set(entry.file, actual.identity);
    }
    const inputBytes = await boundedRead(
      path.join(target, stored('input.json')),
      inputLimit,
      signal,
    );
    const resultBytes = await boundedRead(
      path.join(target, stored('result.json')),
      resultLimit,
      signal,
    );
    for (const [name, bytes] of [
      ['input.json', inputBytes],
      ['result.json', resultBytes],
    ])
      if (digest(bytes) !== manifest.files.find((entry) => entry.name === name).sha256)
        throw new Error('Layout Thermal artifact failed its integrity check: ' + name + '.');
    const model = checkedModel(JSON.parse(inputBytes)).value;
    const result = checkedResult(JSON.parse(resultBytes), model, solver).value;
    if (thermalRunKey(model, solver, manifest.files) !== manifest.key)
      throw new Error('The saved Layout Thermal run identity does not match its input.');
    for (const [name, identity] of identities)
      if (!sameFile(identity, await regular(path.join(target, name))))
        throw new Error('A Layout Thermal artifact changed while verifying.');
    return { model, result, solver };
  }

  const logicalArtifact = (name) => {
    if (typeof name !== 'string') return false;
    if ([...artifacts, 'input.json', 'result.json'].includes(name)) return true;
    if (vtuName(name) || meshSidecar(name)) return true;
    if (!name.startsWith('mesh/')) return false;
    const nested = name.slice(5);
    return (
      [...meshFiles, ...optionalMeshFiles].includes(nested) ||
      vtuName(nested) ||
      meshSidecar(nested)
    );
  };

  async function readFlatRecord(parent, signal) {
    const file = path.join(parent, manifestName);
    if (!(await missing(file))) return null;
    const identity = await regular(file);
    const manifest = JSON.parse(await boundedRead(file, manifestLimit, signal));
    const required = [
      ...artifacts,
      ...meshFiles.map((name) => 'mesh/' + name),
      'input.json',
      'result.json',
    ];
    if (
      !ownKeys(manifest, ['format', 'project', 'key', 'createdAt', 'solver', 'files']) ||
      manifest.format !== flatFormat ||
      manifest.project !== projectName ||
      !validKey(manifest.key) ||
      typeof manifest.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > 64 ||
      new Set(manifest.files.map((entry) => entry?.name)).size !== manifest.files.length ||
      new Set(manifest.files.map((entry) => normalize(entry?.file ?? ''))).size !==
        manifest.files.length ||
      required.some((name) => !manifest.files.some((entry) => entry?.name === name)) ||
      manifest.files.filter(
        (entry) => typeof entry?.name === 'string' && vtuName(path.posix.basename(entry.name)),
      ).length !== 1 ||
      manifest.files.some(
        (entry) =>
          !ownKeys(entry, ['name', 'file', 'size', 'sha256']) ||
          !logicalArtifact(entry.name) ||
          entry.file !== analysisFilename(stem, entry.name) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          (!entry.size && !entry.name.endsWith('.log') && entry.name !== 'mesh/mesh.names') ||
          !validKey(entry.sha256),
      )
    )
      throw new Error(
        'Invalid saved flat Layout Thermal manifest. Preserve ' + manifestName + ' and retry.',
      );
    const identities = new Map([[manifestName, identity]]);
    const record = await verifyRecord(parent, manifest, signal, identities);
    return {
      record,
      identities,
      names: [...manifest.files.map((entry) => entry.file), manifestName],
    };
  }

  return {
    async read(signal) {
      signal.throwIfAborted();
      return withAnalysisFiles(lockDirectory, async () => {
        signal.throwIfAborted();
        const parent = await root(false);
        if (!parent) return null;
        try {
          const flat = await readFlatRecord(parent, signal);
          if (!flat) return null;
          await root(false);
          signal.throwIfAborted();
          return flat.record;
        } catch (error) {
          signal.throwIfAborted();
          throw new Error(
            'Could not load saved Layout Thermal files. Preserve thermal/' +
              manifestName +
              '. ' +
              error.message,
          );
        }
      });
    },
    async write(source, input, output, runtime, signal) {
      signal.throwIfAborted();
      const model = checkedModel(input);
      const solver = checkedSolver(runtime);
      const result = checkedResult(output, model.value, solver);
      return withAnalysisFiles(lockDirectory, async () => {
        signal.throwIfAborted();
        const parent = await root(true);
        const previous = await readFlatRecord(parent, signal);
        const sourceDirectory = path.resolve(source);
        if (!(await directory(path.dirname(sourceDirectory), path.basename(sourceDirectory))))
          throw new Error('The Layout Thermal working directory is missing.');
        const logicalNames = await inventory(sourceDirectory);
        const names = [...logicalNames, 'input.json', 'result.json'].map((name) =>
          analysisFilename(stem, name),
        );
        names.push(manifestName);
        if (new Set(names.map(normalize)).size !== names.length)
          throw new Error('Layout Thermal artifact basenames collide in flat storage.');
        const staging = await createAnalysisStaging(parent);
        try {
          const files = [];
          for (const name of logicalNames) {
            const file = analysisFilename(stem, name);
            files.push({
              name,
              file,
              ...(await copyArtifact(
                path.join(sourceDirectory, name),
                path.join(staging, file),
                signal,
              )),
            });
          }
          for (const [name, bytes] of [
            ['input.json', model.bytes],
            ['result.json', result.bytes],
          ]) {
            signal.throwIfAborted();
            const file = analysisFilename(stem, name);
            await writeFile(path.join(staging, file), bytes, { flag: 'wx' });
            files.push({ name, file, size: bytes.length, sha256: digest(bytes) });
          }
          files.sort((left, right) => left.name.localeCompare(right.name));
          const key = thermalRunKey(model.value, solver, files);
          await writeFile(
            path.join(staging, manifestName),
            JSON.stringify({
              format: flatFormat,
              project: projectName,
              key,
              createdAt: new Date().toISOString(),
              solver,
              files,
            }),
            { flag: 'wx' },
          );
          await readFlatRecord(staging, signal);
          await publishAnalysisFiles({
            directory: parent,
            staging,
            previousNames: previous?.names ?? [],
            previousIdentities: previous?.identities,
            nextNames: names,
            manifestName,
            signal,
            check: async () => {
              const current = await root(false);
              if (normalize(current ?? '') !== normalize(parent))
                throw new Error(
                  'The Layout Thermal project destination changed before publication.',
                );
            },
          });
        } finally {
          await discardAnalysisStaging(staging, names);
        }
      });
    },
  };
}
