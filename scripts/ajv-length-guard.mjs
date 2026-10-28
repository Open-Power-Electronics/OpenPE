import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _, Name } = require('ajv/dist/compile/codegen/index.js');
const { useFunc } = require('ajv/dist/compile/util.js');
const installedLength = require('ajv/dist/vocabularies/validation/limitLength.js').default;
const ucs2length = require('ajv/dist/runtime/ucs2length.js').default;

/** Preserve Ajv's Unicode length and errors while avoiding a code-point scan
 * when the UTF-16 length already proves a static maximum. Generation only.
 * @param {import('ajv').default} ajv
 */
export function optimizeStaticMaxLength(ajv) {
  const maximum = ajv.getKeyword('maxLength');
  const minimum = ajv.getKeyword('minLength');
  if (
    !maximum ||
    !minimum ||
    maximum.code !== installedLength.code ||
    minimum.code !== installedLength.code ||
    maximum.error !== installedLength.error ||
    maximum.$data !== true
  )
    throw new Error('Installed Ajv length definitions require review before generation.');
  const originalCode = maximum.code;
  // Ajv copies each rule definition per instance. Keep both in their existing
  // positions, preserving maxLength/minLength/pattern error priority.
  maximum.code = (cxt, ruleType) => {
    if (
      cxt.keyword !== 'maxLength' ||
      cxt.$data ||
      typeof cxt.schema !== 'number' ||
      cxt.it.opts.unicode === false
    )
      return originalCode(cxt, ruleType);
    const { gen, data, schemaCode } = cxt;
    // A raw property/call expression may observe a getter. Sample it once;
    // stable identifiers already refer to the original sampled string.
    const value = data instanceof Name ? data : gen.const('maxLengthData', data);
    cxt.fail$data(
      _`${value}.length > ${schemaCode} && ${useFunc(gen, ucs2length)}(${value}) > ${schemaCode}`,
    );
  };
  return ajv;
}
