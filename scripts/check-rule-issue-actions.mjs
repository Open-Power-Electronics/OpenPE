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
    contents: `
      export {default as RuleCheckPanel} from './components/RuleCheckPanel';
      export {default as RuleSettings} from './components/RuleSettings';
      export {default as RuleStatus} from './components/RuleStatus';
      export {ruleLimitDrafts} from './components/RuleLimits';
      export {workbenchPCBDesignRules} from './lib/design-rule-checks';
    `,
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
        build.onResolve({ filter: /^react$/ }, ({ importer }) =>
          path.basename(importer) === 'RuleSettings.tsx'
            ? { path: 'react', namespace: 'rule-static-ref' }
            : undefined,
        );
        build.onLoad({ filter: /.*/, namespace: 'rule-static-ref' }, () => ({
          loader: 'js',
          contents: `const react = require('react');
            module.exports = {...react, useImperativeHandle(ref, create) {
              if (ref) ref.current = create();
            }};`,
        }));
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
               if(typeof type==='string'||props.label==='Add DRC setting') globalThis[${JSON.stringify(captureKey)}].push({type,props});
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
const { RuleCheckPanel, RuleSettings, RuleStatus, ruleLimitDrafts, workbenchPCBDesignRules } =
  compiled.exports;
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
  return { html, rows, panel, records };
}
function key(key, nativeEvent = {}) {
  return {
    key,
    nativeEvent,
    prevented: false,
    stopped: false,
    get defaultPrevented() {
      return this.prevented;
    },
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
  assert.match(html, /<h2\b[^>]*>ERC<\/h2>/);
  assert.doesNotMatch(html, /role="tab"/);
  const noFindings = { ...report, issues: [] };
  const clearResult = render({ report: noFindings }).html;
  assert.match(clearResult, /data-fit-content="true"/);
  assert.match(
    render({ kind: 'drc', report: { ...noFindings, kind: 'drc' } }).html,
    /data-fit-content="true"/,
  );
  assert.match(clearResult, /lucide-circle-check/);
  assert.match(clearResult, /No violations<\/p>/);
  assert.doesNotMatch(clearResult, /data-count-state=|lucide-(?:circle|triangle)-alert/);
  const partialResult = render({ report: { ...noFindings, truncated: true } }).html;
  assert.match(partialResult, /Partial report/);
  assert.match(partialResult, /0 errors/);
  assert.match(partialResult, /data-count-state="neutral"><svg[^>]*lucide-triangle-alert/);
  assert.doesNotMatch(partialResult, /data-fit-content|lucide-circle-check|No violations/);
  const pendingResult = render({ report: noFindings, stale: true }).html;
  assert.match(pendingResult, /— errors/);
  assert.doesNotMatch(pendingResult, /data-fit-content|lucide-circle-check|No violations|0 errors/);
  const warningReport = { ...report, issues: [{ ...issue, severity: 'warning' }] };
  const warningResult = render({ report: warningReport }).html;
  assert.match(warningResult, /data-count-state="clear"/);
  assert.match(warningResult, /data-count-state="warning"/);
  assert.match(warningResult, /lucide-triangle-alert/);
  assert.doesNotMatch(warningResult, /data-fit-content|No violations/);
  const footer = (state, result) =>
    renderToStaticMarkup(
      React.createElement(RuleStatus, {
        kind: 'erc',
        state,
        report: result,
        expanded: false,
        disabled: false,
        onToggle() {},
      }),
    );
  const clearFooter = footer('ready', noFindings);
  assert.match(clearFooter, /lucide-circle-check/);
  assert.match(clearFooter, /data-rule-warnings="0"[^>]*><svg[^>]*lucide-triangle-alert/);
  assert.doesNotMatch(clearFooter, /lucide-circle-x/);
  assert.match(footer('ready', warningReport), /lucide-triangle-alert/);
  const partialFooter = footer('ready', { ...noFindings, complete: false });
  assert.match(partialFooter, /aria-description="[^"]*Partial report"/);
  assert.doesNotMatch(partialFooter, /lucide-circle-check/);
  const staleFooter = footer('stale', noFindings);
  assert.match(staleFooter, /data-rule-errors="unknown"/);
  assert.match(staleFooter, /data-rule-warnings="unknown"[^>]*><svg[^>]*lucide-triangle-alert/);
  let settingsOpened = 0;
  const drc = render({
    kind: 'drc',
    onOpenSettings: () => settingsOpened++,
  });
  assert.match(drc.html, /<h2\b[^>]*>DRC<\/h2>/);
  assert.doesNotMatch(drc.html, /severity"|role="(?:switch|tab|tabpanel|tablist)"/);
  assert.deepEqual(
    drc.records
      .filter(({ type, props }) => type === 'input' && props.type === 'number')
      .map(({ props }) => props['aria-label']),
    [
      'Minimum copper clearance (board-wide) (mm)',
      'Minimum track width (mm)',
      'Copper to board edge (mm)',
      'Minimum through-hole diameter (mm)',
      'Minimum via diameter (mm)',
    ],
  );
  assert.match(drc.html, /aria-label="Minimum via diameter \(mm\)"[^>]*value="0\.20"/);
  assert.match(drc.html, /role="combobox" aria-label="Add DRC setting"/);
  const retainedDRCQuickLimits = { current: [] };
  const renderQuickLimits = () => render({ kind: 'drc', retainedDRCQuickLimits });
  const getAddSetting = ({ records }) =>
    records.find(({ props }) => props.label === 'Add DRC setting').props;
  const initialQuickLimits = renderQuickLimits();
  const addSetting = getAddSetting(initialQuickLimits);
  assert.equal(addSetting.popupClassName, 'addQuickLimitMenu');
  assert.deepEqual(
    addSetting.options.map(({ value }) => value),
    ['minAnnularRing', 'copperToHole', 'holeToHole', 'minSilkClearance'],
  );
  initialQuickLimits.panel.onCompositionStartCapture();
  addSetting.onChange('minAnnularRing');
  assert.deepEqual(retainedDRCQuickLimits.current, []);
  initialQuickLimits.panel.onCompositionEndCapture();
  addSetting.onChange('minTrackWidth');
  assert.deepEqual(retainedDRCQuickLimits.current, []);
  addSetting.onChange('minAnnularRing');
  assert.deepEqual(retainedDRCQuickLimits.current, ['minAnnularRing']);
  const reopenedQuickLimits = renderQuickLimits();
  assert.match(
    reopenedQuickLimits.html,
    /aria-label="Minimum annular ring \(mm\)"[^>]*value="0\.05"/,
  );
  const reopenedAddSetting = getAddSetting(reopenedQuickLimits);
  assert.ok(!reopenedAddSetting.options.some(({ value }) => value === 'minAnnularRing'));
  reopenedAddSetting.onChange('holeToHole');
  assert.deepEqual(retainedDRCQuickLimits.current, ['minAnnularRing', 'holeToHole']);
  const clearanceIssue = {
    ...issue,
    ruleId: 'pcb.clearance',
    message:
      'Saved zone fill to Footprint pad 1 clearance is 0.24 mm; requires 0.25 mm (zone GND · F.Cu).',
    objectIds: ['zone', 'pad'],
  };
  const drcWithObjects = {
    kind: 'drc',
    report: { ...report, kind: 'drc', issues: [clearanceIssue] },
    drcSource: {
      schematic: { parts: [{ id: 'connector', ref: 'J1' }] },
      pcb: {
        id: 'board',
        layers: ['F.Cu', 'B.Cu'],
        nets: [
          { id: 'gnd', name: 'GND' },
          { id: 'out', name: 'VOUT' },
        ],
        tracks: [],
        vias: [],
        graphics: [],
        zones: [{ id: 'zone', netId: 'gnd', layer: 'F.Cu' }],
        footprints: [
          {
            id: 'footprint',
            symbolId: 'connector',
            side: 'front',
            pads: [{ id: 'pad', number: '1', type: 'smd', layers: ['F.Cu'], netId: 'out' }],
            graphics: [],
          },
        ],
      },
    },
  };
  const clearanceRow = render(drcWithObjects).rows[0].props;
  assert.equal(clearanceRow['aria-label'], `Locate issue: ${clearanceIssue.message}`);
  assert.equal(
    clearanceRow['aria-description'],
    'Error · Clearance · Net GND · Net VOUT · Layer F.Cu · Zone · J1 pad 1',
  );
  const clearanceHtml = render(drcWithObjects).html;
  assert.deepEqual(
    [...clearanceHtml.matchAll(/data-kind="(net|layer|object)">([^<]+)<\/span>/g)].map(
      ([, kind, text]) => [kind, text],
    ),
    [
      ['net', 'GND'],
      ['net', 'VOUT'],
      ['layer', 'F.Cu'],
      ['object', 'Zone'],
      ['object', 'J1 pad 1'],
    ],
  );
  assert.match(clearanceHtml, /class="message">0\.24 mm; requires 0\.25 mm\.<\/span>/);
  const staleClearance = render({ ...drcWithObjects, stale: true }).html;
  assert.doesNotMatch(staleClearance, /class="issueTag"/);
  assert.ok(staleClearance.includes(`class="message">${clearanceIssue.message}</span>`));
  const openSettings = drc.records.find(
    ({ props }) => props['aria-label'] === 'DRC settings',
  ).props;
  openSettings.onClick();
  drc.panel.onCompositionStartCapture();
  openSettings.onClick();
  assert.equal(settingsOpened, 1);
  drc.panel.onCompositionEndCapture();

  function renderRuleSettings(overrides = {}) {
    const ref = { current: null };
    globalThis[captureKey] = [];
    const html = renderToStaticMarkup(
      React.createElement(RuleSettings, {
        ref,
        initialTab: 'Copper & Routing',
        erc: {},
        drc: workbenchPCBDesignRules,
        retainedDraft: { current: null },
        blockedReason: '',
        onApply: () => true,
        ...overrides,
      }),
    );
    return { html, controls: globalThis[captureKey], actions: ref.current };
  }
  const { html: ruleSettings, controls: ruleControls } = renderRuleSettings();
  const ruleTabs = ruleControls
    .filter(({ props }) => props.role === 'tab')
    .map(({ props }) => props);
  assert.match(ruleSettings, /class="editor-dock-tabs editor-visualization-tabs settingsTabs"/);
  assert.deepEqual(
    ruleTabs.map(({ children }) => children),
    ['Schematic', 'Copper & Routing', 'Holes & Vias', 'Board & Placement', 'Silkscreen'],
  );
  for (const tab of ruleTabs) {
    assert.equal(tab.className, 'editor-dock-tab');
    const linked = ruleControls.find(({ props }) => props.id === tab['aria-controls']).props;
    assert.equal(linked['aria-labelledby'], tab.id);
    assert.equal(linked.hidden, tab.children !== 'Copper & Routing');
  }
  const focusedTabs = [];
  for (const nativeEvent of [{ keyCode: 229 }, {}]) {
    const next = key('ArrowRight', nativeEvent);
    next.currentTarget = {
      parentElement: {
        querySelectorAll: () =>
          ruleTabs.map((tab) => ({ focus: () => focusedTabs.push(tab.children) })),
      },
    };
    ruleTabs[1].onKeyDown(next);
    assert.equal(next.prevented, true);
  }
  assert.deepEqual(focusedTabs, ['Holes & Vias'], 'IME does not move tab focus.');
  assert.deepEqual(
    ruleControls
      .filter(({ type, props }) => type === 'input' && props.type === 'number')
      .map(({ props }) => props['aria-label']),
    [
      'Minimum copper clearance (board-wide) (mm)',
      'Minimum track width (mm)',
      'Minimum through-hole diameter (mm)',
      'Copper to hole (mm)',
      'Hole to hole (mm)',
      'Minimum via diameter (mm)',
      'Minimum annular ring (mm)',
      'Copper to board edge (mm)',
      'Minimum silkscreen clearance (mm)',
      'Minimum silkscreen text height (mm)',
      'Minimum silkscreen text thickness (mm)',
    ],
  );
  assert.deepEqual(
    ruleControls
      .filter(({ props }) => props.role === 'group')
      .map(({ props }) => props['aria-label']),
    [
      'Connectivity',
      'Wires & markers',
      'Symbols',
      'Clearance & width',
      'Connectivity',
      'Drill size & spacing',
      'Via & pad copper',
      'Outline & keepouts',
      'Footprint courtyards',
    ],
  );
  const severityStates = (controls) =>
    new Map(
      controls
        .filter(
          ({ props }) => props.role === 'combobox' && props['aria-label']?.endsWith(' severity'),
        )
        .map(({ props }) => [props['aria-label'], props['aria-description']]),
    );
  const currentSeverities = severityStates(ruleControls);
  assert.equal(currentSeverities.size, 31);
  for (const name of [
    'Copper shorts severity',
    'Unrouted connections severity',
    'Board outline severity',
    'Keepout violations severity',
    'Malformed courtyards severity',
    'Courtyard overlap severity',
  ]) {
    assert.equal(currentSeverities.get(name), 'Error');
  }
  assert.equal(currentSeverities.get('Minimum copper clearance (board-wide) severity'), 'Error');
  assert.equal(currentSeverities.get('Dangling wire severity'), 'Warning');
  assert.equal(currentSeverities.get('Output conflict severity'), 'Error');
  assert.equal(currentSeverities.get('Connected no-connect marker severity'), 'Error');
  const severityIcon = (name) =>
    ruleControls.find(({ props }) => props.role === 'combobox' && props['aria-label'] === name)
      .props.children[0]?.props;
  assert.equal(
    severityIcon('Minimum copper clearance (board-wide) severity').className,
    'severityError',
  );
  assert.equal(severityIcon('Dangling wire severity').className, 'severityWarning');
  assert.equal(severityIcon('Dangling wire severity')['aria-hidden'], 'true');
  assert.equal(severityIcon('Output conflict severity').className, 'severityError');
  assert.doesNotMatch(
    ruleSettings,
    /<select\b|>Clearance sources<|KiCad reference|Apply rules|>Default<|Error \/ Warning/,
  );
  const overriddenSeverities = severityStates(
    renderRuleSettings({
      erc: { 'erc.output-conflict': 'warning' },
      drc: { ...workbenchPCBDesignRules, severities: { 'pcb.clearance': 'ignore' } },
    }).controls,
  );
  assert.equal(overriddenSeverities.get('Output conflict severity'), 'Warning');
  assert.equal(overriddenSeverities.get('Minimum copper clearance (board-wide) severity'), 'Off');
  const draft = {
    erc: { 'erc.wire-dangling': 'warning' },
    limits: ruleLimitDrafts(workbenchPCBDesignRules),
    severities: {},
  };
  const applied = [];
  const onApply = (erc, drc) => {
    applied.push({ erc, drc });
    return true;
  };
  const invalid = renderRuleSettings({
    retainedDraft: { current: { ...draft, limits: { ...draft.limits, clearance: '1000.1' } } },
    onApply,
  });
  assert.equal(invalid.actions.apply(), false);
  const valid = renderRuleSettings({ retainedDraft: { current: draft }, onApply });
  const ruleEditor = valid.controls.find(({ props }) => props.onCompositionStartCapture).props;
  ruleEditor.onCompositionStartCapture();
  assert.equal(valid.actions.isComposing(), true);
  assert.equal(valid.actions.apply(), false);
  assert.equal(applied.length, 0);
  ruleEditor.onCompositionEndCapture();
  assert.equal(valid.actions.apply(), true);
  assert.deepEqual(applied, [{ erc: draft.erc, drc: workbenchPCBDesignRules }]);

  assert.doesNotMatch(ruleSettings, /Net classes|Conditional rules|Saved zones/);
  assert.equal(applied.at(-1).drc.useKiCadClearance, true);
  assert.equal(applied.at(-1).drc.useZoneClearance, false);

  const retainedReset = {
    current: { ...draft, limits: { ...draft.limits, clearance: '1000.1' } },
  };
  const customizedRules = {
    erc: draft.erc,
    drc: {
      ...workbenchPCBDesignRules,
      clearance: 0.4,
      scopes: ['clearance'],
      severities: { 'pcb.clearance': 'warning' },
    },
    retainedDraft: retainedReset,
    onApply,
  };
  const beforeReset = renderRuleSettings(customizedRules);
  const reset = beforeReset.controls.find(
    ({ type, props }) => type === 'button' && props['aria-label'] === 'Reset to default',
  ).props;
  assert.equal(reset.title, 'Reset to default');
  assert.equal(reset.children.props['aria-hidden'], 'true');
  assert.match(beforeReset.html, /lucide-rotate-ccw/);
  const resetEditor = beforeReset.controls.find(
    ({ props }) => props.onCompositionStartCapture,
  ).props;
  const imeKey = key('Enter', { keyCode: 229 });
  reset.onKeyDown(imeKey);
  assert.equal(imeKey.prevented, true);
  resetEditor.onCompositionStartCapture();
  let keptInputFocus = false;
  reset.onPointerDown({
    preventDefault: () => {
      keptInputFocus = true;
    },
  });
  reset.onClick();
  assert.equal(keptInputFocus, true);
  assert.equal(retainedReset.current.limits.clearance, '1000.1');
  resetEditor.onCompositionEndCapture();

  const appliedBeforeReset = applied.length;
  reset.onClick();
  assert.equal(applied.length, appliedBeforeReset);
  assert.equal(
    retainedReset.current.limits.clearance,
    '1000.1',
    'Opening confirmation retains the draft.',
  );
  retainedReset.current = {
    erc: {},
    limits: ruleLimitDrafts(workbenchPCBDesignRules),
    severities: {},
    resetToDefault: true,
  };
  const rejectedReset = renderRuleSettings({ ...customizedRules, onApply: () => false });
  assert.equal(rejectedReset.actions.apply(), false);
  assert.equal(retainedReset.current.resetToDefault, true);
  const reopenedReset = renderRuleSettings(customizedRules);
  assert.equal(reopenedReset.actions.apply(), true);
  assert.deepEqual(applied.at(-1), { erc: {}, drc: workbenchPCBDesignRules });
  assert.equal(retainedReset.current, null);

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
    'PASS: static Rule titles and issue rows, escaped messages, actual click/IME handlers and disabled gates (no browser/layout/native-keyboard evidence).',
  );
} finally {
  delete globalThis[captureKey];
}
