import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, mkdir, open } from 'node:fs/promises';
import { atomicWrite } from './atomic-write.mjs';
import { logicalSuffixOfCanonical } from './host-path.cjs';
import { parseProject } from './project-format.mjs';
import { children, onlineFootprintLibrary, quote, val } from './library-format.mjs';
import { isOmittableJlcpcbStep } from './jlcpcb-library.mjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const local = /^\$\{KIPRJMOD\}\/models\/([a-f0-9]{64})\.step$/;
const relative = /^\$\{KIPRJMOD\}\/((?:[\w .()+,-]+\/)*[\w .()+,-]+\.(?:step|stp))$/i;
async function bytesAt(file) {
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink > 1 ||
    before.size > 32 * 1024 * 1024 ||
    !logicalSuffixOfCanonical(path.resolve(file), await realpath(file))
  )
    throw new Error('Choose a regular STEP file up to 32 MiB without links.');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(before.size + 1, 32 * 1024 * 1024 + 1));
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 32 * 1024 * 1024) throw new Error('The STEP file exceeds 32 MiB.');
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat(),
      current = await lstat(file);
    if (
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
        (k) => before[k] !== after[k] || before[k] !== current[k],
      ) ||
      bytes.length !== before.size
    )
      throw new Error('The STEP file changed while reading.');
    if (!/^\s*ISO-10303-21;/i.test(bytes.subarray(0, 128).toString()))
      throw new Error('The selected file is not STEP data.');
    return bytes;
  } finally {
    await handle.close();
  }
}
async function directory(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.relative(current, path.resolve(file)).split(path.sep)) {
    current = path.join(current, part);
    let info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) {
      await mkdir(current);
      info = await lstat(current);
    }
    const canonical = await realpath(current);
    if (info.isSymbolicLink()) {
      const target = await lstat(canonical);
      if (!target.isDirectory() || !logicalSuffixOfCanonical(path.resolve(current), canonical))
        throw new Error('Model folders cannot contain links.');
      continue;
    }
    if (!info.isDirectory() || !logicalSuffixOfCanonical(path.resolve(current), canonical))
      throw new Error('Model folders cannot contain links.');
  }
}

export function createComponentModelStore(dataDir, parse) {
  const cache = path.join(dataDir, 'component-models');
  const store = {
    async importFile(file, signal) {
      if (
        typeof file !== 'string' ||
        file.length > 4096 ||
        /[\0\r\n]/.test(file) ||
        !path.isAbsolute(file) ||
        !/\.(step|stp)$/i.test(file)
      )
        throw new Error('Choose a STEP file.');
      return store.importBytes(await bytesAt(file), signal);
    },
    async importBytes(bytes, signal) {
      if (
        bytes.length > 32 * 1024 * 1024 ||
        !/^\s*ISO-10303-21;/i.test(bytes.subarray(0, 128).toString())
      )
        throw new Error('Invalid bounded STEP model.');
      await parse(bytes, signal);
      signal?.throwIfAborted();
      const hash = digest(bytes);
      await directory(cache);
      const target = path.join(cache, hash + '.step');
      const previous = await bytesAt(target).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (previous && !previous.equals(bytes))
        throw new Error('The cached model failed its integrity check.');
      if (!previous)
        await atomicWrite(target, bytes, async () => {
          await directory(path.dirname(target));
          const current = await bytesAt(target).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (current && !current.equals(bytes)) throw new Error('The model destination changed.');
        });
      return { path: '${KIPRJMOD}/models/' + hash + '.step' };
    },
    async read(reference, projectFile) {
      if (typeof reference !== 'string' || reference.length > 4096)
        throw new Error('Invalid STEP reference.');
      const match = relative.exec(reference);
      if (!match || match[1].split('/').some((part) => part.startsWith('.')))
        throw new Error('Use a project-relative STEP model or a supported library model.');
      const hash = local.exec(reference)?.[1];
      let bytes;
      if (projectFile)
        bytes = await bytesAt(path.join(path.dirname(projectFile), match[1])).catch((error) => {
          if (error.code === 'ENOENT' && hash) return null;
          throw error;
        });
      if (!bytes && hash) bytes = await bytesAt(path.join(cache, hash + '.step'));
      if (!bytes) throw new Error('Save the project before reading its STEP models.');
      if (hash && digest(bytes) !== hash)
        throw new Error('The STEP model failed its integrity check.');
      return bytes;
    },
    async prepare(project, destination, source) {
      const plans = new Map();
      for (const footprint of project.pcb?.footprints ?? [])
        for (const model of footprint.models ?? []) {
          if (!relative.test(model.path)) continue;
          const name = relative.exec(model.path)[1];
          // Existing pinned Home assets are prepared by their owning asset store.
          let bytes;
          try {
            bytes = await store.read(model.path, source || destination);
          } catch (error) {
            if (error.code === 'ENOENT' && !local.test(model.path)) continue;
            throw error;
          }
          const target = path.join(path.dirname(destination), name);
          const previous = await bytesAt(target).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (previous && !previous.equals(bytes))
            throw new Error('Preserve the existing changed STEP file: ' + name);
          if (!previous) plans.set(target, bytes);
        }
      for (const [target, bytes] of plans) {
        await directory(path.dirname(target));
        await atomicWrite(target, bytes, async () => {
          await directory(path.dirname(target));
          const current = await bytesAt(target).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (current && !current.equals(bytes)) throw new Error('The model destination changed.');
        });
      }
    },
  };
  return store;
}
/** Prepare an adopted online package; project publication remains a Core/Save operation. */
export async function prepareLibraryPackage(libraries, store, id, signal) {
  const library = typeof id === 'string' && onlineFootprintLibrary(id);
  const name = library && id.slice(library.length + 1);
  if (!name || name.length > 150)
    throw new Error('Choose a NextPCB or JLCPCB package with a supported native filename.');
  signal.throwIfAborted();
  const detail = await libraries.request({ action: 'detail', kind: 'footprints', id, signal });
  signal.throwIfAborted();
  const prepared = structuredClone(detail);
  const models = children(prepared.footprint, 'model');
  if (detail.id !== id || val(prepared.footprint) !== name)
    throw new Error('The prepared package does not match the selected component.');
  if (models.length !== detail.models.length)
    throw new Error('The package model records do not match its native footprint.');
  const missing = new Set();
  for (let index = 0; index < models.length; index++) {
    let bytes;
    try {
      bytes = await libraries.componentModelBytes(id, index, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (library === 'JLCPCB' && isOmittableJlcpcbStep(error)) {
        missing.add(models[index]);
        continue;
      }
      throw error;
    }
    signal.throwIfAborted();
    const selected = await store.importBytes(bytes, signal);
    signal.throwIfAborted();
    if (!local.test(selected.path)) throw new Error('The prepared STEP reference is invalid.');
    models[index][1] = quote(selected.path);
    prepared.models[index].path = selected.path;
  }
  if (missing.size) {
    prepared.footprint = prepared.footprint.filter((node) => !missing.has(node));
    prepared.models = prepared.models.filter((_, index) => !missing.has(models[index]));
  }
  return { ...prepared, projectAssets: true };
}

export function registerComponentModels(app, store, libraries, files) {
  let packages = Promise.resolve();
  let packageRequests = 0;
  app.post('/api/library-package', async (req, res) => {
    const control = new AbortController();
    res.on('close', () => control.abort());
    const body = req.body;
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).join(',') !== 'id' ||
      typeof body.id !== 'string' ||
      body.id.length > 500
    )
      return res.status(422).json({ error: 'Send one NextPCB or JLCPCB component identity.' });
    if (packageRequests >= 8)
      return res
        .status(422)
        .json({ error: 'Too many packages are being prepared. Retry shortly.' });
    packageRequests++;
    // Serialize imports so a three-package sync does not exhaust the STEP pool.
    const prepared = packages.then(() => {
      control.signal.throwIfAborted();
      return prepareLibraryPackage(libraries, store, body.id, control.signal);
    });
    packages = prepared.then(
      () => {},
      () => {},
    );
    try {
      const result = await prepared;
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: error.message });
    } finally {
      packageRequests--;
    }
  });
  app.post('/api/component-model/library', async (req, res) => {
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      const body = req.body;
      if (
        !body ||
        Object.keys(body).sort().join(',') !== 'id,index' ||
        typeof body.id !== 'string' ||
        body.id.length > 256 ||
        !Number.isSafeInteger(body.index) ||
        body.index < 0
      )
        throw new Error('Choose a library model index.');
      const bytes = await libraries.componentModelBytes(body.id, body.index, control.signal);
      control.signal.throwIfAborted();
      const selected = await store.importBytes(bytes, control.signal);
      if (!res.destroyed) res.json(selected);
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: error.message });
    }
  });
  app.post('/api/component-model', async (req, res) => {
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      const body = req.body;
      if (
        !body ||
        Object.keys(body).some((k) => !['source', 'fileId', 'footprintId', 'index'].includes(k)) ||
        typeof body.source !== 'string' ||
        !Number.isSafeInteger(body.index) ||
        body.index < 0 ||
        typeof body.footprintId !== 'string' ||
        (body.fileId !== undefined && !/^[a-f0-9-]{36}$/i.test(body.fileId))
      )
        throw new Error('Send the current project, component and model index.');
      const project = parseProject(body.source);
      const model = project.pcb?.footprints.find((f) => f.id === body.footprintId)?.models?.[
        body.index
      ];
      if (!model) throw new Error('The component model is unavailable.');
      let result;
      if (model.path.startsWith('${KIPRJMOD}/')) {
        const file = body.fileId ? files?.resolve(body.fileId) : undefined;
        if (body.fileId && !file) throw new Error('The project file grant is unavailable.');
        const bytes = await store.read(model.path, file);
        result = await libraries.parseStep(bytes, control.signal);
        if (body.fileId && files.resolve(body.fileId) !== file)
          throw new Error('The project location changed.');
      } else result = await libraries.modelPath(model.path, control.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: error.message });
    }
  });
}
