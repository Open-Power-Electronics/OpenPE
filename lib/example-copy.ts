import { parseProject, type Project } from './project';
import { uid } from './circuit';

/** Fresh project identities, including embedded native UUID/path records. */
export function copyExampleSource(
  source: string,
  mapIdentifier: (sourceId: string) => string = () => uid(),
): Project {
  const document = JSON.parse(source);
  const identifiers = new Map<string, string>();
  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (value[0] === 'uuid' && typeof value[1] === 'string') {
        const original = value[1].startsWith('"') ? JSON.parse(value[1]) : value[1];
        if (!identifiers.has(original)) identifiers.set(original, mapIdentifier(original));
      }
      value.forEach(collect);
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'extensions') {
          collect((item as Record<string, unknown>)?.['org.openpe.model-cad']);
          continue;
        }
        if (key === 'simulationModels') continue;
        if (key === 'id' && typeof item === 'string' && !identifiers.has(item))
          identifiers.set(item, mapIdentifier(item));
        else collect(item);
      }
    }
  }
  function replace(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (value[0] === 'uuid' && typeof value[1] === 'string') {
        const quoted = value[1].startsWith('"');
        const original = quoted ? JSON.parse(value[1]) : value[1];
        if (identifiers.has(original))
          value[1] = quoted ? JSON.stringify(identifiers.get(original)) : identifiers.get(original);
      } else if (value[0] === 'path' && typeof value[1] === 'string') {
        const original = value[1].startsWith('"') ? JSON.parse(value[1]) : value[1];
        value[1] = JSON.stringify(
          original
            .split('/')
            .map((part: string) => identifiers.get(part) ?? part)
            .join('/'),
        );
      }
      value.forEach(replace);
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'extensions') {
          replace((item as Record<string, unknown>)?.['org.openpe.model-cad']);
          continue;
        }
        if (key === 'simulationModels') continue;
        if (
          ['id', 'symbolId', 'netId'].includes(key) &&
          typeof item === 'string' &&
          identifiers.has(item)
        )
          (value as Record<string, unknown>)[key] = identifiers.get(item);
        else replace(item);
      }
    }
  }
  collect(document);
  replace(document);
  // Native backing text shares these same identifiers. Rebind UUID tokens so
  // subsequent geometry edits can still match and retain native metadata.
  for (const file of document.nativeFiles?.files ?? [])
    file.source = file.source.replace(
      /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,
      (id: string) => identifiers.get(id) ?? id,
    );
  return parseProject(JSON.stringify(document));
}
