import { flushLayoutCamera } from '../lib/layout-camera-presentation';

/** Snapshot the visible application at Send, including transient inspector drafts,
 * dialogs, errors and display controls. Conversation history and Source bytes have
 * their own structured inputs. This never reads files or browser storage. */
export function captureAgentPresentation(root: HTMLElement = document.body) {
  const excluded =
    '.chat-panel, .cm-editor, script, style, [hidden], [aria-hidden="true"], [data-agent-private]';
  const drawingElements = Array.from(
    root.querySelectorAll<SVGSVGElement>('.canvas-wrap > svg, .pcb-canvas svg'),
  );
  // Explicit observations read the exact native viewport, never the temporary
  // root box used for compositor motion. Detached/hidden projects stay untouched.
  for (const svg of drawingElements)
    if (!svg.closest(excluded) && svg.getClientRects().length) flushLayoutCamera(svg);
  const visibility = new Map<Element, boolean>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  const rectangles = new Map<Element, DOMRect>();
  const styleFor = (element: Element) => {
    if (!styles.has(element)) styles.set(element, getComputedStyle(element));
    return styles.get(element)!;
  };
  const rectangleFor = (element: Element) => {
    if (!rectangles.has(element)) rectangles.set(element, element.getBoundingClientRect());
    return rectangles.get(element)!;
  };
  const visible = (element: Element) => {
    if (visibility.has(element)) return visibility.get(element)!;
    if (element.closest(excluded)) return false;
    const rect = rectangleFor(element);
    const style = styleFor(element);
    let shown =
      element.getClientRects().length > 0 &&
      style.visibility !== 'hidden' &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth;
    for (
      let ancestor = element.parentElement;
      shown && ancestor;
      ancestor = ancestor.parentElement
    ) {
      const bounds = rectangleFor(ancestor),
        css = styleFor(ancestor);
      if (css.overflowX !== 'visible' && (rect.right <= bounds.left || rect.left >= bounds.right))
        shown = false;
      if (css.overflowY !== 'visible' && (rect.bottom <= bounds.top || rect.top >= bounds.bottom))
        shown = false;
    }
    visibility.set(element, shown);
    return shown;
  };
  const text: string[] = [];
  let length = 0,
    truncated = false,
    visited = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (++visited > 30000) {
      truncated = true;
      break;
    }
    const node = walker.currentNode;
    if (!node.parentElement || !visible(node.parentElement)) continue;
    const value = node.textContent?.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    if (length + value.length > 32000) {
      truncated = true;
      break;
    }
    text.push(value);
    length += value.length;
  }
  const controls = [];
  for (const element of root.querySelectorAll<HTMLElement>(
    'input, textarea, select, button, [role="combobox"], [role="switch"]',
  )) {
    if (!visible(element) || element.matches('input[type="password"], input[type="hidden"]'))
      continue;
    if (controls.length >= 512) {
      truncated = true;
      break;
    }
    const input = element as HTMLInputElement;
    const label = (
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      input.labels?.[0]?.textContent ||
      element.innerText ||
      ''
    ).trim();
    if (
      label.length > 1024 ||
      (element.matches('input,textarea,select') && input.value.length > 4096)
    )
      truncated = true;
    controls.push({
      label: label.slice(0, 1024),
      ...(element.matches('input,textarea,select') ? { value: input.value.slice(0, 4096) } : {}),
      ...(element.matches('input[type="checkbox"],input[type="radio"]')
        ? { checked: input.checked }
        : {}),
      pressed: element.getAttribute('aria-pressed'),
      expanded: element.getAttribute('aria-expanded'),
      disabled: !!input.disabled,
    });
  }
  const drawings = drawingElements.filter(visible).map((svg) => ({
    label: svg.getAttribute('aria-label') || svg.getAttribute('data-testid'),
    viewBox: svg.getAttribute('viewBox'),
    width: svg.clientWidth,
    height: svg.clientHeight,
  }));
  return { text: text.join('\n'), controls, drawings, truncated };
}
