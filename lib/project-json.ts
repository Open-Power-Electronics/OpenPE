import { isOwnedProjectNode } from './immutable-project';
import type { KiCadProjectFile } from './kicad-project';

// Keep a few indentation variants of internally owned geometry/text packets.
// Caller-frozen data never enters this cache.
const ownedNodeJson = new WeakMap<object, Map<number, string>>();
// Only native assembly registers exact owned final file packets after its
// complete bundle checks. The one-shot closure retains merged syntax, not a PCB
// or another whole escaped string beside the ordinary file-format cache.
const ownedNativeSourceJson = new WeakMap<KiCadProjectFile, () => string>();
export function rememberNativeSourceJson(file: KiCadProjectFile, encode: () => string): void {
  if (isOwnedProjectNode(file)) ownedNativeSourceJson.set(file, encode);
}
function takeNativeSourceJson(file: object): string | undefined {
  const encode = ownedNativeSourceJson.get(file as KiCadProjectFile);
  if (!encode) return;
  // A failed optional encoder leaves the normal formatter retryable too.
  ownedNativeSourceJson.delete(file as KiCadProjectFile);
  return encode();
}

// Keep design objects easy to edit while avoiding one line per KiCad atom.
// Input has already passed project validation; JSON encoding preserves all values.
// Stop measuring a compact array as soon as it cannot fit. Large copper contours
// must not be serialized in full just to decide to serialize them again multiline.
function compactJson(value: unknown, budget: number): string | undefined {
  if (budget < 1) return undefined;
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    return text !== undefined && text.length <= budget ? text : undefined;
  }
  const array = Array.isArray(value);
  if (array && value.length * 2 + 1 > budget) return undefined;
  const entries = array ? value : Object.entries(value).filter(([, item]) => item !== undefined);
  let text = array ? '[' : '{';
  for (let index = 0; index < entries.length; index++) {
    if (index) text += ',';
    const entry = entries[index];
    if (!array) text += JSON.stringify(entry[0]) + ':';
    const item = compactJson(array ? entry : entry[1], budget - text.length - 1);
    if (item === undefined) return undefined;
    text += item;
  }
  return text.length + 1 <= budget ? text + (array ? ']' : '}') : undefined;
}

export function formatProjectJson(document: unknown): string {
  const format = (value: unknown, depth: number): string => {
    const object = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    const reusable =
      !!value &&
      typeof value === 'object' &&
      isOwnedProjectNode(value) &&
      (Array.isArray(value)
        ? value.length >= 8
        : Object.keys(value).length > 2 ||
          (object &&
            Object.values(object).some((item) => typeof item === 'string' && item.length >= 1024)));
    const cached = reusable ? ownedNodeJson.get(value)?.get(depth) : undefined;
    if (cached !== undefined) {
      ownedNativeSourceJson.delete(value as KiCadProjectFile);
      return cached;
    }
    const text = formatValue(value, depth);
    if (reusable) {
      const entries = ownedNodeJson.get(value) ?? new Map<number, string>();
      entries.set(depth, text);
      while (entries.size > 3) entries.delete(entries.keys().next().value!);
      ownedNodeJson.set(value, entries);
    }
    return text;
  };
  const formatValue = (value: unknown, depth: number): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    const indent = '  '.repeat(depth);
    const next = indent + '  ';
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      const compact = compactJson(value, 100 - indent.length);
      if (compact !== undefined) return compact;
      // Copper contours remain lossless, but one coordinate per deeply nested
      // line repeats more indentation than data. Pack adjacent points into
      // bounded rows while keeping every point a separate editable JSON object.
      if (
        value.every(
          (item) =>
            item &&
            !Array.isArray(item) &&
            Object.keys(item).length === 2 &&
            typeof item.x === 'number' &&
            typeof item.y === 'number',
        )
      ) {
        const rows: string[] = [];
        let row = '';
        for (const item of value) {
          const point = format(item, depth + 1);
          if (row && next.length + row.length + 2 + point.length + 1 > 100) {
            rows.push(row);
            row = '';
          }
          row += (row ? ', ' : '') + point;
        }
        if (row) rows.push(row);
        return '[\n' + rows.map((line) => next + line).join(',\n') + '\n' + indent + ']';
      }
      return (
        '[\n' +
        value.map((item) => next + format(item, depth + 1)).join(',\n') +
        '\n' +
        indent +
        ']'
      );
    }
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    const sourceJson = entries.some(([key]) => key === 'source')
      ? takeNativeSourceJson(value)
      : undefined;
    if (!entries.length) return '{}';
    if (
      entries.length === 2 &&
      entries.every(([key, item]) => ['x', 'y'].includes(key) && typeof item === 'number')
    )
      return (
        '{ ' +
        entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(', ') +
        ' }'
      );
    return (
      '{\n' +
      entries
        .map(
          ([key, item]) =>
            next +
            JSON.stringify(key) +
            ': ' +
            (key === 'source' && sourceJson !== undefined ? sourceJson : format(item, depth + 1)),
        )
        .join(',\n') +
      '\n' +
      indent +
      '}'
    );
  };
  return format(document, 0) + '\n';
}
