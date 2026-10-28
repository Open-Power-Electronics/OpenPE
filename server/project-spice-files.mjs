import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validatedSimulationResult } from './spice-format.mjs';
import {
  analysisFilename,
  createAnalysisStaging,
  discardAnalysisStaging,
  publishAnalysisFiles,
  withAnalysisFiles,
} from './flat-analysis-files.mjs';

const normalize = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const outputs = ['circuit.cir', 'waveforms.raw', 'waveforms.txt', 'solver.log'];
const configIds = ['inputId', 'pwmId', 'outputId', 'switchId', 'currentId'];
const configNumbers = ['voltage', 'frequency', 'duty', 'stop', 'step'];
/** Validate persisted settings before using them to compile a current-source deck. */
export function validateSpiceConfig(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== configIds.length + configNumbers.length ||
    Object.keys(value).some((name) => ![...configIds, ...configNumbers].includes(name)) ||
    configIds.some((name) => typeof value[name] !== 'string' || value[name].length > 256) ||
    configNumbers.some(
      (name) => typeof value[name] !== 'number' || !Number.isFinite(value[name]),
    ) ||
    value.stop <= 0 ||
    value.step <= 0
  )
    throw new Error('Invalid or unknown transient settings.');
  return Object.fromEntries([...configIds, ...configNumbers].map((name) => [name, value[name]]));
}
function validateManifest(manifest, key) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).some(
      (name) =>
        ![
          'format',
          'key',
          'resultSha256',
          'solverVersion',
          'compatibility',
          'config',
          'identityVersion',
          'solverSha256',
          'project',
          'files',
        ].includes(name),
    ) ||
    manifest.format !== 'openpe-spice-v2' ||
    typeof key !== 'string' ||
    !/^[a-f0-9]{64}$/.test(key) ||
    manifest.key !== key ||
    typeof manifest.resultSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.resultSha256) ||
    typeof manifest.solverVersion !== 'string' ||
    !manifest.solverVersion ||
    manifest.solverVersion.length > 4096 ||
    ![null, 'ps', 'psa'].includes(manifest.compatibility) ||
    manifest.identityVersion !== 2 ||
    typeof manifest.solverSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.solverSha256)
  )
    throw new Error('Invalid saved simulation manifest.');
  if (
    typeof manifest.project !== 'string' ||
    path.basename(manifest.project) !== manifest.project ||
    !/\.kicad_pro$/i.test(manifest.project) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < outputs.length + 1 ||
    manifest.files.length > 38 ||
    new Set(manifest.files.map((entry) => entry?.name)).size !== manifest.files.length ||
    [...outputs, 'result.json'].some(
      (name) => !manifest.files.some((entry) => entry.name === name),
    ) ||
    manifest.files.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).sort().join(',') !== 'file,name' ||
        (![...outputs, 'result.json'].includes(entry.name) &&
          !/^(?:ti-model|example-model-\d+)\.lib$/.test(entry.name)) ||
        entry.file !==
          analysisFilename(
            path.basename(manifest.project, path.extname(manifest.project)),
            entry.name,
          ),
    )
  )
    throw new Error('Invalid flat simulation artifact manifest.');
  return validateSpiceConfig(manifest.config);
}
const modelNames = (deck) => [
  ...(deck.modelId ? ['ti-model.lib'] : []),
  ...(deck.modelIds || []).map((_id, index) => `example-model-${index}.lib`),
];
const missing = async (file) =>
  lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

async function directory(parent, name, create) {
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
    throw new Error('The project spice folders must be real directories without links.');
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
    throw new Error('Saved SPICE files must be regular files without links.');
  return info;
}

const sameFile = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

async function boundedRead(file, limit) {
  const info = await regular(file);
  if (info.size > limit) throw new Error('The saved SPICE result is too large.');
  const handle = await open(file, 'r');
  try {
    if (!sameFile(info, await handle.stat()))
      throw new Error('The saved SPICE result changed while opening.');
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (
      size !== info.size ||
      !sameFile(info, await handle.stat()) ||
      !sameFile(info, await regular(file))
    )
      throw new Error('The saved SPICE result changed while reading.');
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

function validateStoredResult(value, deck, config) {
  return validatedSimulationResult(value, deck || { stop: config.stop, traces: value.traces });
}

/** Only Electron supplies this resolver; no renderer path enters the store. */
export function createProjectSpiceStore(resolveFile) {
  const granted = resolveFile();
  if (!granted) throw new Error('Save the project before running a simulation.');
  const projectFile = path.resolve(granted);
  const projectName = path.basename(projectFile);
  const stem = path.basename(projectFile, path.extname(projectFile));
  const manifestName = analysisFilename(stem, 'manifest.json');
  let nativeParent;
  async function root(create) {
    const current = resolveFile();
    if (!current || normalize(path.resolve(current)) !== normalize(projectFile))
      throw new Error(
        'The simulation project destination changed. Run again for this destination.',
      );
    const parent = await realpath(path.dirname(projectFile));
    if (nativeParent && normalize(parent) !== normalize(nativeParent))
      throw new Error('The simulation project directory changed. Save and retry.');
    nativeParent = parent;
    return directory(parent, 'spice', create);
  }
  async function locked(signal, operation) {
    signal.throwIfAborted();
    const parent = await root(false);
    return withAnalysisFiles(parent ?? path.join(nativeParent, 'spice'), () => {
      signal.throwIfAborted();
      return operation();
    });
  }
  const validateKey = (key) => {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
      throw new Error('Invalid saved simulation identity.');
  };
  async function flatManifest(parent) {
    const file = path.join(parent, manifestName);
    if (!(await missing(file))) return null;
    const bytes = await boundedRead(file, 16384);
    const value = JSON.parse(bytes);
    validateManifest(value, value?.key);
    if (value.format !== 'openpe-spice-v2' || normalize(value.project) !== normalize(projectName))
      throw new Error(
        'The saved SPICE manifest belongs to another project. Preserve it and retry.',
      );
    return { value, bytes };
  }
  async function latest(parent) {
    return (await flatManifest(parent))?.value.key ?? null;
  }
  async function record(key, signal, deck) {
    signal.throwIfAborted();
    const parent = await root(false);
    if (!parent) return null;
    const flat = await flatManifest(parent);
    if (!flat || flat.value.key !== key) return null;
    const manifest = flat.value;
    const paths = new Map(manifest.files.map((entry) => [entry.name, entry.file]));
    const file = (name) => {
      const physical = paths.get(name);
      if (!physical) throw new Error(`The saved SPICE artifact is missing: ${name}.`);
      return path.join(parent, physical);
    };
    const identities = new Map();
    for (const entry of manifest.files) identities.set(entry.file, await regular(file(entry.name)));
    identities.set(manifestName, await regular(path.join(parent, manifestName)));
    try {
      const config = validateManifest(manifest, key);
      for (const name of [...outputs, ...(deck ? modelNames(deck) : [])]) await regular(file(name));
      const bytes = await boundedRead(file('result.json'), 32 * 1024 * 1024);
      if (digest(bytes) !== manifest.resultSha256)
        throw new Error('The saved simulation result failed its integrity check.');
      const value = JSON.parse(bytes);
      const result = validateStoredResult(value, deck, config);
      if (result.version !== manifest.solverVersion)
        throw new Error('The saved simulation solver version does not match its manifest.');
      if ((result.traces.length + 1) * result.time.length > 1100000)
        throw new Error('The saved simulation exceeds the display budget.');
      for (const [name, before] of identities)
        if (!sameFile(before, await regular(path.join(parent, name))))
          throw new Error('A saved SPICE artifact changed while validating its record.');
      await root(false);
      signal.throwIfAborted();
      return {
        result,
        config,
        manifest,
        identities,
      };
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        `Could not load the saved SPICE result. Preserve the spice files for ${stem} and retry. ${error.message}`,
      );
    }
  }
  return {
    async read(key, deck, signal, identity) {
      validateKey(key);
      return locked(signal, async () => {
        const saved = await record(key, signal, deck);
        if (!saved) return null;
        if (
          identity &&
          (saved.manifest.identityVersion !== identity.identityVersion ||
            saved.manifest.solverSha256 !== identity.solverSha256 ||
            saved.manifest.solverVersion !== identity.solverVersion)
        )
          throw new Error(
            'The saved simulation solver identity does not match its verified inputs.',
          );
        return saved.result;
      });
    },
    readSettings(signal) {
      return locked(signal, async () => {
        const parent = await root(false);
        const key = parent && (await latest(parent));
        if (!key) return null;
        const saved = await record(key, signal);
        if (!saved) return null;
        return { key, config: saved.config };
      });
    },
    write(key, source, result, signal, deck, settings, identity) {
      return locked(signal, async () => {
        validateKey(key);
        const config = validateSpiceConfig(settings);
        if (
          !identity ||
          identity.identityVersion !== 2 ||
          Object.keys(identity).some(
            (name) => !['identityVersion', 'solverSha256'].includes(name),
          ) ||
          typeof identity.solverSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(identity.solverSha256)
        )
          throw new Error('Invalid saved simulation solver identity.');
        validatedSimulationResult(result, deck);
        const parent = await root(true);
        const previous = await flatManifest(parent);
        const saved = previous ? await record(previous.value.key, signal) : null;
        if (previous?.value.key === key)
          throw new Error('A saved SPICE record already exists. Preserve or move it and retry.');
        const names = [...outputs, ...modelNames(deck), 'result.json'];
        const files = names.map((name) => ({ name, file: analysisFilename(stem, name) }));
        const nextNames = [...files.map((entry) => entry.file), manifestName];
        const staging = await createAnalysisStaging(parent);
        try {
          for (const name of [...outputs, ...modelNames(deck)]) {
            signal.throwIfAborted();
            const original = path.join(source, name);
            const before = await regular(original);
            await copyFile(original, path.join(staging, analysisFilename(stem, name)));
            if (!sameFile(before, await regular(original)))
              throw new Error('A completed SPICE artifact changed while copying.');
          }
          const bytes = JSON.stringify(result);
          await writeFile(path.join(staging, analysisFilename(stem, 'result.json')), bytes, {
            flag: 'wx',
          });
          const manifest = {
            format: 'openpe-spice-v2',
            project: projectName,
            key,
            files,
            resultSha256: digest(bytes),
            solverVersion: result.version,
            compatibility: deck.compatibility || null,
            config,
            ...identity,
          };
          validateManifest(manifest, key);
          await writeFile(path.join(staging, manifestName), JSON.stringify(manifest), {
            flag: 'wx',
          });
          await publishAnalysisFiles({
            directory: parent,
            staging,
            previousNames: previous
              ? [...previous.value.files.map((entry) => entry.file), manifestName]
              : [],
            previousIdentities: saved?.identities,
            nextNames,
            manifestName,
            signal,
            check: async () => {
              if ((await root(false)) !== parent)
                throw new Error('The simulation project directory changed.');
            },
          });
        } finally {
          await discardAnalysisStaging(staging, nextNames);
        }
      });
    },
  };
}
