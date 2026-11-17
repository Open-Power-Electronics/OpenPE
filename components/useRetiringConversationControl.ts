'use client';
import { useCallback, useLayoutEffect, useRef } from 'react';

export default function useRetiringConversationControl(active: boolean, onFocusInput: () => void) {
  const button = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const retain = useCallback((element: HTMLButtonElement | null) => {
    if (!element) restoreFocus.current = document.activeElement === button.current;
    button.current = element;
  }, []);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (active && document.activeElement === document.body) onFocusInput();
  });
  return retain;
}
