import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComponentProps, ReactElement } from 'react';
import { build } from 'esbuild';
import type LayoutAppearancePanel from '../components/LayoutAppearancePanel';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { defaultPCBSelectionFilters } from '../lib/pcb-selection';

// Inspect the actual JSX and invoke its callbacks without launching a browser.
// Only this component's hooks are synchronous; child components remain elements.
const bundled = await build({
  entryPoints: ['components/LayoutAppearancePanel.tsx'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'panel-hooks',
      setup(plugin) {
        plugin.onResolve({ filter: /^react$/ }, (args) =>
          args.importer.replaceAll('\\', '/').endsWith('/components/LayoutAppearancePanel.tsx')
            ? { path: 'panel-hooks', namespace: 'panel-hooks' }
            : undefined,
        );
        plugin.onLoad({ filter: /.*/, namespace: 'panel-hooks' }, () => ({
          contents: `export const useId=()=> 'nets-test', useRef=current=>({current}),
            useMemo=prepare=>prepare(), useLayoutEffect=effect=>effect();`,
        }));
      },
    },
  ],
});
const Panel: typeof LayoutAppearancePanel = (
  await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  )
).default;
type Props = ComponentProps<typeof LayoutAppearancePanel>;
type Node = ReactElement<Record<string, any>>;
function elements(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props.children)];
}
function fixture() {
  let highlighted = new Set<string>();
  let hidden = new Set(['gnd']);
  const originalHidden = hidden;
  const props: Props = {
    board: {
      layers: ['F.Cu', 'B.Cu'],
      nets: [
        { id: 'out', name: 'OUT' },
        { id: 'gnd', name: 'GND' },
      ],
    },
    displayLayers: ['F.Cu', 'B.Cu'],
    layers: defaultPCBDisplay(),
    onLayersChange() {},
    priorityLayer: 'F.Cu',
    onPriorityLayerChange() {},
    tab: 'nets',
    onTabChange() {},
    visualizationExpanded: true,
    onVisualizationExpandedChange() {},
    filters: defaultPCBSelectionFilters(),
    onFiltersChange() {},
    filtersExpanded: true,
    onFiltersExpandedChange() {},
    hiddenNets: hidden,
    onHiddenNetsChange(next) {
      hidden = next;
    },
    highlightNets: highlighted,
    onHighlightNetsChange(next) {
      highlighted = next;
    },
    netSearch: '',
    onNetSearchChange() {},
    netEdges: [{ netId: 'out' }, { netId: 'out' }],
  };
  const render = () =>
    elements(Panel({ ...props, hiddenNets: hidden, highlightNets: highlighted }));
  const control = (label: string) => {
    const found = render().find((node) => node.props['aria-label'] === label);
    assert.ok(found, label);
    return found.props;
  };
  return {
    props,
    render,
    control,
    originalHidden,
    highlighted: () => highlighted,
    hidden: () => hidden,
  };
}

test('net names replace highlights, toggle off, and leave airwire visibility unchanged', () => {
  const panel = fixture();
  const name = panel.control('Highlight OUT');
  assert.equal(name.type, 'button');
  assert.equal(name['aria-pressed'], false);
  name.onClick();
  assert.deepEqual([...panel.highlighted()], ['out']);
  assert.equal(panel.control('Highlight OUT')['aria-pressed'], true);
  panel.control('Highlight GND').onClick();
  assert.deepEqual([...panel.highlighted()], ['gnd']);
  panel.control('Highlight GND').onClick();
  assert.equal(panel.highlighted().size, 0);
  assert.equal(panel.hidden(), panel.originalHidden);
  assert.deepEqual([...panel.hidden()], ['gnd']);
});

test('net eyes change only visibility; rows contain one name button and no bulk control', () => {
  const panel = fixture();
  panel.control('Highlight OUT').onClick();
  panel.control('Show airwires for GND').onChange({ target: { checked: true } });
  assert.deepEqual([...panel.hidden()], []);
  panel.control('Show airwires for OUT').onChange({ target: { checked: false } });
  assert.deepEqual([...panel.hidden()], ['out']);
  assert.deepEqual([...panel.highlighted()], ['out']);
  assert.deepEqual([...panel.originalHidden], ['gnd'], 'Input sets remain immutable.');
  const nodes = panel.render();
  assert.equal(
    nodes.some((node) => node.props['aria-label'] === 'All nets'),
    false,
  );
  const rows = nodes.filter(
    (node) => node.props.className === 'layout-net-row editor-visibility-row',
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(elements(row).filter((node) => node.type === 'button').length, 1);
    assert.equal(elements(row).filter((node) => node.type === 'input').length, 1);
  }
  assert.equal(rows[0].props['data-active'], true);
  assert.equal(rows[1].props['data-active'], false);
  assert.deepEqual(
    nodes
      .filter((node) => node.props.className === 'layout-net-count')
      .map((node) => node.props.children),
    [2],
  );
});
