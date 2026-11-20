import { tsImport } from 'tsx/esm/api';

const { exampleProject } = await tsImport('../lib/project-example.ts', import.meta.url);
const { serializeProject } = await tsImport('../lib/project.ts', import.meta.url);

/** Small programmatic format fixture, with no independent example files. */
export function formatTestProjectSource() {
  return serializeProject(exampleProject());
}
