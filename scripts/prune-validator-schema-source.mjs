import { createRequire } from 'node:module';

// CommonJS loading skips ESM named-export lexing of the multi-megabyte compiler bundle.
const ts = createRequire(import.meta.url)('typescript');

/** Standalone Ajv validators retain schema literals for enum error parameters
 * and property membership. Keep their observed values/keys without embedding
 * unrelated schema branches. This runs only during static generation. */
export function pruneValidatorSchemaSource(source) {
  const parsed = ts.createSourceFile(
    'validator.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (parsed.parseDiagnostics.length)
    throw new Error('Generated schema validator has syntax errors.');
  const definitions = new Map();
  const membership = new Set();
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      if (/^schema\d+$/.test(name)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const))
          throw new Error('Generated schema literals must be constant.');
        definitions.set(name, {
          node: declaration.initializer,
          value: JSON.parse(declaration.initializer.getText(parsed)),
          paths: { children: new Map(), value: false, keys: false },
        });
      }
      if (
        statement.declarationList.flags & ts.NodeFlags.Const &&
        declaration.initializer.getText(parsed) === 'Object.prototype.hasOwnProperty'
      )
        membership.add(name);
    }
  }
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      definitions.has(node.text) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      let expression = node;
      let retained = definitions.get(node.text).paths;
      while (
        ts.isPropertyAccessExpression(expression.parent) &&
        expression.parent.expression === expression
      ) {
        expression = expression.parent;
        const key = expression.name.text;
        if (!retained.children.has(key))
          retained.children.set(key, { children: new Map(), value: false, keys: false });
        retained = retained.children.get(key);
      }
      const parent = expression.parent;
      const keys =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'properties' &&
        ts.isCallExpression(parent) &&
        parent.arguments.length === 2 &&
        parent.arguments[0] === expression &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === 'call' &&
        ts.isIdentifier(parent.expression.expression) &&
        membership.has(parent.expression.expression.text);
      const allowedValues =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'enum' &&
        parent.initializer === expression &&
        ((ts.isPropertyAssignment(parent) && parent.name.getText(parsed) === 'allowedValues') ||
          (ts.isVariableDeclaration(parent) &&
            ts.isIdentifier(parent.name) &&
            /^vSchema\d+$/.test(parent.name.text) &&
            parent.parent.flags & ts.NodeFlags.Const));
      if (!keys && !allowedValues)
        throw new Error(
          `Unfamiliar generated schema access requires review: ${expression.getText(parsed)}.`,
        );
      retained[keys ? 'keys' : 'value'] = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  const prune = (value, retained) => {
    if (retained.value) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Unfamiliar generated schema access requires review.');
    const result = Object.create(null);
    if (retained.keys) for (const key of Object.keys(value)) result[key] = null;
    for (const [key, child] of retained.children) {
      if (!Object.hasOwn(value, key))
        throw new Error('Unfamiliar generated schema property requires review.');
      result[key] = prune(value[key], child);
    }
    return result;
  };
  const edits = [...definitions.values()].map(({ node, value, paths }) => ({
    start: node.getStart(parsed),
    end: node.getEnd(),
    text: JSON.stringify(prune(value, paths)),
  }));
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
