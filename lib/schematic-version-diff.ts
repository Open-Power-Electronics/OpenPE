import { serializeCircuit, type Circuit } from './circuit';
import { child, parseSExpr, val } from './sexpr';

export type SchematicChange = 'added' | 'removed' | 'changed';

// Materialize live values/positions before comparing native objects. Raw instance
// records can still contain the position/value from before an editor transaction.
function objects(circuit?: Circuit) {
  const result = new Map<string, string>();
  if (!circuit) return result;
  const root = parseSExpr(serializeCircuit(circuit));
  const parts = new Map(circuit.parts.map((part) => [part.id, part]));
  const libraries = new Map(
    Object.entries(circuit.libraries).map(([id, symbol]) => [id, JSON.stringify(symbol)]),
  );
  for (const node of root) {
    if (!Array.isArray(node)) continue;
    if (
      !['symbol', 'wire', 'junction', 'label', 'global_label', 'no_connect', 'text'].includes(
        String(node[0]),
      )
    )
      continue;
    const id = val(child(node, 'uuid'));
    const part = node[0] === 'symbol' ? parts.get(id) : undefined;
    // An embedded library edit changes every instance that renders that library.
    result.set(id, JSON.stringify([node, part ? libraries.get(part.libId) : null]));
  }
  return result;
}

export function compareSchematicVersions(before?: Circuit, after?: Circuit) {
  const left = objects(before),
    right = objects(after);
  const changes = new Map<string, SchematicChange>();
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    if (!left.has(id)) changes.set(id, 'added');
    else if (!right.has(id)) changes.set(id, 'removed');
    else if (left.get(id) !== right.get(id)) changes.set(id, 'changed');
  }
  return changes;
}
