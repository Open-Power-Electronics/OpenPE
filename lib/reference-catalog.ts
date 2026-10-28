import manifest from '../resources/example-catalog/manifest.json';

// Home needs names and descriptions before it needs the full project snapshots.
export type ReferenceExampleId = (typeof manifest.examples)[number]['id'];
export const referenceExamples = manifest.examples;
