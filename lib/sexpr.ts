import { isOwnedProjectNode, recordOwnedProjectNode } from './immutable-project-ownership.mjs';

export type SExpr = (string | SExpr)[];
// Quoted atoms retain their quotes so unknown fields can be written without loss.
const atom = (v: string | SExpr | undefined): string =>
  typeof v === 'string' ? (v.startsWith('"') ? JSON.parse(v) : v) : '';
export const quote = (v: string) => JSON.stringify(v);
export const children = (n: SExpr, name: string): SExpr[] =>
  n.filter((x): x is SExpr => Array.isArray(x) && x[0] === name);
export const child = (n: SExpr, name: string): SExpr | undefined =>
  n.find((value): value is SExpr => Array.isArray(value) && value[0] === name);
export const val = (n: SExpr | undefined, i = 1) => (n ? atom(n[i]) : '');
export const num = (n: SExpr | undefined, i = 1) => Number(val(n, i) || 0);
export function parseSExpr(source: string, maxLength = 8_000_000): SExpr {
  return parseSExprValue(source, maxLength, false);
}
/** Private derived syntax: every array is freshly allocated from primitive text.
 * Certify only those arrays while constructing them, without copying them a
 * second time. This establishes immutability, never semantic acceptance. */
export function parseOwnedSExpr(source: string, maxLength = 8_000_000): SExpr {
  if (typeof source !== 'string') throw new Error('Expected primitive S-expression text.');
  return parseSExprValue(source, maxLength, true);
}
function parseSExprValue(source: string, maxLength: number, owned: boolean): SExpr {
  if (source.length > maxLength)
    throw new Error('Files over 8 MB are not supported in this preview.');
  const tokens = source.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) || [];
  let i = 0,
    nodes = 0;
  const bounded = (depth: number) => {
    if (depth > 80 || ++nodes > 300000)
      throw new Error(
        'Invalid OpenPE project: document nesting or object count exceeds the supported limit.',
      );
  };
  function read(depth: number): SExpr {
    if (owned) bounded(depth);
    if (depth > 100 || tokens[i++] !== '(') throw new Error('Invalid S-expression structure.');
    const list: SExpr = [];
    while (i < tokens.length && tokens[i] !== ')') {
      if (tokens[i] === '(') list.push(read(depth + 1));
      else {
        if (owned) bounded(depth + 1);
        const t = tokens[i++];
        if (t.startsWith('"')) {
          try {
            JSON.parse(t);
          } catch {
            throw new Error('Invalid string.');
          }
        }
        list.push(t);
      }
    }
    if (tokens[i++] !== ')') throw new Error('Unbalanced schematic parentheses.');
    if (owned) {
      Object.freeze(list);
      recordOwnedProjectNode(list);
    }
    return list;
  }
  const root = read(0);
  if (i !== tokens.length) throw new Error('Unexpected trailing file content.');
  return root;
}
const ownedSExprText = new WeakMap<SExpr, Map<number, string>>();
export function writeSExpr(n: SExpr, depth = 0): string {
  if (!n.some(Array.isArray)) return `(${n.join(' ')})`;
  const owned = isOwnedProjectNode(n);
  const cached = owned ? ownedSExprText.get(n)?.get(depth) : undefined;
  if (cached !== undefined) return cached;
  let s = '(';
  n.forEach((v, i) => {
    s += Array.isArray(v)
      ? `\n${'  '.repeat(depth + 1)}${writeSExpr(v, depth + 1)}`
      : `${i ? ' ' : ''}${v}`;
  });
  const source = s + ')';
  if (owned) {
    const variants = ownedSExprText.get(n) ?? new Map<number, string>();
    variants.set(depth, source);
    while (variants.size > 3) variants.delete(variants.keys().next().value!);
    ownedSExprText.set(n, variants);
  }
  return source;
}

const ownedSExprJsonPayload = new WeakMap<SExpr, Map<number, string>>();
const jsonTextPayload = (source: string) => JSON.stringify(source).slice(1, -1);

/** Private native assembly can encode the same merged syntax without scanning
 * every unchanged subtree again. Complete nodes end in ASCII parentheses, so
 * JSON string concatenation cannot split a Unicode surrogate pair. */
export function writeSExprJsonPayload(node: SExpr, depth = 0): string {
  if (isOwnedProjectNode(node)) {
    const cached = ownedSExprJsonPayload.get(node)?.get(depth);
    if (cached !== undefined) return cached;
    const payload = jsonTextPayload(writeSExpr(node, depth));
    const variants = ownedSExprJsonPayload.get(node) ?? new Map<number, string>();
    variants.set(depth, payload);
    while (variants.size > 3) variants.delete(variants.keys().next().value!);
    ownedSExprJsonPayload.set(node, variants);
    return payload;
  }
  if (!node.some(Array.isArray)) return jsonTextPayload(writeSExpr(node, depth));
  let payload = '(';
  const prefix = jsonTextPayload('\n' + '  '.repeat(depth + 1));
  node.forEach((value, index) => {
    payload += Array.isArray(value)
      ? prefix + writeSExprJsonPayload(value, depth + 1)
      : jsonTextPayload((index ? ' ' : '') + value);
  });
  return payload + ')';
}

/** Clean imports keep their original bytes. Warm only reusable child chunks,
 * never retain or associate a normalized whole-root JSON string with them. */
export function primeSExprJsonChildren(node: SExpr, depth = 0): void {
  for (const value of node)
    if (Array.isArray(value)) {
      if (isOwnedProjectNode(value)) writeSExprJsonPayload(value, depth + 1);
      else primeSExprJsonChildren(value, depth + 1);
    }
}
