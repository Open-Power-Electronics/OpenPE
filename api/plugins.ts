import type { CapabilitySchema } from './capabilities';

/** Versioned data contract shared by package validation, discovery and execution. */
export type PluginCommand = {
  id: string;
  name: string;
  description: string;
  inputSchema: CapabilitySchema;
  handler: string;
};
export type PluginManifest = {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  detail?: string;
  author: string;
  category?: string;
  capabilities?: string[];
  runtime: 'builtin' | 'javascript';
  /** Built-in package directory; installed local packages use their qualified ID. */
  projectDirectory?: string;
  permissions: 'project.read'[];
  entry?: 'main.js';
  contributes: { capabilities?: string[]; commands?: PluginCommand[] };
};
