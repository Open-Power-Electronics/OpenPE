'use client';
import { type ReactNode, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

export default function AgentProcess({
  running,
  attention,
  children,
}: {
  running: boolean;
  attention: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(running || attention);
  useEffect(() => {
    setOpen(running || attention);
  }, [running, attention]);
  return (
    <details
      className="agent-process"
      data-attention={attention || undefined}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
      }}
    >
      <summary>
        <ChevronRight size={14} className="agent-process-chevron" aria-hidden="true" />
        <span>{running ? 'Working' : 'Work details'}</span>
        {attention && <span className="agent-process-attention">Needs attention</span>}
      </summary>
      {open && <div className="agent-process-body">{children}</div>}
    </details>
  );
}
