import test from 'node:test';
import assert from 'node:assert/strict';
import { modelPanelMatches, type ModelFindTarget } from '../components/model-panel-find';
import {
  findScopeAtPoint,
  isPanelFindShortcut,
  literalPanelMatches,
  panelFindLimit,
} from '../components/panel-find';

test('Model Find searches eligible scene labels literally once per object and bounds results', () => {
  const targets: ModelFindTarget[] = [
    { kind: 'footprint', id: 'r1', label: 'R1 · 10k · Fixture:R[1]' },
    { kind: 'footprint', id: 'r2', label: 'R2 · 10k · Fixture:R[2]' },
    { kind: 'solid', id: 'body', label: 'Heat spreader · box' },
  ];
  assert.deepEqual(
    modelPanelMatches(targets, 'r1').matches.map((item) => item.id),
    ['r1'],
  );
  assert.deepEqual(
    modelPanelMatches(targets, '[1]').matches.map((item) => item.id),
    ['r1'],
  );
  assert.equal(modelPanelMatches(targets, '10K').matches.length, 2);
  assert.equal(modelPanelMatches(targets, 'SPREADER').matches[0].kind, 'solid');
  assert.equal(modelPanelMatches(targets, '').matches.length, 0);
  const bounded = modelPanelMatches(
    Array.from({ length: panelFindLimit + 1 }, (_, index) => ({
      kind: 'solid' as const,
      id: String(index),
      label: 'Box',
    })),
    'box',
  );
  assert.equal(bounded.matches.length, panelFindLimit);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(targets[0], { kind: 'footprint', id: 'r1', label: 'R1 · 10k · Fixture:R[1]' });
});

const agent = { left: 0, right: 360, top: 40, bottom: 800 };
const preview = { left: 368, right: 1200, top: 40, bottom: 800 };

test('find follows the pointer region before keyboard focus and never selects a hidden pane', () => {
  assert.equal(findScopeAtPoint({ x: 100, y: 100 }, agent, preview, 'preview'), 'agent');
  assert.equal(findScopeAtPoint({ x: 800, y: 100 }, agent, preview, 'agent'), 'preview');
  assert.equal(findScopeAtPoint({ x: 360, y: 100 }, agent, preview, 'preview'), 'preview');
  assert.equal(findScopeAtPoint({ x: 100, y: 100 }, null, preview, 'agent'), 'preview');
  assert.equal(findScopeAtPoint(null, agent, null, 'preview'), 'agent');
  assert.equal(findScopeAtPoint({ x: 10, y: 10 }, null, null), null);
});

test('pane search is literal and case-insensitive, with exact offsets and no cross-block matches', () => {
  const blocks = ['Ω feedback, gain.[1] and GAIN.[1].', 'Independent paragraph.'];
  assert.deepEqual(literalPanelMatches(blocks, 'gain.[1]').matches, [
    { block: 0, from: 12, to: 20 },
    { block: 0, from: 25, to: 33 },
  ]);
  assert.equal(literalPanelMatches(blocks, 'gain.*').matches.length, 0);
  assert.equal(literalPanelMatches(['gain', 'marker'], 'gainmarker').matches.length, 0);
  assert.deepEqual(literalPanelMatches(['a  b'], '  ').matches, [{ block: 0, from: 1, to: 3 }]);
});

test('only supplied pane text is searched, including visible streamed prose and escaped literal markup', () => {
  const agentText = ['Visible streamed response: converter Ω', 'Literal <script>Ω</script>'];
  const previewText = ['R42', '12 V output'];
  assert.equal(literalPanelMatches(agentText, 'R42').matches.length, 0);
  assert.equal(literalPanelMatches(previewText, 'converter').matches.length, 0);
  assert.equal(literalPanelMatches(agentText, 'CONVERTER').matches.length, 1);
  assert.equal(literalPanelMatches(agentText, '<SCRIPT>Ω</SCRIPT>').matches.length, 1);
  assert.equal(literalPanelMatches(['😀 µH Ω'], 'ω').matches[0].from, 6);
});

test('matches and query length are bounded without combining content from other blocks', () => {
  const text = 'needle '.repeat(panelFindLimit + 2);
  const matches = literalPanelMatches([text], 'needle');
  assert.equal(matches.matches.length, panelFindLimit);
  assert.equal(matches.truncated, true);
  assert.deepEqual(literalPanelMatches(['needle'], ''), { matches: [], truncated: false });
  assert.equal(literalPanelMatches(['a'.repeat(512)], 'a'.repeat(513)).matches.length, 1);
});

test('Control/Command Find excludes IME, key code 229 and unrelated modifier chords', () => {
  const key = (extra: Partial<KeyboardEvent>) =>
    ({
      key: 'f',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 70,
      ...extra,
    }) as KeyboardEvent;
  assert.equal(isPanelFindShortcut(key({ ctrlKey: true })), true);
  assert.equal(isPanelFindShortcut(key({ metaKey: true })), true);
  for (const extra of [
    {},
    { ctrlKey: true, isComposing: true },
    { ctrlKey: true, keyCode: 229 },
    { ctrlKey: true, shiftKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, key: 's' },
  ])
    assert.equal(isPanelFindShortcut(key(extra)), false);
});
