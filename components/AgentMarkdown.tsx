'use client';

import { memo, useId, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Element, Root, RootContent } from 'hast';
import type { PluggableList } from 'unified';
import { responseText } from '@/lib/chat-stream';
import { normalizeAgentMath } from '@/lib/agent-math';
import AgentCodeBlock from './AgentCodeBlock';
import AgentTable, { AgentTableSource } from './AgentTable';
import AgentMathBlock from './AgentMathBlock';
import { followAgentFootnote, isAgentFootnote, scopeAgentFootnotes } from './agent-footnotes';

const plugins = [remarkGfm, remarkMath];

function accessibleDescriptions() {
  return (tree: Root) => {
    const pending: (Root | RootContent)[] = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'element') {
        const title = node.properties.title;
        if (typeof title === 'string' && title) node.properties['aria-description'] ??= title;
        delete node.properties.title;
      }
      if ('children' in node) {
        for (const child of node.children) pending.push(child);
      }
    }
  };
}

const mathPlugins: PluggableList = [
  [
    rehypeKatex,
    {
      trust: false,
      strict: 'ignore',
      maxExpand: 200,
      maxSize: 20,
      errorColor: 'inherit',
    },
  ],
  accessibleDescriptions,
];
const components: Components = {
  a: ({ href, children, node, ...props }) =>
    href ? (
      node && isAgentFootnote(node) ? (
        <a
          {...props}
          href={href}
          onClick={followAgentFootnote}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          {children}
        </a>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" aria-description={href}>
          {children}
        </a>
      )
    ) : (
      <span>{children}</span>
    ),
  // Agent-authored images must not make unsolicited network requests.
  img: ({ alt }) => <span>{alt || 'Image'}</span>,
  pre: ({ children, node }) => <AgentCodeBlock node={node}>{children}</AgentCodeBlock>,
  table: ({ children, node }) => <AgentTable node={node}>{children}</AgentTable>,
  span: ({ className, children, node, ...props }) => {
    const content = (
      <span className={className} {...props}>
        {children}
      </span>
    );
    return className?.split(' ').includes('katex-display') ? (
      <AgentMathBlock node={node}>{content}</AgentMathBlock>
    ) : (
      content
    );
  },
};

function safeUrl(url: string, key: string, node: Element) {
  return /^https?:\/\//i.test(url) ||
    (key === 'href' && isAgentFootnote(node) && url.startsWith('#'))
    ? url
    : '';
}

export default memo(function AgentMarkdown({ text }: { text: string }) {
  const id = useId();
  const scopedPlugins = useMemo<PluggableList>(
    () => [...mathPlugins, [scopeAgentFootnotes, { prefix: `openpe-${id}-` }]],
    [id],
  );
  const source = normalizeAgentMath(responseText(text));
  return (
    <div className="message-text agent-markdown">
      <AgentTableSource value={source}>
        <Markdown
          remarkPlugins={plugins}
          rehypePlugins={scopedPlugins}
          components={components}
          urlTransform={safeUrl}
          skipHtml
        >
          {source}
        </Markdown>
      </AgentTableSource>
    </div>
  );
});
