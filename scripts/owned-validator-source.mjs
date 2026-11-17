import { createRequire } from 'node:module';

// CommonJS loading skips ESM named-export lexing of the multi-megabyte compiler bundle.
const ts = createRequire(import.meta.url)('typescript');

/** Add success reuse to static Ajv functions without changing their schemas or
 * errors. Reject unfamiliar/context-sensitive output instead of guessing. */
export function ownedValidatorSource(source) {
  const parsed = ts.createSourceFile(
    'validator.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (parsed.parseDiagnostics.length)
    throw new Error('Generated schema validator has syntax errors.');
  const edits = [];
  let validators = 0;
  for (const node of parsed.statements) {
    if (!ts.isFunctionDeclaration(node) || !/^validate\d+$/.test(node.name?.text ?? '')) continue;
    const name = node.name.text;
    if (!node.body || node.parameters[0]?.name.getText(parsed) !== 'data')
      throw new Error(`Unsupported generated validator parameters: ${name}.`);
    const successfulReturns = [];
    const visit = (child) => {
      if (child !== node.body && ts.isFunctionLike(child))
        throw new Error(`Nested generated validator code requires review: ${name}.`);
      if (
        ts.isIdentifier(child) &&
        ['rootData', 'parentData', 'parentDataProperty'].includes(child.text) &&
        !ts.isShorthandPropertyAssignment(child.parent) &&
        !ts.isPropertyAssignment(child.parent)
      )
        throw new Error(`Context-sensitive generated validation requires review: ${name}.`);
      if (ts.isThis(child))
        throw new Error(`Context-sensitive generated validation requires review: ${name}.`);
      if (
        ts.isReturnStatement(child) &&
        child.expression &&
        ts.isBinaryExpression(child.expression) &&
        child.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        child.expression.left.getText(parsed) === 'errors' &&
        child.expression.right.getText(parsed) === '0'
      )
        successfulReturns.push(child.expression);
      ts.forEachChild(child, visit);
    };
    visit(node.body);
    if (successfulReturns.length !== 1)
      throw new Error(`Unsupported generated success return: ${name}.`);
    const expression = successfulReturns[0];
    edits.push({
      start: node.body.getStart(parsed) + 1,
      end: node.body.getStart(parsed) + 1,
      text: `if(__openpeWasValidatedOwned(${name},data)){${name}.errors=null;return true;}`,
    });
    edits.push({
      start: expression.getStart(parsed),
      end: expression.getEnd(),
      text: `__openpeRememberValidatedOwned(${name},data,errors===0)`,
    });
    validators++;
  }
  if (!validators) throw new Error('No generated schema validators were found.');
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return (
    'import {wasValidatedOwned as __openpeWasValidatedOwned,rememberValidatedOwned as __openpeRememberValidatedOwned} from "./owned-validation.mjs";\n' +
    source
  );
}
