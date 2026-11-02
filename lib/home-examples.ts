import manifest from '../resources/example-catalog/home-manifest.json';

// Metadata only: complete projects remain lazy-loaded on preview/open.
export const homeExamples = manifest.examples;
export const homeRecent = manifest.recent;
export const homeExampleSections = [
  { id: 'recent-heading', title: 'Recent', examples: homeRecent },
  { id: 'example-heading', title: 'Example', examples: homeExamples },
];
export const homeExampleCatalog = [...homeRecent, ...homeExamples];
export type HomeExampleId = (typeof homeExampleCatalog)[number]['id'];

// Catalog directories are independent of the retained native project stems.
export function homeExampleNativePath(id: HomeExampleId) {
  const entry = homeExampleCatalog.find((entry) => entry.id === id);
  if (!entry) throw new Error('Unknown example project.');
  return `${entry.root}/${entry.directory}/${entry.file}.kicad_pro`;
}
