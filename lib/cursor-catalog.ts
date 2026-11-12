export type CursorUnavailableModel = {
  id: string;
  reason: string;
};

const cursorUnavailableId =
  /^(?:\(missing id\)|\(invalid id\)|[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199})$/;

/** Cursor discovery reports each rejected catalog model. Reasons are fixed diagnostics, not SDK text. */
export function readCursorUnavailableModels(value: unknown): CursorUnavailableModel[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error('The agent returned an invalid model catalog.');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('The agent returned an invalid model catalog.');
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, 'id') ||
      !Object.hasOwn(record, 'reason') ||
      typeof record.id !== 'string' ||
      typeof record.reason !== 'string' ||
      !cursorUnavailableId.test(record.id)
    )
      throw new Error('The agent returned an invalid model catalog.');
    const prefix = `Cursor model ${record.id} `;
    if (
      !record.reason.startsWith(prefix) ||
      record.reason.length <= prefix.length ||
      record.reason.length > prefix.length + 200 ||
      !/^[\u0020-\u007E]+$/.test(record.reason)
    )
      throw new Error('The agent returned an invalid model catalog.');
    return { id: record.id, reason: record.reason };
  });
}

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
