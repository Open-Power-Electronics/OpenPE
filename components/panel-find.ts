import { isCommandModifier } from '@/lib/command-modifier';

export type FindScope = 'agent' | 'preview';
export const panelFindLimit = 1000;
type Bounds = { left: number; right: number; top: number; bottom: number };

export function findScopeAtPoint(
  point: { x: number; y: number } | null,
  agent: Bounds | null,
  preview: Bounds | null,
  fallback: FindScope = 'preview',
): FindScope | null {
  const inside = (bounds: Bounds | null) =>
    point &&
    bounds &&
    point.x >= bounds.left &&
    point.x < bounds.right &&
    point.y >= bounds.top &&
    point.y < bounds.bottom;
  if (inside(agent)) return 'agent';
  if (inside(preview)) return 'preview';
  return fallback === 'agent'
    ? agent
      ? 'agent'
      : preview
        ? 'preview'
        : null
    : preview
      ? 'preview'
      : agent
        ? 'agent'
        : null;
}

export function isPanelFindShortcut(event: KeyboardEvent) {
  return (
    !event.isComposing &&
    event.keyCode !== 229 &&
    isCommandModifier(event) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'f'
  );
}

export function literalPanelMatches(
  blocks: readonly string[],
  query: string,
  limit = panelFindLimit,
) {
  const term = query.slice(0, 512);
  const matches: { block: number; from: number; to: number }[] = [];
  if (!term) return { matches, truncated: false };
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (let block = 0; block < blocks.length; block++) {
    for (const match of blocks[block].matchAll(pattern)) {
      if (matches.length >= limit) return { matches, truncated: true };
      matches.push({ block, from: match.index, to: match.index + match[0].length });
    }
  }
  return { matches, truncated: false };
}

type TextBlock = { text: string; nodes: { node: Text; start: number }[] };
const excluded =
  'script, style, noscript, input, textarea, select, .cm-gutters, [hidden], [aria-hidden="true"], [data-panel-find]';
const blockSelector =
  'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th, .cm-line, div, section, summary, label, text';
const canvasSelector = 'svg[data-testid="schematic-canvas"], svg[data-testid="layout-canvas"]';
export const panelFindCanvasRevealEvent = 'openpe:panel-find-canvas-reveal';

function renderedBlocks(root: Element): TextBlock[] {
  const blocks: TextBlock[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let owner: Element | null = null;
  let block: TextBlock | null = null;
  for (let item = walker.nextNode(); item; item = walker.nextNode()) {
    const node = item as Text;
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest(excluded) ||
      (!parent.getClientRects().length && getComputedStyle(parent).display !== 'contents') ||
      getComputedStyle(parent).visibility !== 'visible'
    ) {
      owner = null;
      block = null;
      continue;
    }
    const next = parent.closest(blockSelector) ?? root;
    if (!block || owner !== next) {
      block = { text: '', nodes: [] };
      blocks.push(block);
      owner = next;
    }
    block.nodes.push({ node, start: block.text.length });
    block.text += node.data;
  }
  return blocks;
}

function visibleRange(range: Range, root: Element) {
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return false;
  // Camera clipping does not hide rendered drawing objects from Find. Keep the
  // other occurrences navigable after the camera zooms into the current one.
  if (range.startContainer.parentElement?.closest(canvasSelector)) return true;
  let scrollX = false;
  let scrollY = false;
  for (
    let parent = range.startContainer.parentElement;
    parent && root.contains(parent);
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    if (style.display === 'contents') continue;
    const bounds = parent.getBoundingClientRect();
    if (/auto|scroll/.test(style.overflowX)) scrollX = true;
    if (/auto|scroll/.test(style.overflowY)) scrollY = true;
    if (
      !scrollX &&
      /hidden|clip/.test(style.overflowX) &&
      rects.some((rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
    )
      return false;
    if (
      !scrollY &&
      /hidden|clip/.test(style.overflowY) &&
      rects.some((rect) => rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)
    )
      return false;
    if (parent === root) break;
  }
  return true;
}

/** Read only the supplied rendered pane. Never read messages, native files or other panes. */
export function collectPanelMatches(root: Element, query: string) {
  if (!query || !root.getClientRects().length) return { ranges: [] as Range[], truncated: false };
  const blocks = renderedBlocks(root);
  const { matches, truncated } = literalPanelMatches(
    blocks.map((block) => block.text),
    query,
  );
  const ranges: Range[] = [];
  for (const match of matches) {
    const block = blocks[match.block];
    const start = block.nodes.find((item) => item.start + item.node.length > match.from);
    const end = block.nodes.find((item) => item.start + item.node.length >= match.to);
    if (!start || !end) continue;
    const range = root.ownerDocument.createRange();
    range.setStart(start.node, match.from - start.start);
    range.setEnd(end.node, match.to - end.start);
    if (visibleRange(range, root)) ranges.push(range);
  }
  return { ranges, truncated };
}

export const panelFindRevealEvent = 'openpe:panel-find-reveal';

export function revealPanelRange(root: Element, range: Range, findBarBottom: number) {
  const canvas = range.startContainer.parentElement?.closest(canvasSelector);
  if (
    canvas &&
    !canvas.dispatchEvent(
      new CustomEvent(panelFindCanvasRevealEvent, { detail: range, cancelable: true }),
    )
  )
    return;
  root.dispatchEvent(new Event(panelFindRevealEvent));
  for (
    let parent = range.startContainer.parentElement;
    parent && root.contains(parent);
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    const hit = range.getBoundingClientRect();
    const inFrozenColumn =
      parent.matches('.message-table[data-freeze-first]') &&
      range.startContainer.parentElement?.closest<HTMLTableCellElement>('th, td')?.cellIndex === 0;
    const gutter = parent.matches('.agent-code-block > pre')
      ? parent.querySelector('.agent-code-line-number')
      : parent.matches('.cm-scroller')
        ? parent.querySelector('.cm-gutters')
        : parent.matches('.message-table[data-freeze-first]') && !inFrozenColumn
          ? parent.querySelector('thead th:first-child')
          : null;
    const header =
      parent.matches('.message-table') && !range.startContainer.parentElement?.closest('thead')
        ? parent.querySelector('thead')
        : null;
    const left = bounds.left + parent.clientLeft + (gutter?.getBoundingClientRect().width ?? 0);
    const right = bounds.left + parent.clientLeft + parent.clientWidth;
    const top = Math.min(
      bounds.bottom - 1,
      Math.max(
        bounds.top + parent.clientTop + (header?.getBoundingClientRect().height ?? 0),
        findBarBottom,
      ),
    );
    const bottom = bounds.top + parent.clientTop + parent.clientHeight;
    if (!inFrozenColumn && /auto|scroll/.test(style.overflowX)) {
      if (hit.left < left) parent.scrollLeft += hit.left - left;
      else if (hit.right > right) parent.scrollLeft += hit.right - right;
    }
    if (/auto|scroll/.test(style.overflowY)) {
      if (hit.top < top || hit.bottom > bottom)
        parent.scrollTop += (hit.top + hit.bottom - top - bottom) / 2;
    }
    if (parent === root) break;
  }
}
