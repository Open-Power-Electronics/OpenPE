import path from 'node:path';
import { createRequire } from 'node:module';
import { ExampleProjects } from '../server/example-projects.mjs';
import homeManifest from '../resources/example-catalog/home-manifest.json' with { type: 'json' };

const { FileGrants } = createRequire(import.meta.url)('../electron/file-grants.cjs');

// Read-only fixtures from the same original directories as the desktop.
export async function readOriginalExamples() {
  const grants = new FileGrants();
  const projects = new ExampleProjects(path.resolve('examples'), grants, {
    ensureExampleInitial: async () => {},
  });
  const entries = [];
  for (const item of [...homeManifest.recent, ...homeManifest.examples]) {
    const key = `example:${item.id}`;
    const opened = await projects.openDefault(key);
    grants.release(opened.fileId);
    entries.push({ key, name: item.title, ...opened });
  }
  return entries;
}
