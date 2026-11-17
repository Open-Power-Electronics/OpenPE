'use client';
import type { ReactNode } from 'react';
import type { Element, RootContent } from 'hast';
import CopyButton from './CopyButton';

function formulaSource(node?: Element) {
  const pending: RootContent[] = node ? [node] : [];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.type !== 'element') continue;
    if (current.tagName === 'annotation' && current.properties.encoding === 'application/x-tex')
      return current.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
    pending.push(...current.children);
  }
  return '';
}

export default function AgentMathBlock({
  children,
  node,
}: {
  children: ReactNode;
  node?: Element;
}) {
  return (
    <div className="agent-math-block">
      <div className="agent-math-scroll" role="region" aria-label="Formula" tabIndex={0}>
        {children}
      </div>
      <div className="agent-math-actions">
        <CopyButton text={formulaSource(node)} label="Copy formula as LaTeX" />
      </div>
    </div>
  );
}
