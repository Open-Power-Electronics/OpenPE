import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveAgent } from './agents.mjs';
import { enrichPluginCatalog } from './plugin-metadata.mjs';
import { createPluginInstallations } from './plugin-installations.mjs';
import { setCodexPluginEnabled } from './plugin-toggle.mjs';
import { validPluginId } from './plugin-id.mjs';
export { validPluginId } from './plugin-id.mjs';

const providers = ['codex', 'claude'];
const actions = ['install', 'uninstall', 'enable', 'disable'];
const text = (value, limit = 300) => (typeof value === 'string' ? value.slice(0, limit) : '');

// All commands are selected here, never provided by the renderer. stdin is closed:
// authentication and command-source approval remain with the provider's own UI.
export async function runPluginCommand(provider, args, cwd, signal, options = {}) {
  const launch = await (options.resolve || resolveAgent)(provider);
  if (signal.aborted) throw new Error('Plugin operation cancelled. Refresh to check its state.');
  return new Promise((resolve, reject) => {
    const proc = spawn(launch.file, [...launch.args, 'plugin', ...args], {
      cwd,
      env: launch.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '',
      stderr = '',
      bytes = 0,
      failure;
    const stop = (message) => {
      if (failure) return;
      failure = new Error(message);
      if (proc.pid && process.platform === 'win32') {
        execFile(
          'taskkill.exe',
          ['/pid', String(proc.pid), '/t', '/f'],
          { windowsHide: true, timeout: 5000 },
          (error) => {
            if (error) proc.kill('SIGKILL');
          },
        );
      } else if (proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          proc.kill('SIGKILL');
        }
      }
    };
    const abort = () => stop('Plugin operation cancelled. Refresh to check its state.');
    const timer = setTimeout(
      () => stop('Plugin operation timed out. Check the CLI connection and refresh.'),
      options.timeoutMs || 60000,
    );
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const collect = (data, error) => {
      bytes += data.length;
      if (bytes > (options.maxBytes || 4_000_000))
        return stop('Plugin output exceeded the supported size.');
      if (error) stderr += stderrDecoder.write(data);
      else stdout += stdoutDecoder.write(data);
    };
    proc.stdout.on('data', (data) => collect(data, false));
    proc.stderr.on('data', (data) => collect(data, true));
    proc.stdin.on('error', () => {});
    proc.on('error', () => {
      clean();
      reject(new Error('Could not start the plugin CLI. Detect agents in Settings and retry.'));
    });
    proc.on('close', (code) => {
      clean();
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          new Error(
            text((stderr || stdout).trim(), 1200) ||
              'Plugin command failed. Check your CLI installation and sign-in.',
          ),
        );
      resolve({ stdout, stderr });
    });
    signal.addEventListener('abort', abort, { once: true });
    proc.stdin.end();
    if (signal.aborted) abort();
  });
}

export function normalizePlugins(provider, data) {
  const installed = Array.isArray(data) ? data : data?.installed;
  if (!Array.isArray(installed) || installed.length > 2000)
    throw new Error('The CLI returned an unsupported plugin catalog. Update the CLI and retry.');
  const items = new Map();
  for (const row of installed) {
    const id = row?.pluginId ?? row?.id;
    if (!validPluginId(id))
      throw new Error('The CLI returned an invalid plugin ID. Update the CLI and retry.');
    const scope = provider === 'claude' ? text(row.scope, 30) : 'user';
    const managed =
      (row.installPolicy != null && row.installPolicy !== 'AVAILABLE') || scope !== 'user';
    items.set(`${id}:${scope}`, {
      id,
      scope,
      name: text(row.name, 160) || id.split('@')[0],
      marketplace: text(row.marketplaceName, 160) || id.split('@')[1],
      description: text(row.description, 600),
      version: text(row.version, 80),
      installed: true,
      enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
      managed,
      policy: text(row.installPolicy, 80),
    });
  }
  return [...items.values()];
}

export function createPluginService(cwd, options = {}) {
  const installations = createPluginInstallations(options.dataDir);
  const run =
    options.run || ((provider, args, signal) => runPluginCommand(provider, args, cwd, signal));
  const catalogs = new Map();
  const cache = new Map();
  const now = options.now || Date.now;
  const toggle =
    options.toggle || ((id, enabled, signal) => setCodexPluginEnabled(id, enabled, cwd, signal));
  const capabilities = new Map();
  async function detect(provider, signal) {
    if (!providers.includes(provider)) throw new Error('Unknown agent.');
    const { stdout } = await run(provider, ['--help'], signal);
    const has = (name) => new RegExp(`^\\s+${name}(?:[ |<\\[]|$)`, 'm').test(stdout);
    const supported = {
      controlsVersion: 1,
      browse: has('list'),
      marketplaces: has('marketplace'),
      actions: actions.filter((action) =>
        has(
          provider === 'codex' ? { install: 'add', uninstall: 'remove' }[action] || action : action,
        ),
      ),
    };
    capabilities.set(provider, supported);
    if (provider === 'codex' && supported.browse)
      supported.actions = [...new Set([...supported.actions, 'enable', 'disable'])];
    return supported;
  }
  const service = {
    async list(provider, signal, refresh = false) {
      if (!providers.includes(provider)) throw new Error('Unknown agent.');
      if (signal.aborted) throw new Error('Plugin operation cancelled.');
      const saved = cache.get(provider);
      if (!refresh && saved && now() - saved.updatedAt < 300000) return saved;
      cache.delete(provider);
      catalogs.delete(provider);
      const support = await detect(provider, signal);
      if (!support.browse)
        return {
          plugins: [],
          ...support,
          warning: 'This CLI cannot list installed plugins. Update it and refresh.',
        };
      // Enumerating configured Codex sources avoids coupling the entire local
      // catalog to a remote directory request (which can fail independently).
      let result;
      if (provider === 'codex' && support.marketplaces) {
        const sources = JSON.parse(
          (await run(provider, ['marketplace', 'list', '--json'], signal)).stdout,
        );
        if (
          !Array.isArray(sources.marketplaces) ||
          sources.marketplaces.length > 20 ||
          sources.marketplaces.some(
            (source) =>
              typeof source.name !== 'string' ||
              !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(source.name),
          )
        )
          throw new Error('The CLI returned an unsupported marketplace list. Update it and retry.');
        const data = { installed: [] },
          warnings = [];
        let loaded = 0;
        for (const source of sources.marketplaces) {
          try {
            const response = await run(
              provider,
              ['list', '--marketplace', source.name, '--json'],
              signal,
            );
            const catalog = JSON.parse(response.stdout);
            normalizePlugins(provider, catalog);
            data.installed.push(...catalog.installed);
            loaded++;
            if (response.stderr.trim()) warnings.push(response.stderr.trim());
          } catch (error) {
            if (signal.aborted) throw error;
            warnings.push(`${source.name}: ${error.message}`);
          }
        }
        if (sources.marketplaces.length && !loaded)
          throw new Error(warnings.join('\n').slice(0, 1200));
        result = { stdout: JSON.stringify(data), stderr: warnings.join('\n') };
      } else result = await run(provider, ['list', '--json'], signal);
      let data;
      try {
        data = JSON.parse(result.stdout);
      } catch {
        throw new Error('The CLI returned invalid plugin JSON. Update it and retry.');
      }
      const plugins = await enrichPluginCatalog(
        provider,
        data,
        normalizePlugins(provider, data),
        signal,
      );
      catalogs.set(provider, plugins);
      let receipts,
        receiptWarning = '';
      try {
        receipts = await installations.read();
      } catch (error) {
        receiptWarning = error.message;
      }
      const resultCatalog = {
        plugins: plugins.map((plugin) => ({
          ...plugin,
          origin: !receipts
            ? 'unknown'
            : receipts.some(
                  (row) =>
                    row.provider === provider && row.id === plugin.id && row.scope === plugin.scope,
                )
              ? 'openpe'
              : 'agent',
        })),
        ...support,
        warning: text([result.stderr.trim(), receiptWarning].filter(Boolean).join('\n'), 1200),
        updatedAt: now(),
      };
      cache.set(provider, resultCatalog);
      return resultCatalog;
    },
    async change(provider, action, id, signal) {
      if (!providers.includes(provider) || !actions.includes(action) || !validPluginId(id))
        throw new Error('Invalid plugin action. Use a plugin@marketplace ID.');
      const switching = action === 'enable' || action === 'disable';
      await service.list(provider, signal, true);
      const support = capabilities.get(provider) || (await detect(provider, signal));
      if (!support.actions.includes(action))
        throw new Error('This CLI does not support that plugin action. Update it and retry.');
      const matches = (catalogs.get(provider) || []).filter((row) => row.id === id);
      if (matches.some((row) => row.managed))
        throw new Error('Manage this plugin in its provider or organization settings.');
      if (action !== 'install' && !matches.some((row) => row.installed))
        throw new Error('Refresh the installed plugin list before changing this plugin.');
      const command =
        provider === 'codex' ? { install: 'add', uninstall: 'remove' }[action] || action : action;
      const args = [command, id, ...(provider === 'claude' ? ['--scope', 'user'] : ['--json'])];
      // A subsequent list is required even if a mutation fails or is cancelled midway.
      catalogs.delete(provider);
      cache.delete(provider);
      const execute = async () => {
        if (signal.aborted)
          throw new Error('Plugin operation cancelled. Refresh to check its state.');
        if (provider === 'codex' && switching) await toggle(id, action === 'enable', signal);
        else await run(provider, args, signal);
      };
      if (action === 'install' || action === 'uninstall')
        await installations.change(provider, id, action === 'install', execute);
      else await execute();
      if (switching) {
        const checked = await service.list(provider, signal, true);
        const plugin = checked.plugins.find((row) => row.id === id && row.scope === 'user');
        if (plugin?.enabled !== (action === 'enable'))
          throw new Error(
            'The Agent did not confirm the requested plugin state. Refresh or check provider policy.',
          );
      }
      return { ok: true };
    },
  };
  return service;
}

export function registerPlugins(app, cwd, options = {}) {
  const service = options.service || createPluginService(cwd);
  const active = new Map();
  let closed = false;
  const handle = async (req, res, mutation) => {
    const provider = mutation ? req.body?.provider : req.query.provider;
    if (!providers.includes(provider)) return res.status(400).json({ error: 'Unknown agent.' });
    if (
      !mutation &&
      (Object.keys(req.query).some((key) => !['provider', 'refresh'].includes(key)) ||
        (req.query.refresh !== undefined && req.query.refresh !== 'true'))
    )
      return res.status(400).json({ error: 'Select an agent and an optional refresh.' });
    if (
      mutation &&
      (!req.body ||
        Object.keys(req.body).some((key) => !['provider', 'action', 'id'].includes(key)) ||
        !actions.includes(req.body.action) ||
        !validPluginId(req.body.id))
    )
      return res.status(400).json({ error: 'Invalid plugin action. Use a plugin@marketplace ID.' });
    if (closed) return res.status(503).json({ error: 'The local service is shutting down.' });
    if (active.has(provider))
      return res
        .status(409)
        .json({ error: 'A plugin operation is already running for this agent.' });
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 60000);
    active.set(provider, control);
    res.on('close', () => control.abort());
    try {
      const result = mutation
        ? await service.change(provider, req.body.action, req.body.id, control.signal)
        : await service.list(provider, control.signal, req.query.refresh === 'true');
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(502).json({ error: error.message });
    } finally {
      clearTimeout(timer);
      active.delete(provider);
    }
  };
  app.get('/api/plugins', (req, res) => handle(req, res, false));
  app.post('/api/plugins', (req, res) => handle(req, res, true));
  return {
    close() {
      closed = true;
      for (const control of active.values()) control.abort();
    },
  };
}
