import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentMarkdown from '../components/AgentMarkdown';
import { normalizeAgentMath } from '../lib/agent-math';

const render = (text: string) => renderToStaticMarkup(createElement(AgentMarkdown, { text }));

test('agent replies format emphasis, nested lists, tables and literal code', () => {
  const html = render(
    'This is an **asynchronous buck converter**.\n\n- **V102:** 12 V\n- Inductor\n  - 100 µH\n\n| Part | Value |\n| --- | --- |\n| R | 5 Ω |\n\n```spice\nV1 in 0 12\n* **literal**\n```',
  );
  assert.match(html, /<strong>asynchronous buck converter<\/strong>/);
  assert.match(html, /<li><strong>V102:<\/strong> 12 V<\/li>/);
  assert.match(html, /<ul>\s*<li>100 µH<\/li>\s*<\/ul>/);
  assert.match(html, /aria-label="Response table"/);
  assert.match(html, /<td>5 Ω<\/td>/);
  assert.match(
    html,
    /<pre tabindex="0"><code class="language-spice">V1 in 0 12\n\* \*\*literal\*\*/,
  );
});

test('streaming fragments remain renderable and proposal payloads stay hidden', () => {
  const text = '**Output**\n\n```openpe\n{"ops":[{"type":"removePart","ref":"R1"}]}\n```';
  for (let end = 1; end <= text.length; end++)
    assert.doesNotThrow(() => render(text.slice(0, end)));
  for (const suffix of ['', '\n```']) {
    const html = render('Ready.\n\n```openpe\n{"ops":[]}' + suffix);
    assert.match(html, /Ready\./);
    assert.doesNotMatch(html, /ops|openpe/);
  }
});

test('agent markup cannot inject HTML, unsafe navigation or remote image requests', () => {
  const html = render(
    '<script>alert(1)</script>\n\n<img src="https://example.com/track">\n\n[unsafe](javascript:alert%281%29) [file](file:///C:/secret) [relative](/api/state) [safe](https://example.com/data "Reference details")\n\n![Remote preview](https://example.com/image.png)',
  );
  assert.doesNotMatch(html, /<script|<img|javascript:|file:|href="\/api|src=/);
  assert.match(html, /<span>Remote preview<\/span>/);
  assert.match(
    html,
    /href="https:\/\/example.com\/data" target="_blank" rel="noopener noreferrer"/,
  );
  assert.match(html, /aria-description="https:\/\/example.com\/data"/);
  assert.doesNotMatch(html, /\stitle=|<title\b|role="tooltip"/);
});

test('formulas support dollar and LaTeX delimiters, including the reported output voltage', () => {
  const formula = String.raw`V_\text{OUT}\approx D V_\text{IN}`;
  for (const source of [`$${formula}$`, `\\(${formula}\\)`, `(${formula})`]) {
    const html = render(source);
    assert.match(html, /class="katex"/);
    assert.match(html, /<msub>/);
    assert.match(html, /<mo>≈<\/mo>/);
    assert.doesNotMatch(html, /katex-error/);
  }
  for (const source of [
    String.raw`\[\frac{V_\text{OUT}}{V_\text{IN}} = D\]`,
    '$$\nV_{OUT} = D V_{IN}\n$$',
    '```math\nV_{OUT} = D V_{IN}\n```',
  ]) {
    assert.match(render(source), /class="katex-display"/);
  }
});

test('math normalization preserves code, links, existing math and ordinary parentheses', () => {
  for (const source of [
    '`' + String.raw`\(V_\text{OUT}\)` + '`',
    '```latex\n' + String.raw`\(V_\text{OUT}\)` + '\n```',
    '~~~latex\n' + String.raw`\[V_\text{OUT}\]`,
    '    ' + String.raw`\(V_\text{OUT}\)`,
    String.raw`[formula \(V\)](https://example.com)`,
    String.raw`$f(x)=\text{value}(x)$`,
    'Q1 (IRF540N) switches at (20 kHz).',
  ])
    assert.equal(normalizeAgentMath(source), source);
  const html = render('`' + String.raw`\(V_\text{OUT}\)` + '`');
  assert.doesNotMatch(html, /class="katex"/);
});

test('partial, malformed and untrusted formulas cannot break or inject into a response', () => {
  const source = String.raw`Output: \(\frac{V_{OUT}}{V_{IN}}\).`;
  for (let end = 1; end <= source.length; end++)
    assert.doesNotThrow(() => render(source.slice(0, end)));
  const malformed = render('$\\frac{1}{$');
  assert.match(malformed, /katex-error/);
  assert.match(malformed, /aria-description="ParseError: KaTeX parse error:/);
  assert.doesNotMatch(malformed, /\stitle=|<title\b|role="tooltip"/);
  const html = render(
    String.raw`$\href{javascript:alert(1)}{click}\includegraphics{https://example.com/track}\htmlStyle{position:fixed}{x}$`,
  );
  assert.doesNotMatch(html, /<a\s|<img|style="[^"]*position:fixed/);
});
