import manifest from '../tests/fixtures/kicad/manifest.json';
import { homeExampleCatalog } from './home-examples';
import retiredExamples from './retired-example-identities.json';
import { tiDcdcParts } from './ti-dcdc';

const exampleKeys = new Set(homeExampleCatalog.map((entry) => `example:${entry.id}`));

export function validExampleKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (exampleKeys.has(value) || /^example:local-[a-f0-9]{64}$/.test(value))
  );
}

// Fixed application-owned folder identities, used only to discard unused templates.
export function retiredExampleFolderNames(): string[] {
  const current = new Set(homeExampleCatalog.map((entry) => entry.title));
  return [
    ...new Set([
      ...retiredExamples.map((entry) => entry.title),
      ...manifest.examples.map((entry) => entry.title),
      ...tiDcdcParts.map((entry) => `${entry.name} Buck converter`),
    ]),
  ].filter((name) => !current.has(name));
}
