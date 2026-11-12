/** A catalog parameter whose only values are the strings true and false. */
export function isCursorBooleanParameter(parameter: { values: { value: string }[] }) {
  const values = parameter.values.map((entry) => entry.value);
  return (
    values.length === 2 &&
    new Set(values).size === 2 &&
    values.includes('true') &&
    values.includes('false')
  );
}
