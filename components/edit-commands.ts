import type { EditTarget } from './DesktopTitlebar';

export function visibleEditTarget(target: EditTarget | null): target is EditTarget {
  return Boolean(
    target?.isConnected && target.getClientRects().length && !target.closest('[hidden], [inert]'),
  );
}

export function textEditTarget(target: EditTarget | null) {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLInputElement)
    return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(target.type)
      ? target
      : null;
  if (target instanceof HTMLTextAreaElement) return target;
  if (target.isContentEditable || target.matches('.cm-content')) return target;
  return null;
}

export function writableText(target: HTMLElement) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    return !target.readOnly && !target.disabled;
  return target.isContentEditable;
}

export function dispatchEditKey(target: EditTarget, key: string, mac = false, shiftKey = false) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: key.length === 1 && !mac,
      metaKey: key.length === 1 && mac,
      shiftKey,
    }),
  );
}

type TextCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'forwardDelete' | 'selectAll';

function textPosition(target: HTMLElement) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    return [target.value, target.selectionStart, target.selectionEnd, target.selectionDirection];
  const selection = document.getSelection();
  return [
    target.textContent,
    selection?.anchorNode,
    selection?.anchorOffset,
    selection?.focusNode,
    selection?.focusOffset,
  ];
}

export async function runTextEdit(
  target: HTMLElement,
  command: TextCommand,
  mac: boolean,
  allowed: () => boolean,
) {
  if (!allowed() || !visibleEditTarget(target)) return;
  target.focus({ preventScroll: true });
  const focused = () => allowed() && visibleEditTarget(target) && document.activeElement === target;
  if (!focused()) return;
  const code = target.matches('.cm-content');
  if (command === 'paste') {
    const position = textPosition(target);
    let blurred = false;
    const blur = () => {
      blurred = true;
    };
    target.addEventListener('blur', blur, { once: true });
    try {
      const text = await navigator.clipboard.readText();
      if (
        blurred ||
        !focused() ||
        !writableText(target) ||
        !textPosition(target).every((value, index) => value === position[index])
      )
        return;
      if (code) {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        target.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
        );
      } else document.execCommand('insertText', false, text);
    } finally {
      target.removeEventListener('blur', blur);
    }
    return;
  }
  if (code) {
    if (command === 'undo') return dispatchEditKey(target, 'z', mac);
    if (command === 'redo') return dispatchEditKey(target, mac ? 'Z' : 'y', mac, mac);
    if (command === 'forwardDelete') return dispatchEditKey(target, 'Delete');
    if (command === 'selectAll') return dispatchEditKey(target, 'a', mac);
  }
  document.execCommand(command);
}
