import { homeExampleCatalog } from './home-examples';

const exampleKeys = new Set(homeExampleCatalog.map((entry) => `example:${entry.id}`));

export function validExampleKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (exampleKeys.has(value) || /^example:local-[a-f0-9]{64}$/.test(value))
  );
}
