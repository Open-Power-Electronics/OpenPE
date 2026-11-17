import { referenceExamples, type ReferenceExampleId } from './reference-catalog';
import sources from './reference-examples.json';
import { copyExampleSource } from './example-copy';

export { referenceExamples, type ReferenceExampleId } from './reference-catalog';

/** Independent editable copies with source attribution retained. */
export function createReferenceExample(
  id: ReferenceExampleId,
  mapIdentifier?: (sourceId: string) => string,
) {
  const source = (sources as Record<string, string>)[id];
  if (!referenceExamples.some((entry) => entry.id === id) || typeof source !== 'string')
    throw new Error('Unknown example project.');
  return copyExampleSource(source, mapIdentifier);
}
