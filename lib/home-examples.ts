import manifest from '../resources/example-catalog/home-manifest.json';

// Metadata only: complete projects remain lazy-loaded on preview/open.
export const homeExamples = manifest.examples;
export const homeRecent = manifest.recent;
export const homeExampleCatalog = [...homeRecent, ...homeExamples];
export type HomeExampleId = (typeof homeExampleCatalog)[number]['id'];

// Catalog directories are independent of the retained native project stems.
export function homeExampleNativePath(id: HomeExampleId) {
  const entry = homeExampleCatalog.find((entry) => entry.id === id);
  if (!entry) throw new Error('Unknown example project.');
  const sourceRoot = manifest.sourceRoots[entry.root as keyof typeof manifest.sourceRoots];
  if (!sourceRoot) throw new Error('Unknown example source root.');
  return `${sourceRoot}/${entry.directory}/${entry.file}.kicad_pro`;
}
