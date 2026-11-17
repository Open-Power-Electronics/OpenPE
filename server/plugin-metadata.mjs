import path from 'node:path';
import { open, realpath } from 'node:fs/promises';

const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
async function boundedFile(root, name, limit) {
  const file = await realpath(path.resolve(root, name));
  if (!within(root, file)) throw new Error('Plugin metadata must stay inside its package.');
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Plugin metadata is too large.');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error('Plugin metadata is too large.');
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

// Read display metadata only from package roots reported by the CLI. Never load
// plugin instructions, MCP definitions, credentials or executable code here.
/** @returns {Promise<{displayName?: string, description?: string, detail?: string, category?: string, author?: string, capabilities?: string[], icon?: string}>} */
export async function readPluginMetadata(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return {};
  try {
    root = await realpath(root);
    let manifest;
    for (const name of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json']) {
      try {
        manifest = JSON.parse((await boundedFile(root, name, 128_000)).toString('utf8'));
        break;
      } catch {
        /* Optional display metadata must not hide a usable catalog entry. */
      }
    }
    if (!manifest || typeof manifest !== 'object') return {};
    const ui = manifest.interface || {};
    const result = {
      displayName: text(ui.displayName, 160),
      description: text(ui.shortDescription || manifest.description, 600),
      detail: text(ui.longDescription || manifest.description, 3000),
      category: text(ui.category, 80),
      author: text(ui.developerName || manifest.author?.name, 160),
      capabilities: Array.isArray(ui.capabilities)
        ? ui.capabilities
            .filter((x) => typeof x === 'string')
            .slice(0, 8)
            .map((x) => x.slice(0, 60))
        : [],
    };
    const icon = ui.logo || ui.composerIcon;
    if (typeof icon === 'string' && icon.startsWith('./') && icon.length < 300) {
      try {
        const extension = path.extname(icon).toLowerCase();
        const mime = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
        }[extension];
        if (mime) {
          const bytes = await boundedFile(root, icon, 32_000);
          const svg = bytes.toString('utf8');
          // SVG is displayed only as an img, with no external resources or active elements.
          if (
            extension !== '.svg' ||
            (/<svg\b/i.test(svg) &&
              !/<(?:script|foreignObject|image|animate|set)\b|<!ENTITY|<!DOCTYPE|(?:href\s*=\s*["'](?!#))|url\(\s*(?!#)/i.test(
                svg,
              ))
          )
            result.icon = `data:${mime};base64,${bytes.toString('base64')}`;
        }
      } catch {
        /* A missing or unsupported icon uses the page's monogram. */
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function enrichPluginCatalog(provider, data, plugins, signal) {
  const rows = Array.isArray(data) ? data : [...(data.available || []), ...(data.installed || [])];
  const roots = new Map(
    rows.map((row) => [
      row.pluginId ?? row.id,
      provider === 'codex' && row.source?.source === 'local'
        ? row.source.path
        : provider === 'claude'
          ? row.installPath
          : undefined,
    ]),
  );
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, plugins.length) }, async () => {
      while (index < plugins.length && !signal.aborted) {
        const plugin = plugins[index++];
        const metadata = await readPluginMetadata(roots.get(plugin.id));
        Object.assign(plugin, metadata, {
          name: metadata.displayName || plugin.name,
          description: metadata.description || plugin.description,
        });
        delete plugin.displayName;
      }
    }),
  );
  if (signal.aborted) throw new Error('Plugin loading cancelled.');
  return plugins;
}
