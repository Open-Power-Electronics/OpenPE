export const MAX_DISPLAY_NAME_LENGTH = 120;

export function displayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > MAX_DISPLAY_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(name))
    throw new Error(`Use a name of 1–${MAX_DISPLAY_NAME_LENGTH} characters on one line.`);
  return name;
}
