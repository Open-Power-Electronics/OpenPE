import { createReferenceExample } from './reference-examples';
import { copyExampleSource } from './example-copy';
import emcSource from './emc-flyback-example.json';
import type { HomeExampleId } from './home-examples';

export function createHomeExample(id: HomeExampleId, mapIdentifier?: (sourceId: string) => string) {
  return id === 'emc-flyback-demo'
    ? copyExampleSource(JSON.stringify(emcSource), mapIdentifier)
    : createReferenceExample(id, mapIdentifier);
}
