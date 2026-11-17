import type { Element, Root, RootContent } from 'hast';
import type { MouseEvent } from 'react';

// Only parser-generated footnote references can become local navigation.
export function scopeAgentFootnotes({ prefix }: { prefix: string }) {
  return (tree: Root) => {
    const elements: Element[] = [];
    const pending: (Root | RootContent)[] = [tree];
    const ids = new Map<string, string>();
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'element') {
        elements.push(node);
        const id = node.properties.id;
        if (typeof id === 'string') {
          const scoped = prefix + id;
          ids.set(id, scoped);
          node.properties.id = scoped;
          if (node.tagName === 'li' && id.startsWith('user-content-fn-'))
            node.properties.tabIndex = -1;
        }
      }
      if ('children' in node) pending.push(...node.children);
    }
    for (const node of elements) {
      const p = node.properties;
      if (Array.isArray(p.ariaDescribedBy))
        p.ariaDescribedBy = p.ariaDescribedBy.map((id) => ids.get(String(id)) || id);
      if (node.tagName !== 'a' || (p.dataFootnoteRef !== true && p.dataFootnoteBackref !== ''))
        continue;
      const target =
        typeof p.href === 'string' && p.href.startsWith('#') ? ids.get(p.href.slice(1)) : undefined;
      if (target) {
        p.href = '#' + target;
        p.dataOpenpeFootnote = true;
      }
    }
  };
}

export function isAgentFootnote(node: Element) {
  return node.tagName === 'a' && node.properties.dataOpenpeFootnote === true;
}

export function followAgentFootnote(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const link = event.currentTarget;
  const href = link.getAttribute('href');
  const reply = link.closest('.agent-markdown');
  const target = href?.startsWith('#') ? document.getElementById(href.slice(1)) : null;
  if (!target || !reply?.contains(target) || !target.getClientRects().length) return;
  target.focus({ preventScroll: true });
  const scroll = reply.closest('.chat-scroll');
  if (!scroll) return;
  // Reveal within this conversation's reading areas, never the editor or page.
  for (
    let parent = target.parentElement;
    parent && scroll.contains(parent);
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    const top = bounds.top + parent.clientTop;
    const left = bounds.left + parent.clientLeft;
    const rect = target.getBoundingClientRect();
    if (['auto', 'scroll'].includes(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
      if (rect.top < top || rect.height > parent.clientHeight) parent.scrollTop += rect.top - top;
      else if (rect.bottom > top + parent.clientHeight)
        parent.scrollTop += rect.bottom - top - parent.clientHeight;
    }
    if (['auto', 'scroll'].includes(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
      if (rect.left < left || rect.width > parent.clientWidth)
        parent.scrollLeft += rect.left - left;
      else if (rect.right > left + parent.clientWidth)
        parent.scrollLeft += rect.right - left - parent.clientWidth;
    }
    if (parent === scroll) break;
  }
}
