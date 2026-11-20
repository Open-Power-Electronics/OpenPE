import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { validatePluginManifest } from './manifest.mjs';
import { bundledPlugins } from '../catalog.mjs';
import { compileCapabilitySchema } from '../../server/capability-schema-format.mjs';

const maxBytes = 4 * 1024 * 1024;
const digest = (source) => createHash('sha256').update(source).digest('hex');
const packageKeys = ['format', 'version', 'manifest', 'source'];
export function validatePluginPackage(value) {
  if (
    !value ||
    value.format !== 'openpe-plugin' ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !packageKeys.includes(key)) ||
    typeof value.source !== 'string' ||
    !value.source.length ||
    Buffer.byteLength(value.source) > 1024 * 1024
  )
    throw new Error('Invalid OpenPE plugin package.');
  const manifest = validatePluginManifest(value.manifest);
  if (bundledPlugins.some(({ id }) => id === manifest.id))
    throw new Error('A local plugin cannot replace a built-in plugin.');
  for (const command of manifest.contributes.commands) compileCapabilitySchema(command.inputSchema);
  return { format: 'openpe-plugin', version: 1, manifest, source: value.source };
}

export async function readPluginPackage(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    throw new Error('Choose a regular plugin package of at most 4 MiB.');
  const handle = await open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (stat.dev !== info.dev || stat.ino !== info.ino || stat.size > maxBytes)
      throw new Error('Plugin package changed while opening.');
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error('Plugin package is too large.');
    return validatePluginPackage(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally {
    await handle.close();
  }
}

/** Application-owned storage and isolated execution; installation is native-only. */
export function createRuntimePlugins(dataDir) {
  const root = dataDir === null ? null : path.join(dataDir, 'plugins');
  const listeners = new Set();
  const active = new Map();
  const epochs = new Map();
  let tail = Promise.resolve();
  let closed = false;
  async function directory(create = false) {
    if (!root) return false;
    if (create) await mkdir(root, { recursive: true });
    const info = await lstat(root).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Plugin storage must be a real directory.');
    return true;
  }
  function filename(id) {
    if (!/^[a-z][a-z0-9-]{0,63}@[a-z][a-z0-9-]{0,63}$/.test(id))
      throw new Error('Unknown plugin ID.');
    return path.join(root, id, 'package.json');
  }
  async function read(id) {
    if (!(await directory())) throw new Error('Plugin is not installed.');
    const file = filename(id);
    const folder = await lstat(path.dirname(file));
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw new Error('Plugin directories cannot be links.');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
      throw new Error('Invalid installed plugin. Original files were preserved.');
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat();
      if (stat.dev !== info.dev || stat.ino !== info.ino)
        throw new Error('Plugin changed while opening.');
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > maxBytes) throw new Error('Installed plugin is too large.');
      const record = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      const pkg = validatePluginPackage(record.package);
      if (
        Object.keys(record).some(
          (key) => !['version', 'package', 'enabled', 'sha256'].includes(key),
        ) ||
        record.version !== 1 ||
        pkg.manifest.id !== id ||
        typeof record.enabled !== 'boolean' ||
        record.sha256 !== digest(JSON.stringify(pkg))
      )
        throw new Error('Invalid installed plugin. Original files were preserved.');
      return { ...record, package: pkg };
    } finally {
      await handle.close();
    }
  }
  async function rows() {
    if (!(await directory())) return [];
    const files = (await readdir(root)).filter((name) => !name.startsWith('.')).sort();
    if (files.length > 256) throw new Error('Too many installed plugins.');
    return Promise.all(files.map((id) => read(id)));
  }
  function cancel(id) {
    for (const control of active.get(id) ?? []) control.abort();
  }
  function notify(id, enabled, installed = true) {
    for (const listener of listeners) {
      try {
        listener(id, { installed, enabled });
      } catch {}
    }
  }
  async function write(record) {
    await directory(true);
    const target = filename(record.package.manifest.id);
    await mkdir(path.dirname(target), { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const folder = await lstat(path.dirname(target));
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw new Error('Plugin directories cannot be links.');
    const info = await lstat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (info && (!info.isFile() || info.isSymbolicLink()))
      throw new Error('Plugin storage cannot contain links.');
    const temporary = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.close();
      await rename(temporary, target);
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  function serialize(operation) {
    if (closed) return Promise.reject(new Error('Plugin runtime is closed.'));
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async list() {
      await tail;
      return (await rows()).map(({ package: { manifest }, enabled, sha256 }) => ({
        ...manifest,
        sha256,
        scope: 'application',
        marketplace: 'Local plugins',
        origin: 'openpe',
        managed: false,
        installed: true,
        enabled,
      }));
    },
    install(value) {
      const pkg = validatePluginPackage(value);
      return serialize(async () => {
        if (!root) throw new Error('Install plugins in the desktop app.');
        if ((await rows()).length >= 256) throw new Error('Too many installed plugins.');
        // Replacements require uninstall and another native approval, including permission changes.
        if (
          await lstat(filename(pkg.manifest.id)).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          })
        )
          throw new Error('Uninstall the existing plugin before installing this package.');
        await write({
          version: 1,
          package: pkg,
          sha256: digest(JSON.stringify(pkg)),
          enabled: true,
        });
        epochs.set(pkg.manifest.id, (epochs.get(pkg.manifest.id) ?? 0) + 1);
        notify(pkg.manifest.id, true);
        return { id: pkg.manifest.id };
      });
    },
    change(action, id, signal) {
      return serialize(async () => {
        const record = await read(id);
        signal?.throwIfAborted();
        if (action === 'uninstall') {
          const entries = await readdir(path.dirname(filename(id)));
          if (entries.some((name) => name !== 'package.json'))
            throw new Error('Plugin folder contains unknown files. Original files were preserved.');
          await unlink(filename(id));
          await rmdir(path.dirname(filename(id)));
        } else if (action === 'enable' || action === 'disable')
          await write({ ...record, enabled: action === 'enable' });
        else throw new Error('Choose a local package to install this plugin.');
        epochs.set(id, (epochs.get(id) ?? 0) + 1);
        cancel(id);
        notify(id, action === 'enable', action !== 'uninstall');
        return { ok: true };
      });
    },
    async run(id, commandId, input, context, expectedHash, signal) {
      await tail;
      if (closed) throw new Error('Plugin runtime is closed.');
      const epoch = epochs.get(id) ?? 0;
      const record = await read(id);
      if (!record.enabled) throw new Error('Enable this plugin before running it.');
      if (expectedHash !== record.sha256)
        throw new Error('Plugin package changed. Refresh Plugins before retrying.');
      const command = record.package.manifest.contributes.commands.find(
        ({ id }) => id === commandId,
      );
      if (!command) throw new Error('Unknown plugin command.');
      const validation = compileCapabilitySchema(command.inputSchema)(input);
      if (!validation.valid) throw new Error('Invalid plugin command input.');
      if (context !== null && !record.package.manifest.permissions.includes('project.read'))
        throw new Error('Plugin has no project read permission.');
      if (Buffer.byteLength(JSON.stringify({ input, context })) > 12 * 1024 * 1024)
        throw new Error('Plugin input exceeds its limit.');
      signal?.throwIfAborted();
      if (closed || epoch !== (epochs.get(id) ?? 0)) throw new Error('Plugin operation cancelled.');
      const controls = active.get(id) ?? new Set();
      if (
        controls.size >= 4 ||
        [...active.values()].reduce((count, set) => count + set.size, 0) >= 8
      )
        throw new Error('Plugin runtime is busy.');
      const control = new AbortController();
      controls.add(control);
      active.set(id, controls);
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./sandbox-worker.mjs', import.meta.url), {
          workerData: { source: record.package.source, handler: command.handler, input, context },
          resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 2 },
        });
        let done = false;
        const finish = (error, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          controls.delete(control);
          if (!controls.size) active.delete(id);
          void worker.terminate();
          error ? reject(error) : resolve(value);
        };
        const abort = () => finish(new Error('Plugin operation cancelled.'));
        const timer = setTimeout(
          () => finish(new Error('Plugin execution exceeded its time limit.')),
          5000,
        );
        signal?.addEventListener('abort', abort, { once: true });
        control.signal.addEventListener('abort', abort, { once: true });
        worker.once('message', (message) =>
          finish(message.error ? new Error(message.error) : null, message.output),
        );
        worker.once('error', () => finish(new Error('Plugin worker failed.')));
        worker.once('exit', () => {
          if (!done) finish(new Error('Plugin worker stopped before completing.'));
        });
        if (signal?.aborted) abort();
      });
    },
    close() {
      closed = true;
      for (const id of active.keys()) cancel(id);
      listeners.clear();
    },
  };
}

export function registerRuntimePlugins(app, plugins) {
  app.post('/api/runtime-plugins/run', async (req, res) => {
    const body = req.body;
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !['id', 'command', 'input', 'context', 'sha256'].includes(key),
      ) ||
      typeof body.id !== 'string' ||
      typeof body.command !== 'string' ||
      typeof body.sha256 !== 'string' ||
      !Object.hasOwn(body, 'input') ||
      !Object.hasOwn(body, 'context')
    )
      return res.status(400).json({ error: 'Invalid plugin execution request.' });
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      res.json(
        await plugins.run(
          body.id,
          body.command,
          body.input,
          body.context,
          body.sha256,
          control.signal,
        ),
      );
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: error.message });
    }
  });
}
