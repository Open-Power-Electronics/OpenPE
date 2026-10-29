import { child, children, num, val, quote, parseSExpr, type SExpr } from './sexpr';
import { type Circuit, type Part, snap, uid } from './circuit';
import { isOwnedProjectNode } from './immutable-project';
import {
  defaultSimulationParticipation,
  participatesInSimulation,
} from './simulation-participation';
export { child, children, num, val, quote, parseSExpr, writeSExpr } from './sexpr';
export { createProject, validateProject } from './project';

export type LibraryEntry = {
  id: string;
  name: string;
  library: string;
  description: string;
  keywords: string;
  footprint?: string;
};
export type SymbolDetail = LibraryEntry & { symbol: SExpr; units: number; error?: string };

/** Rank the complete catalog before pagination; never change the stored catalog order. */
export function searchLibrary(entries: LibraryEntry[], query: string, library = '') {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ');
  // Opening an unfiltered chooser needs only alphabetical order, not token sets
  // and relevance scores for every entry in the bundled catalog.
  if (!phrase)
    return entries
      .filter((entry) => !library || entry.library === library)
      .sort((a, b) => a.id.localeCompare(b.id));
  const terms = [...new Set(phrase.split(' ').filter(Boolean))];
  const words = (text: string) => new Set(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const matches = [];
  for (const entry of entries) {
    if (library && entry.library !== library) continue;
    const id = entry.id.toLowerCase();
    const name = entry.name.toLowerCase();
    const keywords = entry.keywords.toLowerCase();
    const description = entry.description.toLowerCase();
    const libraryName = entry.library.toLowerCase();
    const searchable = `${id} ${name} ${description} ${keywords}`;
    if (!terms.every((term) => searchable.includes(term))) continue;
    const nameWords = words(name),
      keywordWords = words(keywords),
      descriptionWords = words(description);
    // Whole identities outrank prefixes, then matches entirely in the part name.
    const rank =
      id === phrase || name === phrase
        ? 0
        : name.startsWith(phrase) || (phrase.includes(':') && id.startsWith(phrase))
          ? 1
          : terms.every((term) => name.includes(term))
            ? 2
            : 3;
    const score = terms.reduce(
      (sum, term) =>
        sum +
        (name === term
          ? 120
          : name.startsWith(term)
            ? 100
            : nameWords.has(term)
              ? 80
              : name.includes(term)
                ? 60
                : keywordWords.has(term)
                  ? 40
                  : keywords.includes(term)
                    ? 30
                    : libraryName.includes(term)
                      ? 20
                      : descriptionWords.has(term)
                        ? 10
                        : 5) +
        // Corroborating description text breaks keyword ties (e.g. resistor vs heater).
        (description === term
          ? 4
          : description.startsWith(term)
            ? 3
            : descriptionWords.has(term)
              ? 2
              : description.includes(term)
                ? 1
                : 0),
      0,
    );
    matches.push({ entry, rank, score });
  }
  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.score - a.score ||
      (a.rank < 3 ? a.entry.name.length - b.entry.name.length : 0) ||
      a.entry.id.localeCompare(b.entry.id),
  );
  return matches.map(({ entry }) => entry);
}

export const propertyValue = (node: SExpr, name: string) =>
  val(
    children(node, 'property').find((p) => val(p) === name),
    2,
  );
export function symbolUnits(library: SExpr) {
  return Math.max(
    1,
    ...children(library, 'symbol').map((s) => Number(val(s).match(/_(\d+)_\d+$/)?.[1] || 0)),
  );
}
const ownedUnitGraphics = new WeakMap<SExpr, Map<number, SExpr[]>>();
export function unitGraphics(library: SExpr, unit = 1): SExpr[] {
  const owned = isOwnedProjectNode(library);
  const variants = owned ? ownedUnitGraphics.get(library) : undefined;
  const cached = variants?.get(unit);
  if (cached) return [...cached];
  const graphics = children(library, 'symbol').filter((s) => {
    const match = val(s).match(/_(\d+)_(\d+)$/);
    return (
      !match || ((Number(match[1]) === 0 || Number(match[1]) === unit) && Number(match[2]) <= 1)
    );
  });
  if (owned) {
    const next = variants ?? new Map<number, SExpr[]>();
    next.set(unit, graphics);
    while (next.size > 3) next.delete(next.keys().next().value!);
    ownedUnitGraphics.set(library, next);
    return [...graphics];
  }
  return graphics;
}
export function resolveSymbol(
  symbols: SExpr[],
  name: string,
  libraryName: string,
  chain: string[] = [],
): SExpr {
  if (chain.includes(name) || chain.length > 32)
    throw new Error('Circular or excessive symbol inheritance.');
  const source = symbols.find((s) => val(s) === name);
  if (!source) throw new Error(`Missing inherited symbol: ${name}`);
  let result = structuredClone(source);
  const parent = val(child(source, 'extends'));
  if (parent) {
    const base = resolveSymbol(symbols, parent, libraryName, [...chain, name]);
    const fields = new Set(children(source, 'property').map((p) => val(p)));
    const overrides = new Set(
      source.filter((n): n is SExpr => Array.isArray(n) && n[0] !== 'property').map((n) => n[0]),
    );
    result = [
      'symbol',
      quote(name),
      ...base
        .slice(2)
        .filter(
          (n) =>
            Array.isArray(n) && (n[0] === 'property' ? !fields.has(val(n)) : !overrides.has(n[0])),
        ),
      ...source.slice(2).filter((n) => !Array.isArray(n) || n[0] !== 'extends'),
    ];
  }
  result[1] = quote(`${libraryName}:${name}`);
  for (const unit of children(result, 'symbol')) {
    const suffix = val(unit).match(/_\d+_\d+$/)?.[0];
    if (!suffix) throw new Error('Unrecognized symbol unit name.');
    unit[1] = quote(name + suffix);
  }
  return result;
}
export function createLibraryPart(
  d: Circuit,
  library: SExpr,
  x: number,
  y: number,
  unit = 1,
): Part {
  const libId = val(library);
  const prefix = propertyValue(library, 'Reference') || 'U';
  let i = 1;
  const shared = d.parts.find(
    (p) => p.libId === libId && !d.parts.some((q) => q.ref === p.ref && (q.unit || 1) === unit),
  );
  while (d.parts.some((p) => p.ref === prefix + i)) i++;
  return {
    id: uid(),
    libId,
    ref: shared?.ref || prefix + i,
    value: shared?.value || propertyValue(library, 'Value') || libId.split(':').at(-1)!,
    x: snap(x),
    y: snap(y),
    rotation: 0,
    unit,
    excludeFromSimulation: shared
      ? !participatesInSimulation(shared)
      : !defaultSimulationParticipation(library),
    fields: shared?.fields
      ? structuredClone(shared.fields)
      : Object.fromEntries(
          children(library, 'property')
            .filter(
              (p) =>
                val(p, 2) !== '' &&
                !['Reference', 'Value', 'ki_keywords', 'ki_fp_filters'].includes(val(p)),
            )
            .map((p) => [val(p), val(p, 2)]),
        ),
  };
}
const ownedPartFields = new WeakMap<Pick<Part, 'raw' | 'fields'>, Record<string, string>>();
export function partFields(part: Pick<Part, 'raw' | 'fields'>): Record<string, string> {
  const owned = isOwnedProjectNode(part);
  const cached = owned ? ownedPartFields.get(part) : undefined;
  if (cached) return { ...cached };
  const fields = {
    ...Object.fromEntries(
      children(part.raw || [], 'property')
        .filter((p) => !['Reference', 'Value'].includes(val(p)))
        .map((p) => [val(p), val(p, 2)]),
    ),
    ...part.fields,
  };
  if (owned) {
    ownedPartFields.set(part, fields);
    return { ...fields };
  }
  return fields;
}
export function partFootprint(part: Pick<Part, 'raw' | 'fields'>): string {
  return (partFields(part).Footprint ?? '').trim();
}
export function singleSimulationParameter(params: string) {
  const match = /^(\s*[a-zA-Z][\w.]*\s*=\s*)([^\s=]+)(\s*)$/.exec(params);
  return match ? { prefix: match[1], value: match[2], suffix: match[3] } : null;
}

export function displayPartValue(part: Part) {
  // KiCad's simulation placeholder refers to the stored field, not a literal value.
  const fields = partFields(part);
  const params = fields['Sim.Params'];
  const value = params ? (singleSimulationParameter(params)?.value ?? params) : '';
  // Newly placed waveform sources retain the library's generic Value. Present
  // their stored parameters when no separate native parameter caption exists.
  if (
    params &&
    fields['Sim.Device'] === 'V' &&
    ['PULSE', 'SIN'].includes(fields['Sim.Type']) &&
    part.value === part.libId.split(':').at(-1) &&
    fields['OpenPE.ModelSource'] !== 'external' &&
    (fields['OpenPE.ModelSource'] === 'basic' || !fields['Sim.Library']?.trim()) &&
    !extraSymbolAnnotations(part).some((field) => field.name === 'Sim.Params')
  )
    return params;
  return value ? part.value.replaceAll('${SIM.PARAMS}', value) : part.value;
}

type ExtraSymbolAnnotation = {
  name: string;
  text: string;
  x: number;
  y: number;
  rotation: number;
  anchor: 'start' | 'end' | 'middle';
};
const ownedExtraAnnotations = new WeakMap<Part, ExtraSymbolAnnotation[]>();
export function extraSymbolAnnotations(part: Part): ExtraSymbolAnnotation[] {
  const owned = isOwnedProjectNode(part);
  const cached = owned ? ownedExtraAnnotations.get(part) : undefined;
  if (cached) return cached.map((field) => ({ ...field }));
  const original = child(part.raw || [], 'at');
  const annotations = children(part.raw || [], 'property').flatMap((field) => {
    const name = val(field),
      text = part.fields?.[name] ?? val(field, 2);
    const effects = child(field, 'effects') || [];
    const hidden = (node: SExpr) => node.includes('hide') || val(child(node, 'hide')) === 'yes';
    const at = child(field, 'at');
    if (['Reference', 'Value'].includes(name) || !text || !at || hidden(field) || hidden(effects))
      return [];
    const justify = child(effects, 'justify');
    return [
      {
        name,
        text,
        x: num(at) + part.x - num(original),
        y: num(at, 2) + part.y - num(original, 2),
        rotation: num(at, 3),
        anchor: justify?.includes('left')
          ? ('start' as const)
          : justify?.includes('right')
            ? ('end' as const)
            : ('middle' as const),
      },
    ];
  });
  if (owned) {
    ownedExtraAnnotations.set(part, annotations);
    return annotations.map((field) => ({ ...field }));
  }
  return annotations;
}

export function symbolAnnotation(
  part: Part,
  library: SExpr,
  field: 'Reference' | 'Value' | 'Sim.Params',
) {
  const property = children(part.raw || library, 'property').find((p) => val(p) === field);
  const at = property && child(property, 'at');
  if (!at) return null;
  if (part.raw) {
    const original = child(part.raw, 'at');
    const justify = child(child(property!, 'effects') || [], 'justify');
    return {
      x: num(at) + part.x - num(original),
      y: num(at, 2) + part.y - num(original, 2),
      anchor: justify?.includes('left')
        ? ('start' as const)
        : justify?.includes('right')
          ? ('end' as const)
          : ('middle' as const),
    };
  }
  const angle = (-part.rotation * Math.PI) / 180,
    x = num(at),
    y = -num(at, 2);
  // Library-editor field coordinates can lie inside a symbol (Device:R is one
  // example). Like schematic placement, arrange upright fields outside the body.
  // This affects instance annotations only; upstream library geometry is untouched.
  if (val(child(property!, 'do_not_autoplace')) !== 'yes') {
    const points: { x: number; y: number }[] = [];
    const add = (px: number, py: number) =>
      points.push({
        x: part.x + (part.mirror === 'y' ? -1 : 1) * (px * Math.cos(angle) + py * Math.sin(angle)),
        y: part.y + (part.mirror === 'x' ? -1 : 1) * (px * Math.sin(angle) - py * Math.cos(angle)),
      });
    for (const unit of unitGraphics(library, part.unit || 1)) {
      for (const primitive of unit.filter((n): n is SExpr => Array.isArray(n))) {
        if (primitive[0] === 'pin') {
          const pin = child(primitive, 'at');
          add(num(pin), num(pin, 2));
        } else if (primitive[0] === 'circle') {
          const c = child(primitive, 'center'),
            radius = num(child(primitive, 'radius'));
          for (const dx of [-radius, radius])
            for (const dy of [-radius, radius]) add(num(c) + dx, num(c, 2) + dy);
        } else {
          for (const name of ['start', 'mid', 'end']) {
            const point = child(primitive, name);
            if (point) add(num(point), num(point, 2));
          }
          for (const point of children(child(primitive, 'pts') || [], 'xy'))
            add(num(point), num(point, 2));
        }
      }
    }
    if (points.length) {
      const left = Math.min(...points.map((p) => p.x)),
        right = Math.max(...points.map((p) => p.x));
      const top = Math.min(...points.map((p) => p.y)),
        bottom = Math.max(...points.map((p) => p.y));
      if (child(library, 'power'))
        return { x: part.x, y: bottom + 2.54, anchor: 'middle' as const };
      if (right - left > (bottom - top) * 1.1)
        return {
          x: (left + right) / 2,
          y: top - (field === 'Reference' ? 4 : 1.4),
          anchor: 'middle' as const,
        };
      return {
        x: right + 1.27,
        y: (top + bottom) / 2 + (field === 'Reference' ? -1.2 : 1.4),
        anchor: 'start' as const,
      };
    }
  }
  return {
    x: part.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: part.y + x * Math.sin(angle) + y * Math.cos(angle),
    anchor: 'middle' as const,
  };
}
export function parseLibrary(source: string) {
  const root = parseSExpr(source, 64_000_000);
  if (root[0] !== 'kicad_symbol_lib' || num(child(root, 'version')) > 20251024)
    throw new Error('Unsupported symbol library version. Use KiCad 10 libraries.');
  return children(root, 'symbol');
}

export {
  exampleModelPath,
  modelReferenceKey,
  resolveExampleModelRelative,
  portableExampleModelSource,
} from './example-model-paths';
