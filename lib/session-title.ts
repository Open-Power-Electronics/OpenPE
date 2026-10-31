import { displayName } from './display-name';

export function validSuggestedTitle(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 60) return;
  try {
    return displayName(value);
  } catch {
    return;
  }
}

/** Reserved reply metadata is untrusted text, never a command or a tool grant. */
export function suggestedSessionTitle(text: string): string | undefined {
  const blocks = [...text.matchAll(/```openpe_session\b[^\S\r\n]*\r?\n([\s\S]*?)```/g)];
  if (blocks.length !== 1 || blocks[0][1].length > 512) return;
  try {
    const value = JSON.parse(blocks[0][1]);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, 'title')
    )
      return;
    return validSuggestedTitle(value.title);
  } catch {
    return;
  }
}

export function withoutSessionTitle(text: string) {
  return text
    .replace(/```openpe_session\b[\s\S]*?(?:```|$)/g, '')
    .replace(/(^|\n)[ \t]{0,3}```(openpe_[a-z]*)$/, (match, line, prefix) =>
      'openpe_session'.startsWith(prefix) ? line : match,
    )
    .trim();
}
