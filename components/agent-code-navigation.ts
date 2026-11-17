import { isCommandModifier } from '@/lib/command-modifier';
export function isGoToCodeLineShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === 'g' &&
    isCommandModifier(event) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function revealCodeLine(reader: HTMLPreElement, line: HTMLElement) {
  reader.scrollTop +=
    line.getBoundingClientRect().top - reader.getBoundingClientRect().top - reader.clientTop;
  const viewport = reader.closest<HTMLElement>('.chat-scroll');
  if (!viewport) return;
  const top = viewport.getBoundingClientRect().top + viewport.clientTop;
  const position = line.getBoundingClientRect().top;
  if (
    position < top ||
    position + parseFloat(getComputedStyle(line).lineHeight) > top + viewport.clientHeight
  )
    viewport.scrollTop += position - top - 8;
}
