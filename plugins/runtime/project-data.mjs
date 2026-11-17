import { bundledPlugins, SPICE_PLUGIN_ID } from '../catalog.mjs';

/** Stable, application-owned directory names; callers never supply filesystem paths. */
export function pluginProjectDirectory(id) {
  const builtin = bundledPlugins.find((plugin) => plugin.id === id);
  if (builtin) {
    if (typeof builtin.projectDirectory !== 'string')
      throw new Error('Invalid built-in plugin project directory.');
    return builtin.projectDirectory;
  }
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}@[a-z][a-z0-9-]{0,63}$/.test(id))
    throw new Error('Invalid plugin identity for project data.');
  return id;
}

export const spiceProjectDirectory = pluginProjectDirectory(SPICE_PLUGIN_ID);
const directories = new Set(bundledPlugins.map((plugin) => plugin.projectDirectory));

/** Plugin-owned artifacts stay outside native project files. Shared models are project assets. */
export function isPluginProjectData(name) {
  return isPluginProjectDirectory(name.split('/')[0]);
}

export function isPluginProjectDirectory(name) {
  const root = name.toLowerCase();
  return directories.has(root) || /^[a-z][a-z0-9-]{0,63}@[a-z][a-z0-9-]{0,63}$/.test(root);
}
