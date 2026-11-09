'use client';

import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import Dialog from './Dialog';

const headingSelector = ':scope > .agent-markdown > :is(h1, h2, h3, h4, h5, h6)';
type OutlineEntry = { target: HTMLElement; title: string; depth: number };

export default function AgentAnswerOutline({
  answer,
  active,
  onNavigate,
}: {
  answer: RefObject<HTMLDivElement | null>;
  active: boolean;
  onNavigate: (heading: HTMLElement) => void;
}) {
  const [headings, setHeadings] = useState<OutlineEntry[] | null>(null);
  const pending = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      pending.current = null;
      setHeadings(null);
    }
    if (headings) return;
    const heading = pending.current;
    pending.current = null;
    if (active && heading && answer.current?.contains(heading)) onNavigate(heading);
  }, [active, answer, headings, onNavigate]);

  return (
    <>
      <button
        className="agent-answer-outline-trigger"
        type="button"
        aria-label="Show reply contents"
        aria-haspopup="dialog"
        onClick={() => {
          const items = answer.current?.querySelectorAll<HTMLElement>(headingSelector);
          if (!active || !items || items.length < 2) return;
          const entries = Array.from(items).slice(0, 100);
          const firstLevel = Math.min(...entries.map((heading) => Number(heading.tagName[1])));
          setHeadings(
            entries.map((target) => {
              const title = target.innerText.replace(/\s+/g, ' ').trim();
              return {
                target,
                title: title.length > 240 ? `${title.slice(0, 239)}…` : title || 'Untitled section',
                depth: Math.min(Number(target.tagName[1]) - firstLevel, 3),
              };
            }),
          );
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        <ListTree size={15} aria-hidden="true" />
        Contents
      </button>
      {active && headings && (
        <Dialog
          title="Reply contents"
          className="agent-answer-outline"
          onClose={() => setHeadings(null)}
        >
          <ol aria-label="Reply headings">
            {headings.map(({ target, title, depth }, index) => (
              <li key={index}>
                <button
                  type="button"
                  data-autofocus={index === 0 || undefined}
                  style={{ '--outline-depth': depth } as CSSProperties}
                  onClick={() => {
                    pending.current = target;
                    setHeadings(null);
                  }}
                >
                  {title}
                </button>
              </li>
            ))}
          </ol>
        </Dialog>
      )}
    </>
  );
}
