import type { Message } from '@/lib/chat-sessions';
import { responseText } from '@/lib/chat-stream';

const textBlock = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, th, td, div, section';
const excluded = '.agent-math-block, .katex, .katex-error, button, [hidden], [aria-hidden="true"]';
const readerSelector = '.agent-code-block > pre, .message-table';
type RenderedSearchMatch = { range: Range; rect: DOMRect; reader?: HTMLElement | null };

function firstTextRect(range: Range) {
  return Array.from(range.getClientRects()).find((item) => item.width > 0 && item.height > 0);
}

export function conversationSearchPattern(term: string) {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
}

export function searchableConversationText(message: Message, activeReplyId: string | null) {
  if (message.id === activeReplyId) return '';
  if (message.role === 'assistant') return responseText(message.text);
  const count = message.annotations?.length ?? 0;
  return (
    message.text.trim() ||
    message.annotations?.[0]?.comment.trim() ||
    (count ? `${count} ${count === 1 ? 'annotation' : 'annotations'}` : 'Empty message')
  );
}

export function nextConversationMatch(
  messages: readonly Message[],
  activeReplyId: string | null,
  current: { id: string; term: string },
  direction: 1 | -1,
) {
  const pattern = conversationSearchPattern(current.term);
  const index = messages.findIndex((message) => message.id === current.id);
  const start = index < 0 && direction < 0 ? 0 : index;
  for (let step = 1; step <= messages.length; step++) {
    const message = messages[(start + step * direction + messages.length) % messages.length];
    if (pattern.test(searchableConversationText(message, activeReplyId)))
      return { id: message.id, term: current.term };
  }
}

export function renderedSearchMatch(
  message: HTMLElement,
  term: string,
  direction: 1 | -1 = 1,
  after?: Range,
): RenderedSearchMatch | undefined {
  if (!term) return;
  const content = message.querySelector('.agent-answer-part .agent-markdown, .agent-user-content');
  if (!content) return;
  if (after && (after.collapsed || !content.contains(after.startContainer))) return;
  const boundary = after?.cloneRange();
  boundary?.collapse(true);
  const literal = content.matches('.agent-user-content');
  const clip = content.closest('.agent-user-preview:not([data-expanded])')?.getBoundingClientRect();
  const pattern = new RegExp(conversationSearchPattern(term), 'giu');
  let block: Element | null = null;
  let nodes: Text[] = [];

  function matchBlock() {
    if (!nodes.length) return;
    const text = nodes.map((node) => node.data).join('');
    const reader = block?.closest<HTMLElement>(readerSelector);
    let nodeIndex = 0;
    let offset = 0;
    let last: RenderedSearchMatch | undefined;
    for (const match of text.matchAll(pattern)) {
      while (offset + nodes[nodeIndex].length <= match.index) {
        offset += nodes[nodeIndex].length;
        nodeIndex++;
      }
      const startNode = nodes[nodeIndex];
      const start = match.index - offset;
      if (boundary && boundary.comparePoint(startNode, start) !== direction) continue;
      const end = match.index + match[0].length;
      while (offset + nodes[nodeIndex].length < end) {
        offset += nodes[nodeIndex].length;
        nodeIndex++;
      }
      const range = document.createRange();
      range.setStart(startNode, start);
      range.setEnd(nodes[nodeIndex], end - offset);
      const rect = firstTextRect(range);
      if (!rect || (clip && rect.bottom > clip.bottom + 1)) continue;
      const hit = { range, rect, reader };
      if (direction === 1) return hit;
      last = hit;
    }
    return last;
  }

  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let last: RenderedSearchMatch | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) && !(node instanceof HTMLBRElement)) continue;
    const parent = node.parentElement;
    const nextBlock =
      node instanceof Text && !parent?.closest(excluded) && (literal || parent !== content)
        ? (parent?.closest(textBlock) ?? null)
        : null;
    if (block !== nextBlock) {
      const match = matchBlock();
      if (match && direction === 1) return match;
      last = match ?? last;
      block = nextBlock;
      nodes = [];
    }
    if (block && node instanceof Text) nodes.push(node);
  }
  return matchBlock() ?? last;
}

export function revealSearchMatch(match: RenderedSearchMatch) {
  const { range, rect, reader } = match;
  if (!reader) return rect.top;
  const bounds = reader.getBoundingClientRect();
  const frozenTable = reader.hasAttribute('data-freeze-first');
  const cell = range.startContainer.parentElement?.closest<HTMLTableCellElement>('th, td');
  const inFrozenColumn = frozenTable && cell?.cellIndex === 0;
  const gutter =
    frozenTable && !inFrozenColumn
      ? reader.querySelector('thead th:first-child')
      : reader.querySelector('.agent-code-line-number');
  const gutterWidth = gutter?.getBoundingClientRect().width ?? 0;
  const right = bounds.left + reader.clientLeft + reader.clientWidth;
  const left = bounds.left + reader.clientLeft + gutterWidth;
  const bottom = bounds.top + reader.clientTop + reader.clientHeight;
  const headerHeight = range.startContainer.parentElement?.closest('thead')
    ? 0
    : (reader.querySelector('thead')?.getBoundingClientRect().height ?? 0);
  const top =
    bounds.top +
    reader.clientTop +
    Math.min(headerHeight, Math.max(0, reader.clientHeight - rect.height));
  const hit = range.getBoundingClientRect();
  const horizontal = hit.width <= right - left ? hit : rect;
  const vertical = hit.height <= bottom - top ? hit : rect;
  if (!inFrozenColumn) {
    if (horizontal.left < left || horizontal.width > right - left)
      reader.scrollLeft += horizontal.left - left;
    else if (horizontal.right > right) reader.scrollLeft += horizontal.right - right;
  }
  if (vertical.top < top || vertical.height > bottom - top) reader.scrollTop += vertical.top - top;
  else if (vertical.bottom > bottom) reader.scrollTop += vertical.bottom - bottom;
  return firstTextRect(range)?.top ?? rect.top;
}
