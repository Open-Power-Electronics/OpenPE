'use client';
import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export default memo(function AgentUserMessage({ text, active }: { text: string; active: boolean }) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const revealCollapsed = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const retainToggle = useCallback((element: HTMLButtonElement | null) => {
    if (!element) restoreFocus.current = document.activeElement === toggle.current;
    toggle.current = element;
  }, []);
  useLayoutEffect(() => {
    const element = content.current;
    if (!active || !element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflow(element.scrollHeight > Math.ceil(lineHeight * 6) + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, active]);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (active && document.activeElement === document.body)
      content.current?.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    if (!revealCollapsed.current) return;
    revealCollapsed.current = false;
    const button = toggle.current;
    const area = button?.closest<HTMLElement>('.chat-scroll');
    if (
      expanded ||
      !active ||
      !button ||
      document.activeElement !== button ||
      !area?.getClientRects().length
    )
      return;
    const bounds = area.getBoundingClientRect();
    const top = bounds.top + area.clientTop + 4;
    const available = area.clientHeight - 8;
    const message = button.closest('.agent-user-message')!.getBoundingClientRect();
    const target = message.height <= available ? message : button.getBoundingClientRect();
    if (target.top < top) area.scrollTop += target.top - top;
    else if (target.bottom > top + available) area.scrollTop += target.bottom - top - available;
  }, [expanded, active]);
  return (
    <div className="message-text agent-user-message">
      <div className="agent-user-preview" data-expanded={expanded || undefined}>
        <div ref={content} id={id} className="agent-user-content" tabIndex={-1}>
          {text}
        </div>
      </div>
      {overflow && (
        <button
          ref={retainToggle}
          type="button"
          className="agent-user-toggle"
          aria-controls={id}
          aria-expanded={expanded}
          aria-label={expanded ? 'Show less of this message' : 'Show more of this message'}
          onClick={(event) => {
            revealCollapsed.current = expanded && event.currentTarget === document.activeElement;
            setExpanded((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});
