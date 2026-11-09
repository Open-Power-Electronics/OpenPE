import { useMemo, useRef, useState } from 'react';
import type { Message } from '@/lib/chat-sessions';
import Dialog from './Dialog';
import { conversationSearchPattern, searchableConversationText } from './agent-search-match';

const repeatSearchHint =
  'After opening a result, use F3 for the next match or Shift+F3 for the previous one.';

export function isConversationFindShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === 'f' &&
    event.ctrlKey !== event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

export default function AgentConversationSearch({
  messages,
  activeReplyId,
  onClose,
  onSelect,
}: {
  messages: readonly Message[];
  activeReplyId: string | null;
  onClose: () => void;
  onSelect: (id: string, term: string) => void;
}) {
  const [query, setQuery] = useState('');
  const composing = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLOListElement>(null);
  const entries = useMemo(
    () =>
      messages
        .flatMap((message, index) => {
          const text = searchableConversationText(message, activeReplyId);
          return text ? [{ id: message.id, role: message.role, number: index + 1, text }] : [];
        })
        .reverse(),
    [messages, activeReplyId],
  );
  const term = query.trim();
  const matches = useMemo(() => {
    const pattern = term ? conversationSearchPattern(term) : null;
    return entries.flatMap(({ id, role, number, text }) => {
      const match = pattern?.exec(text);
      if (pattern && !match) return [];
      const index = match?.index ?? 0;
      const prefix = text.slice(Math.max(0, index - 12), index).replace(/^[\uDC00-\uDFFF]/, '');
      const visible = text
        .slice(index, index + 200 - prefix.length)
        .replace(/[\uD800-\uDBFF]$/, '');
      const matchLength = match?.[0].length ?? 0;
      return [
        {
          id,
          role,
          number,
          before: (index > prefix.length ? '…' : '') + prefix,
          matched: visible.slice(0, matchLength),
          after: visible.slice(matchLength) + (index + visible.length < text.length ? '…' : ''),
        },
      ];
    });
  }, [entries, term]);
  function focusResult(index: number) {
    if (index < 0) {
      search.current?.focus({ preventScroll: true });
      return;
    }
    const list = results.current;
    const button = list?.children[index]?.querySelector('button');
    if (!list || !button) return;
    button.focus({ preventScroll: true });
    const bounds = list.getBoundingClientRect();
    const top = bounds.top + list.clientTop;
    const bottom = top + list.clientHeight;
    const row = button.getBoundingClientRect();
    if (row.top < top) list.scrollTop += row.top - top;
    else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
  }
  return (
    <Dialog
      title="Find messages"
      label="Find in conversation"
      className="agent-conversation-search"
      onClose={onClose}
    >
      <input
        ref={search}
        className="agent-conversation-search-input"
        type="search"
        aria-label="Search messages"
        placeholder="Search messages"
        maxLength={512}
        value={query}
        data-autofocus
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          if (results.current) results.current.scrollTop = 0;
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (isConversationFindShortcut(event.nativeEvent)) {
            event.preventDefault();
            if (!event.repeat) event.currentTarget.select();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'Enter' && !event.repeat && matches.length) {
            event.preventDefault();
            onSelect(matches[0].id, term);
          } else if (
            matches.length &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.shiftKey &&
            (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          ) {
            event.preventDefault();
            focusResult(event.key === 'ArrowDown' ? 0 : matches.length - 1);
          }
        }}
      />
      <p className="agent-conversation-result-count" role="status">
        {matches.length
          ? `${matches.length} ${matches.length === 1 ? 'message' : 'messages'}`
          : 'No matching messages'}
      </p>
      {matches.length > 0 && (
        <ol
          ref={results}
          className="agent-conversation-results"
          reversed
          aria-label="Matching messages"
          aria-description={term ? repeatSearchHint : undefined}
        >
          {matches.map(({ id, role, number, before, matched, after }, index) => (
            <li key={id} value={number}>
              <button
                type="button"
                onPointerDown={(event) => {
                  if (composing.current) event.preventDefault();
                }}
                onClick={() => {
                  if (!composing.current) onSelect(id, term);
                }}
                onKeyDown={(event) => {
                  if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
                    return;
                  if (isConversationFindShortcut(event.nativeEvent)) {
                    event.preventDefault();
                    if (!event.repeat) {
                      search.current?.focus({ preventScroll: true });
                      search.current?.select();
                    }
                  } else if (
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.altKey &&
                    !event.shiftKey &&
                    (event.key === 'ArrowDown' || event.key === 'ArrowUp')
                  ) {
                    event.preventDefault();
                    focusResult(index + (event.key === 'ArrowDown' ? 1 : -1));
                  }
                }}
              >
                <span className="agent-conversation-result-label">
                  <span aria-hidden="true">{number} · </span>
                  {role === 'user' ? 'You' : 'Reply'}
                </span>
                <span className="agent-conversation-excerpt">
                  {before}
                  {matched && <mark>{matched}</mark>}
                  {after}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
