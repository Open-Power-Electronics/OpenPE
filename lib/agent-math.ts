import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import type { Root, RootContent } from 'mdast';

const parser = unified().use(remarkParse).use(remarkMath);
const literalNodes = new Set([
  'code',
  'inlineCode',
  'math',
  'inlineMath',
  'html',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'definition',
]);

// Normalize only a display copy. Parse positions protect code, existing dollar
// math and links, including unclosed fenced code in streamed responses.
export function normalizeAgentMath(text: string): string {
  if (!/\\[([]|\([^\n]*\\[a-zA-Z]/.test(text)) return text;
  const ranges: [number, number][] = [];
  function collect(node: Root | RootContent) {
    if (literalNodes.has(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
    } else if ('children' in node) {
      for (const child of node.children) collect(child);
    }
  }
  collect(parser.parse(text));
  const convert = (prose: string) =>
    prose.replace(
      /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\(([^()\n]*\\[a-zA-Z]+[^()\n]*)\)/g,
      (
        match,
        inline: string | undefined,
        block: string | undefined,
        bare: string | undefined,
        offset: number,
      ) => {
        // A doubled slash escapes the delimiter rather than opening a formula.
        if (offset > 0 && prose[offset - 1] === '\\') return match;
        if (block !== undefined) return `\n$$\n${block.trim()}\n$$\n`;
        if (inline !== undefined) return `$${inline.trim()}$`;
        // Some replies omit delimiter slashes. Recognize parenthesized TeX only,
        // leaving ordinary prose and electrical names in parentheses untouched.
        return `($${bare}$)`;
      },
    );
  let result = '',
    cursor = 0;
  for (const [start, end] of ranges) {
    result += convert(text.slice(cursor, start)) + text.slice(start, end);
    cursor = end;
  }
  return result + convert(text.slice(cursor));
}
