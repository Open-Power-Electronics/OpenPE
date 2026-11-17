export function validModelId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@\[\]-]{0,199}$/.test(value);
}
