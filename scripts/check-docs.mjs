import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const parser = unified().use(remarkParse);
const entryPoints = [
  'README.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'DESIGN.md',
  'assets/README.md',
  'plugins/README.md',
  'references/README.md',
  'tests/fixtures/README.md',
];

function visit(node, callback) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function nodeText(node) {
  if (node.type === 'html') return '';
  return node.value ?? node.alt ?? (node.children ?? []).map(nodeText).join('');
}

function htmlAttributes(source) {
  const attributes = [];
  const html = source.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const tag of html.matchAll(/<[a-z][\w:-]*\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    for (const match of tag[1].matchAll(
      /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
    )) {
      attributes.push({
        name: match[1].toLowerCase(),
        value: match[2] ?? match[3] ?? match[4] ?? '',
      });
    }
  }
  return attributes;
}

function anchors(tree) {
  const result = new Set();
  visit(tree, (node) => {
    if (node.type === 'heading') {
      const base = nodeText(node)
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
        .replace(/\s/g, '-');
      let slug = base;
      for (let i = 1; result.has(slug); i++) slug = `${base}-${i}`;
      result.add(slug);
    } else if (node.type === 'html') {
      for (const { name, value } of htmlAttributes(node.value))
        if (name === 'id' || name === 'name') result.add(value);
    }
  });
  return result;
}

/**
 * Check maintained application docs only; upstream material stays byte-for-byte intact.
 * @param {string} root
 * @param {string[]} [files]
 */
export async function checkDocumentation(root, files) {
  root = path.resolve(root);
  if (!files) {
    const contracts = (await readdir(path.join(root, 'docs'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => `docs/${entry.name}`);
    files = [...entryPoints, ...contracts].sort();
  }
  const { scripts = {} } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const issues = [];
  const trees = new Map();
  const targets = new Map();
  async function document(file) {
    if (!trees.has(file)) {
      const source = await readFile(file, 'utf8');
      trees.set(file, { source, tree: parser.parse(source) });
    }
    return trees.get(file);
  }
  async function targetInfo(file) {
    if (!targets.has(file)) targets.set(file, await stat(file));
    return targets.get(file);
  }
  let links = 0;
  for (const file of files) {
    const absolute = path.resolve(root, file);
    const report = (line, message) => issues.push({ file, line, message });
    let source, tree;
    try {
      ({ source, tree } = await document(absolute));
    } catch {
      report(1, 'Document is missing or unreadable.');
      continue;
    }
    const references = [];
    visit(tree, (node) => {
      // Product copy uses one spelling. Code spans/fences can represent current
      // protocol and storage identifiers, or quoted source evidence.
      if (node.type === 'text' || node.type === 'image') {
        const value = node.type === 'image' ? (node.alt ?? '') : node.value;
        for (const match of value.matchAll(/\bopen(?:ee|pe)\b/gi)) {
          if (match[0] !== 'OpenPE')
            report(
              node.position.start.line + value.slice(0, match.index).split('\n').length - 1,
              `Product name must be OpenPE, not ${JSON.stringify(match[0])}; format code and quoted source identifiers as inline code.`,
            );
        }
      }
      if (['link', 'image', 'definition'].includes(node.type))
        references.push({ url: node.url, line: node.position.start.line });
      if (node.type === 'html') {
        for (const { name, value } of htmlAttributes(node.value))
          if (name === 'href' || name === 'src')
            references.push({ url: value, line: node.position.start.line });
      }
    });
    for (const { url, line } of references) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) continue;
      links++;
      try {
        const [target, fragment] = url.split('#', 2);
        const filename = decodeURIComponent(target.split('?', 1)[0]);
        const resolved = !filename
          ? absolute
          : filename.startsWith('/')
            ? path.resolve(root, `.${filename}`)
            : path.resolve(path.dirname(absolute), filename);
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new Error('Target leaves the repository.');
        const info = await targetInfo(resolved);
        if (fragment && info.isFile() && resolved.endsWith('.md')) {
          const targetDoc = await document(resolved);
          targetDoc.anchors ??= anchors(targetDoc.tree);
          if (!targetDoc.anchors.has(decodeURIComponent(fragment)))
            throw new Error('Heading or explicit anchor is missing.');
        }
      } catch (error) {
        report(line, `Invalid local link ${JSON.stringify(url)}: ${error.message}`);
      }
    }
    for (const match of source.matchAll(/\bnpm run ([a-z\d:_.-]+)/gi)) {
      if (!Object.hasOwn(scripts, match[1]))
        report(source.slice(0, match.index).split('\n').length, `Unknown npm script: ${match[1]}`);
    }
  }
  return { documents: files.length, links, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkDocumentation(fileURLToPath(new URL('..', import.meta.url)));
  for (const issue of result.issues) console.error(`${issue.file}:${issue.line}: ${issue.message}`);
  if (result.issues.length) process.exitCode = 1;
  else
    console.log(
      `Documentation passed (${result.documents} documents, ${result.links} local links).`,
    );
}
