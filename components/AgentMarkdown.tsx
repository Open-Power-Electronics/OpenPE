'use client';

import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Root, RootContent } from 'hast';
import type { PluggableList } from 'unified';
import { responseText } from '@/lib/chat-stream';
import { normalizeAgentMath } from '@/lib/agent-math';

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
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" aria-description={href}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Agent-authored images must not make unsolicited network requests.
  img: ({ alt }) => <span>{alt || 'Image'}</span>,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  table: ({ children }) => (
    <div className="message-table" role="region" aria-label="Response table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

function safeUrl(url: string) {
  return /^https?:\/\//i.test(url) ? url : '';
}

export default memo(function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="message-text agent-markdown">
      <Markdown
        remarkPlugins={plugins}
        rehypePlugins={mathPlugins}
        components={components}
        urlTransform={safeUrl}
        skipHtml
      >
        {normalizeAgentMath(responseText(text))}
      </Markdown>
    </div>
  );
});
