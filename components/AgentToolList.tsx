'use client';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

export default function AgentToolList({ children }: { children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    if (follow.current && list.current) {
      list.current.scrollTop = list.current.scrollHeight;
    }
  }, [children]);

  return (
    <div
      ref={list}
      className="agent-tool-list"
      aria-label="OpenPE tool activity"
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 2;
      }}
    >
      {children}
    </div>
  );
}
