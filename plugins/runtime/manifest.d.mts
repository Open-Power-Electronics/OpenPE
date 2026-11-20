import type { PluginManifest } from '../../api/plugins';
export function validatePluginManifest(value: unknown, options?: { builtin?: boolean }): PluginManifest;
export function createPluginCatalog(values: unknown[]): readonly PluginManifest[];
