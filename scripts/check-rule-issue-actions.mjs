import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

// Static React rendering and actual component handlers only. This does not
// start a browser or verify native keyboard defaults, layout or pointer hit areas.
const require = createRequire(import.meta.url);
const captureKey = '__openpeRuleIssueActions';
const result = await build({
  stdin: {
    contents: `export {default as RuleCheckPanel} from './components/RuleCheckPanel';`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom', 'react-dom/server'],
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'static-rule-host',
      setup(build) {
        build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
          path: 'jsx',
          namespace: 'rule-static',
        }));
        build.onLoad({ filter: /.*/, namespace: 'rule-static' }, () => ({
          loader: 'js',
          resolveDir: process.cwd(),
          contents: `const runtime=require(${JSON.stringify(require.resolve('react/jsx-runtime'))});
             exports.Fragment=runtime.Fragment;
             for(const name of ['jsx','jsxs']) exports[name]=(type,props,key)=>{
               if(typeof type==='string') globalThis[${JSON.stringify(captureKey)}].push({type,props});
               return runtime[name](type,props,key);
             };`,
        }));
        build.onLoad({ filter: /\.module\.css$/ }, () => ({
          loader: 'js',
          contents: 'export default new Proxy({}, {get:(_target,key)=>key});',
        }));
      },
    },
  ],
});
const compiled = new Module(path.resolve('scripts/.rule-issue-static.cjs'));
compiled.filename = path.resolve('scripts/.rule-issue-static.cjs');
compiled.paths = Module._nodeModulePaths(path.dirname(compiled.filename));
compiled._compile(result.outputFiles[0].text, compiled.filename);
const { RuleCheckPanel } = compiled.exports;
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const issue = {
  id: 'pin',
  ruleId: 'erc.unconnected-pin',
  severity: 'error',
  message: 'R1 pin <1> & net is unconnected.',
  objectIds: ['r1'],
  location: { x: 25.4, y: 20.32 },
};
const report = {
  kind: 'erc',
  complete: true,
  truncated: false,
  checkedRules: [issue.ruleId],
  issues: [issue],
  notes: [],
};
const baseline = structuredClone(report);
const selected = [];
function render(overrides = {}) {
  globalThis[captureKey] = [];
  const html = renderToStaticMarkup(
    React.createElement(RuleCheckPanel, {
      kind: 'erc',
      report,
      onRun() {},
      onSelectIssue: (value) => selected.push(value),
      onClose() {},
      ...overrides,
    }),
  );
  const records = globalThis[captureKey];
  const rows = records.filter(
    ({ type, props }) => type === 'button' && props['aria-label']?.startsWith('Locate issue: '),
  );
  const panel = records.find(
    ({ type, props }) => type === 'section' && props['aria-label'] === 'Rule',
  )?.props;
  return { html, rows, panel };
}
function key(key, nativeEvent = {}) {
  return {
    key,
    nativeEvent,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

try {
  const { html, rows, panel } = render();
  assert.doesNotMatch(html, /<dialog\b|aria-modal=/);
  assert.match(html, /<section\b[^>]*aria-label="Rule"/);
  assert.equal(rows.length, 1, 'Each issue exposes one locate action.');
  const action = rows[0].props;
  assert.equal(action.type, 'button');
  assert.equal(action.title, undefined, 'The issue text has no repeated tooltip.');
  assert.equal(action.disabled, false);
  assert.match(
    html,
    /<li><button\b[^>]*aria-label="Locate issue:/,
    'The full issue is a native row button.',
  );
  const rowHtml = html.match(/<li>([\s\S]*?)<\/li>/)?.[1];
  assert.equal(
    (rowHtml.match(/<button\b/g) ?? []).length,
    1,
    'No separate or nested locate action remains.',
  );
  assert.doesNotMatch(rowHtml, /<svg|<input|<a\b|lucide-locate-fixed/);
  assert.match(
    rowHtml,
    /R1 pin &lt;1&gt; &amp; net is unconnected\./,
    'Issue messages remain escaped text.',
  );
  assert.match(html, /lucide-erc\b/);
  assert.doesNotMatch(html, /lucide-drc\b|role="tab"/);
  assert.match(render({ kind: 'drc' }).html, /lucide-drc\b/);

  const severityCases = [
    { issue, expectedRule: 'Unconnected pin', expectedDescription: 'Error · Unconnected pin' },
    {
      issue: {
        ...issue,
        severity: 'warning',
        ruleId: 'erc.input-undriven',
        message: 'U1 input has no declared driver.',
      },
      expectedRule: 'Input undriven',
      expectedDescription: 'Warning · Input undriven',
    },
  ];
  for (const { issue: currentIssue, expectedRule, expectedDescription } of severityCases) {
    const rendered = render({ report: { ...report, issues: [currentIssue] } });
    const row = rendered.rows[0].props;
    assert.equal(
      row['data-severity'],
      currentIssue.severity,
      'Rows expose their severity for colour styling.',
    );
    assert.equal(
      row['aria-description'],
      expectedDescription,
      'Severity remains available to assistive technology.',
    );
    const visibleText = rendered.html
      .match(/<li>([\s\S]*?)<\/li>/)[1]
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    assert.ok(visibleText.includes(expectedRule), 'The rule name remains visible.');
    assert.doesNotMatch(
      visibleText,
      /\b(?:Error|Warning)\b/,
      'Rows do not repeat the visible severity label.',
    );
  }

  action.onClick();
  assert.equal(selected[0], issue, 'Click passes the exact issue to the existing locate adapter.');
  for (const name of ['Enter', ' ']) {
    const ordinary = key(name);
    action.onKeyDown(ordinary);
    assert.equal(
      ordinary.prevented,
      false,
      'Ordinary keyboard default activation remains eligible.',
    );
    for (const native of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = key(name, native);
      action.onKeyDown(event);
      assert.equal(event.prevented, true);
      assert.equal(event.stopped, true);
    }
  }
  panel.onCompositionStartCapture();
  action.onClick();
  assert.equal(
    selected.length,
    1,
    'Active composition blocks locating, including a click after an IME key.',
  );
  for (const name of ['Enter', ' ']) {
    const event = key(name);
    action.onKeyDown(event);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
  panel.onCompositionEndCapture();
  action.onClick();
  assert.equal(selected.length, 2, 'Ending composition restores ordinary issue activation.');

  for (const blocked of [
    { stale: true },
    { sourcePending: true },
    { busy: true },
    { blockedReason: 'Project is closing.' },
  ])
    assert.equal(
      render(blocked).rows[0].props.disabled,
      true,
      'Existing report/lifecycle gates disable the whole row.',
    );
  const noTarget = { ...issue, objectIds: [], location: undefined };
  assert.equal(render({ report: { ...report, issues: [noTarget] } }).rows[0].props.disabled, true);
  assert.equal(render({ report: { ...report, issues: [] } }).rows.length, 0);
  assert.deepEqual(
    report,
    baseline,
    'Presentation and handler inspection leave the report untouched.',
  );
  console.log(
    'PASS: static Rule issue rows, escaped messages, new icons, actual click/IME handlers and disabled gates (no browser/layout/native-keyboard evidence).',
  );
} finally {
  delete globalThis[captureKey];
}
