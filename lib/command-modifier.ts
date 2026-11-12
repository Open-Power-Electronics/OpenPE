/** Control on Windows or Command on macOS. Either key is the command modifier. */
export function isCommandModifier(event: { ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return Boolean(event.ctrlKey) || Boolean(event.metaKey);
}
