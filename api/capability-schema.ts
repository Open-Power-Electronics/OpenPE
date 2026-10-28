/** An interpreted, bounded JSON Schema subset for the runtime capability catalog.
 * Project documents keep their generated validators. No eval/code generation is
 * used here, so registration works under the desktop renderer's strict CSP. */
export type CapabilityValidation = { valid: boolean; error: string };
type Check = (value: unknown, path: string, budget: { nodes: number; depth: number }) => string;
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'description',
  'title',
  'default',
  'examples',
]);
const types = new Set(['null', 'boolean', 'string', 'number', 'integer', 'array', 'object']);
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    plain(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );

export function compileCapabilitySchema(schema: unknown): (value: unknown) => CapabilityValidation {
  function compile(raw: unknown, depth = 0): Check {
    if (depth > 64) throw new Error('Capability schema nesting exceeds the supported depth.');
    if (raw === true) return () => '';
    if (raw === false) return (_value, path) => `${path} is not accepted`;
    if (!plain(raw)) throw new Error('Capability schemas must be JSON objects or booleans.');
    const s = raw as Record<string, any>;
    for (const key of Object.keys(s))
      if (!keywords.has(key)) throw new Error(`Unsupported capability schema keyword: ${key}.`);
    const accepted = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
    if (accepted.some((type: unknown) => typeof type !== 'string' || !types.has(type)))
      throw new Error('Invalid capability schema type.');
    for (const key of [
      'minItems',
      'maxItems',
      'minProperties',
      'maxProperties',
      'minLength',
      'maxLength',
    ]) {
      if (s[key] !== undefined && (!Number.isSafeInteger(s[key]) || s[key] < 0))
        throw new Error(`Invalid schema ${key}.`);
    }
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key])))
        throw new Error(`Invalid schema ${key}.`);
    }
    if (
      s.required !== undefined &&
      (!Array.isArray(s.required) || s.required.some((key: unknown) => typeof key !== 'string'))
    )
      throw new Error('Invalid schema required fields.');
    if (s.properties !== undefined && !plain(s.properties))
      throw new Error('Invalid schema properties.');
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length))
      throw new Error('Invalid schema enum.');
    if (s.uniqueItems !== undefined && typeof s.uniqueItems !== 'boolean')
      throw new Error('Invalid schema uniqueItems.');
    const properties = new Map<string, Check>(
      Object.entries(s.properties ?? {}).map(([key, value]) => [key, compile(value, depth + 1)]),
    );
    const additional =
      s.additionalProperties === undefined ? null : compile(s.additionalProperties, depth + 1);
    const items = s.items === undefined ? null : compile(s.items, depth + 1);
    const alternatives = (key: string): Check[] => {
      if (s[key] === undefined) return [];
      if (!Array.isArray(s[key]) || !s[key].length) throw new Error(`Invalid schema ${key}.`);
      return s[key].map((value: unknown) => compile(value, depth + 1));
    };
    const any = alternatives('anyOf'),
      one = alternatives('oneOf'),
      all = alternatives('allOf');
    const not = s.not === undefined ? null : compile(s.not, depth + 1);
    if (s.pattern !== undefined && (typeof s.pattern !== 'string' || s.pattern.length > 512))
      throw new Error('Invalid schema pattern.');
    const pattern = s.pattern === undefined ? null : new RegExp(s.pattern, 'u');
    const enumeration = s.enum?.map(canonical) as string[] | undefined;
    const constant = Object.hasOwn(s, 'const') ? canonical(s.const) : undefined;
    return (value, path, budget) => {
      if (++budget.nodes > 2000000 || ++budget.depth > 128)
        throw new Error('Capability input exceeds the supported complexity.');
      try {
        const error = (message: string) => `${path} ${message}`;
        const matches = (type: string) =>
          type === 'null'
            ? value === null
            : type === 'array'
              ? Array.isArray(value)
              : type === 'object'
                ? plain(value)
                : type === 'integer'
                  ? typeof value === 'number' && Number.isSafeInteger(value)
                  : type === 'number'
                    ? typeof value === 'number' && Number.isFinite(value)
                    : typeof value === type;
        if (accepted.length && !accepted.some(matches))
          return error(`must be ${accepted.join(' or ')}`);
        if (enumeration && !enumeration.includes(canonical(value)))
          return error('must match an allowed value');
        if (constant !== undefined && constant !== canonical(value))
          return error('must match its fixed value');
        if (all.length)
          for (const check of all) {
            const result = check(value, path, budget);
            if (result) return result;
          }
        if (any.length && !any.some((check) => !check(value, path, budget)))
          return error('does not match any supported shape');
        if (one.length && one.filter((check) => !check(value, path, budget)).length !== 1)
          return error('must match exactly one supported shape');
        if (not && !not(value, path, budget)) return error('matches a forbidden shape');
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) return error('must be finite');
          if (
            (s.minimum !== undefined && value < s.minimum) ||
            (s.maximum !== undefined && value > s.maximum) ||
            (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) ||
            (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum)
          )
            return error('is outside the supported bounds');
        } else if (typeof value === 'string') {
          let length = 0;
          if (s.minLength !== undefined || s.maxLength !== undefined)
            for (const _character of value) {
              length++;
              if (s.maxLength !== undefined && length > s.maxLength) break;
            }
          if (
            (s.minLength !== undefined && length < s.minLength) ||
            (s.maxLength !== undefined && length > s.maxLength)
          )
            return error('has an unsupported length');
          if (pattern && !pattern.test(value)) return error('does not match the supported pattern');
        } else if (Array.isArray(value)) {
          if (
            (s.minItems !== undefined && value.length < s.minItems) ||
            (s.maxItems !== undefined && value.length > s.maxItems)
          )
            return error('has an unsupported item count');
          const unique = new Set<string>();
          for (let index = 0; index < value.length; index++) {
            if (!(index in value)) return error('must not contain sparse items');
            if (s.uniqueItems) {
              const key = canonical(value[index]);
              if (unique.has(key)) return error('must contain unique items');
              unique.add(key);
            }
            if (items) {
              const result = items(value[index], `${path}/${index}`, budget);
              if (result) return result;
            }
          }
        } else if (plain(value)) {
          const keys = Object.keys(value);
          if (
            (s.minProperties !== undefined && keys.length < s.minProperties) ||
            (s.maxProperties !== undefined && keys.length > s.maxProperties)
          )
            return error('has an unsupported property count');
          for (const key of s.required ?? [])
            if (!Object.hasOwn(value, key)) return error(`requires ${key}`);
          for (const key of keys) {
            if (['__proto__', 'prototype', 'constructor'].includes(key))
              return error('contains a reserved field');
            if (!properties.has(key) && s.additionalProperties === false)
              return error('must not contain additional properties');
            const check = properties.get(key) ?? additional;
            if (check) {
              const result = check(value[key], `${path}/${key.slice(0, 160)}`, budget);
              if (result) return result;
            }
          }
        }
        return '';
      } finally {
        budget.depth--;
      }
    };
  }
  const check = compile(schema);
  return (value) => {
    try {
      const error = check(value, '/', { nodes: 0, depth: 0 });
      return { valid: !error, error };
    } catch (error) {
      return { valid: false, error: (error as Error).message };
    }
  };
}
