'use client';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CornerDownRight, ListEnd, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import Select from './Select';
import type { AgentAnnotation } from '@/lib/agent-annotations';
import AgentQueuedMessagePreview from './AgentQueuedMessagePreview';

function guardComposition(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) event.preventDefault();
}

export default function AgentMessageQueue({
  items,
  active,
  paused,
  busy,
  canSteer,
  submitting,
  canEdit,
  onResume,
  onSteer,
  onEdit,
  onRemove,
  onFirst,
  onFocusInput,
}: {
  items: {
    id: string;
    text: string;
    annotations: readonly AgentAnnotation[];
    sameAgent: boolean;
  }[];
  active: boolean;
  paused: boolean;
  busy: boolean;
  canSteer: boolean;
  submitting: boolean;
  canEdit: boolean;
  onResume: () => void;
  onSteer: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onFirst: (id: string) => void;
  onFocusInput: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRemove = useRef<{ id: string; index: number } | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    text: string;
    annotations: AgentAnnotation[];
  } | null>(null);
  const restorePreviewFocus = useRef(false);
  useLayoutEffect(() => {
    if (!active) {
      restorePreviewFocus.current = false;
      if (preview) setPreview(null);
      return;
    }
    if (!restorePreviewFocus.current) return;
    restorePreviewFocus.current = false;
    if (document.activeElement === document.body) onFocusInput();
  }, [active, preview, onFocusInput]);
  useLayoutEffect(() => {
    const request = focusAfterRemove.current;
    if (!request) return;
    focusAfterRemove.current = null;
    if (items.some((item) => item.id === request.id)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const target = items[Math.min(request.index, items.length - 1)];
    const button = target ? removeButtons.current.get(target.id) : undefined;
    if (!button || button.disabled || !button.getClientRects().length) {
      onFocusInput();
      return;
    }
    button.focus({ preventScroll: true });
    const container = list.current;
    if (container) {
      const bounds = container.getBoundingClientRect();
      const row = button.getBoundingClientRect();
      if (row.top < bounds.top) container.scrollTop += row.top - bounds.top;
      else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom;
    }
  }, [items, onFocusInput]);
  if (!items.length && !preview) return null;
  return (
    <>
      {items.length > 0 && (
        <section className="agent-message-queue" aria-label="Queued messages">
          {paused && (
            <div className="agent-queue-heading">
              <span>Queue paused</span>
              {!busy && (
                <button type="button" onKeyDown={guardComposition} onClick={onResume}>
                  Resume queue
                </button>
              )}
            </div>
          )}
          <ol ref={list}>
            {items.map((item, index) => (
              <li key={item.id}>
                <ListEnd size={16} className="muted" aria-hidden="true" />
                <button
                  type="button"
                  className="agent-queued-text"
                  aria-label="Preview queued message"
                  title="Preview queued message"
                  aria-description={item.text}
                  onKeyDown={guardComposition}
                  onClick={() => {
                    if (active)
                      setPreview({
                        id: item.id,
                        text: item.text,
                        annotations: structuredClone([...item.annotations]),
                      });
                  }}
                >
                  {item.text || 'Design annotations'}
                  {item.annotations.length > 0 && (
                    <small>{item.annotations.length} attachments</small>
                  )}
                </button>
                <button
                  type="button"
                  className="agent-queue-steer"
                  disabled={
                    !busy ||
                    !canSteer ||
                    !item.sameAgent ||
                    submitting ||
                    item.annotations.length > 0
                  }
                  onKeyDown={guardComposition}
                  onClick={() => onSteer(item.id)}
                >
                  <CornerDownRight size={15} />
                  Steer
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove queued message"
                  ref={(button) => {
                    if (button) removeButtons.current.set(item.id, button);
                    else removeButtons.current.delete(item.id);
                  }}
                  title="Remove queued message"
                  disabled={submitting}
                  onKeyDown={guardComposition}
                  onClick={(event) => {
                    if (event.currentTarget === document.activeElement)
                      focusAfterRemove.current = { id: item.id, index };
                    onRemove(item.id);
                  }}
                >
                  <Trash2 size={15} />
                </button>
                <Select
                  label="Queued message actions"
                  icon={<MoreHorizontal size={16} />}
                  iconOnly
                  showChevron={false}
                  value=""
                  disabled={submitting}
                  popupPlacement="bottom"
                  options={[
                    {
                      value: 'edit',
                      label: 'Edit message',
                      icon: <Pencil size={15} />,
                      disabled: !canEdit,
                    },
                    {
                      value: 'first',
                      label: 'Send next',
                      icon: <ListEnd size={15} />,
                      disabled: index === 0,
                    },
                  ]}
                  onChange={(value) => (value === 'edit' ? onEdit(item.id) : onFirst(item.id))}
                />
              </li>
            ))}
          </ol>
        </section>
      )}
      {preview && active && (
        <AgentQueuedMessagePreview
          text={preview.text}
          annotations={preview.annotations}
          queued={items.some((item) => item.id === preview.id)}
          onClose={() => {
            restorePreviewFocus.current = !items.some((item) => item.id === preview.id);
            setPreview(null);
          }}
        />
      )}
    </>
  );
}
