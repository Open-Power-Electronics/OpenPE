import path from 'node:path';
import { open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { bundledPlugins as catalog } from '../plugins/catalog.mjs';
const actions = ['install', 'uninstall', 'enable', 'disable'];

export function bundledWorkbenchCatalog() {
  return {
    controlsVersion: 1,
    browse: true,
    actions: [...actions],
    warning: '',
    updatedAt: Date.now(),
    plugins: catalog.map((plugin) => ({
      ...plugin,
      marketplace: 'OpenPE Marketplace',
      scope: 'application',
      origin: 'openpe',
      managed: false,
      installed: true,
      enabled: true,
    })),
  };
}

// Bundled, allowlisted application features only. Installing activates packaged
// resources; no provider command, renderer path or downloaded code is executed.
export function createWorkbenchPlugins(dataDir, options = {}) {
  const file = dataDir === null ? null : path.join(dataDir, 'workbench-plugins-v1.json');
  let tail = Promise.resolve();
  let state;
  let reading;
  const listeners = new Set();
  function read() {
    if (!reading)
      reading = readState().finally(() => {
        reading = undefined;
      });
    return reading;
  }
  async function readState() {
    if (state) return state;
    if (!file) return (state = catalog.map(({ id }) => ({ id, installed: true, enabled: true })));
    let handle;
    try {
      handle = await open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid plugin state');
      const bytes = Buffer.alloc(16385);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16384) throw new Error('Invalid plugin state');
      const data = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (
        !data ||
        data.version !== 1 ||
        Object.keys(data).some((key) => !['version', 'plugins'].includes(key)) ||
        !Array.isArray(data.plugins) ||
        data.plugins.length !== catalog.length ||
        new Set(data.plugins.map((row) => row?.id)).size !== data.plugins.length ||
        data.plugins.some(
          (row) =>
            !row ||
            Object.keys(row).some((key) => !['id', 'installed', 'enabled'].includes(key)) ||
            !catalog.some((plugin) => plugin.id === row.id) ||
            typeof row.installed !== 'boolean' ||
            typeof row.enabled !== 'boolean' ||
            (!row.installed && row.enabled),
        )
      )
        throw new Error('Invalid plugin state');
      state = data.plugins;
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(
          'OpenPE plugin settings could not be read. The original file was preserved. Repair workbench-plugins-v1.json in application data and restart OpenPE.',
        );
      state = catalog.map(({ id }) => ({ id, installed: true, enabled: true }));
    } finally {
      await handle?.close();
    }
    return state;
  }
  return {
    async list() {
      await tail;
      const rows = await read();
      const result = bundledWorkbenchCatalog();
      result.plugins = result.plugins.map((plugin) => ({
        ...plugin,
        ...rows.find((row) => row.id === plugin.id),
      }));
      if (options.runtime) result.plugins.push(...(await options.runtime.list()));
      return result;
    },
    async require(id) {
      await tail;
      const builtin = catalog.find((row) => row.id === id);
      // A local package failure cannot block an unrelated built-in solver/guidance gate.
      const plugin = builtin
        ? { ...builtin, ...(await read()).find((row) => row.id === id) }
        : (await options.runtime?.list())?.find((row) => row.id === id);
      if (!plugin?.installed || !plugin.enabled)
        throw new Error(
          `Install and enable ${plugin?.name ?? id} in Plugins > Marketplace to use this plugin.`,
        );
    },
    subscribe(listener) {
      listeners.add(listener);
      const removeRuntime = options.runtime?.subscribe(listener);
      return () => {
        listeners.delete(listener);
        removeRuntime?.();
      };
    },
    async change(action, id, signal) {
      if (
        !catalog.some((plugin) => plugin.id === id) &&
        options.runtime &&
        actions.includes(action)
      )
        return options.runtime.change(action, id, signal);
      if (!actions.includes(action) || !catalog.some((plugin) => plugin.id === id))
        throw new Error('Unknown OpenPE plugin or action. Choose a plugin from Marketplace.');
      const operation = tail.then(async () => {
        const rows = await read();
        if (signal?.aborted)
          throw new Error('Plugin operation cancelled. Refresh to check its state.');
        const current = rows.find((row) => row.id === id);
        if (!current.installed && action !== 'install' && action !== 'uninstall')
          throw new Error('Install the plugin before enabling it.');
        const next = rows.map((row) =>
          row.id !== id
            ? row
            : {
                id,
                installed: action === 'uninstall' ? false : true,
                enabled: action === 'install' || action === 'enable',
              },
        );
        if (file) {
          const temp = `${file}.${randomUUID()}.tmp`;
          try {
            await (options.write || writeFile)(
              temp,
              JSON.stringify({ version: 1, plugins: next }),
              {
                flag: 'wx',
              },
            );
            if (signal?.aborted)
              throw new Error('Plugin operation cancelled. Refresh to check its state.');
            await rename(temp, file);
          } finally {
            await unlink(temp).catch(() => {});
          }
        }
        state = next;
        const changed = next.find((row) => row.id === id);
        for (const listener of listeners) {
          try {
            // Observers cannot alter confirmed lifecycle state or prevent cancellation.
            listener(id, { ...changed });
          } catch {}
        }
        return { ok: true };
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
}

export function registerWorkbenchPlugins(app, service) {
  app.get('/api/workbench-plugins', async (req, res) => {
    if (Object.keys(req.query).length)
      return res
        .status(400)
        .json({ error: 'OpenPE Marketplace does not accept catalog selectors.' });
    try {
      res.json(await service.list());
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
  });
  app.post('/api/workbench-plugins', async (req, res) => {
    if (
      !req.body ||
      Object.keys(req.body).some((key) => !['id', 'action'].includes(key)) ||
      !actions.includes(req.body.action) ||
      typeof req.body.id !== 'string'
    )
      return res
        .status(400)
        .json({ error: 'Unknown OpenPE plugin or action. Choose a plugin from Marketplace.' });
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      if (!(await service.list()).plugins.some((plugin) => plugin.id === req.body.id))
        return res.status(400).json({
          error:
            'Unknown OpenPE plugin. Choose an installed plugin or a bundled Marketplace entry.',
        });
      res.json(await service.change(req.body.action, req.body.id, control.signal));
    } catch (error) {
      if (!res.destroyed) res.status(503).json({ error: error.message });
    }
  });
}
