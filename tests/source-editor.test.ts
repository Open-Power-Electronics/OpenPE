import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compartment, EditorState, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  ensureSyntaxTree,
  foldable,
  getIndentation,
  highlightingFor,
  matchBrackets,
  syntaxTree,
} from '@codemirror/language';
import { indentMore, indentLess, undo, redo } from '@codemirror/commands';
import { highlightTree } from '@lezer/highlight';
import {
  sourceDecorations,
  sourceExtensions,
  sourceLanguageForFile,
  sourcePresentationExtensions,
} from '../lib/source-editor';

test('source bracket colors and matching follow JSON structure, not bracket text in strings', () => {
  const text = '{\n  "embedded": "[{}] \\\"quoted\\\"",\n  "nested": [{"n": 42}]\n}';
  let state = EditorState.create({ doc: text, extensions: sourceExtensions() });
  // CodeMirror's initial parse has a wall-time budget. Complete this fixture
  // explicitly so parallel suite load cannot turn a color assertion into a
  // check of how much syntax happened to parse during construction.
  assert.ok(ensureSyntaxTree(state, text.length, 1000));
  state = state.update({}).state;
  const brackets: { text: string; className: string }[] = [];
  sourceDecorations(state, [{ from: 0, to: text.length }]).between(
    0,
    text.length,
    (from, to, value) => {
      if (value.spec.class.startsWith('source-bracket-'))
        brackets.push({ text: text.slice(from, to), className: value.spec.class });
    },
  );
  assert.deepEqual(brackets, [
    { text: '{', className: 'source-bracket-0' },
    { text: '[', className: 'source-bracket-1' },
    { text: '{', className: 'source-bracket-2' },
    { text: '}', className: 'source-bracket-2' },
    { text: ']', className: 'source-bracket-1' },
    { text: '}', className: 'source-bracket-0' },
  ]);
  const match = matchBrackets(state, 0, 1);
  assert.equal(match?.matched, true);
  assert.equal(match?.end?.from, text.length - 1);
  assert.equal(
    state.doc.toString(),
    text,
    'Display decorations must not rewrite whitespace or strings.',
  );
});

test('source guides honor tab stops and limit decorations to visible lines of a large draft', () => {
  const text = '[\n' + '  {"n": [1, 2]},\n'.repeat(3000) + '  {"n": []}\n]';
  let state = EditorState.create({ doc: text, extensions: sourceExtensions() });
  const line = state.doc.line(1500);
  assert.ok(ensureSyntaxTree(state, line.to, 1000));
  state = state.update({}).state;
  const decorations = sourceDecorations(state, [{ from: line.from, to: line.to }]);
  let count = 0;
  decorations.between(0, text.length, (from, to) => {
    count++;
    assert.ok(from >= line.from && to <= line.to);
  });
  assert.equal(count, 5, 'One indent guide and four structural brackets in the rendered line.');
  const tabs = EditorState.create({ doc: ' \t  "n": 2', extensions: sourceExtensions() });
  sourceDecorations(tabs, [{ from: 0, to: tabs.doc.length }]).between(
    0,
    tabs.doc.length,
    (_from, _to, value) => {
      assert.equal(value.spec.attributes.style, '--source-indent-width: 4ch');
    },
  );
});

test('source indentation and local undo/redo preserve incomplete JSON drafts', () => {
  const original = '{\n  "value":\n}';
  let state = EditorState.create({
    doc: original,
    selection: { anchor: 2 },
    extensions: sourceExtensions(),
  });
  const target = {
    get state() {
      return state;
    },
    dispatch: (transaction: Transaction) => {
      state = transaction.state;
    },
  };
  assert.equal(indentMore(target), true);
  assert.equal(state.doc.line(2).text, '    "value":');
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), original);
  assert.equal(redo(target), true);
  assert.equal(indentLess(target), true);
  assert.equal(state.doc.toString(), original);
});

test('source display changes preserve exact draft text, selection and text undo history', () => {
  const original = '{\n  "value":\n}';
  const presentation = new Compartment();
  let state = EditorState.create({
    doc: original,
    selection: { anchor: 2 },
    extensions: sourceExtensions(presentation.of(sourcePresentationExtensions())),
  });
  const target = {
    get state() {
      return state;
    },
    dispatch: (transaction: Transaction) => {
      state = transaction.state;
    },
  };
  assert.equal(indentMore(target), true);
  const draft = state.doc.toString();
  const selection = state.selection;
  for (const options of [
    { lineNumbers: false, whitespace: false, wordWrap: true },
    { lineNumbers: true, whitespace: true, wordWrap: false },
  ]) {
    const update = state.update({
      effects: presentation.reconfigure(sourcePresentationExtensions(options)),
    });
    assert.equal(
      update.docChanged,
      false,
      'Display changes must never create a pending Source edit.',
    );
    state = update.state;
    assert.equal(state.doc.toString(), draft);
    assert.ok(state.selection.eq(selection));
    assert.equal(
      state
        .facet(EditorView.contentAttributes)
        .some(
          (attributes) => typeof attributes === 'object' && attributes.class === 'cm-lineWrapping',
        ),
      options.wordWrap,
    );
  }
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), original);
  assert.equal(redo(target), true);
  assert.equal(state.doc.toString(), draft);
});

test('native project files select JSON, KiCad S-expression or plain text without rewriting source', () => {
  for (const name of ['circuit.kicad_pro', 'circuit.kicad_prl', 'settings.json'])
    assert.equal(sourceLanguageForFile(name), 'json');
  for (const name of ['circuit.kicad_sch', 'circuit.kicad_pcb', 'sym-lib-table', 'fp-lib-table'])
    assert.equal(sourceLanguageForFile(name), 'sexpr');
  assert.equal(sourceLanguageForFile('models/controller.lib'), 'text');
  const text = '(kicad_sch\n  (version 20260101)\n  (text "(not brackets) \\"quoted\\"")\n)';
  const state = EditorState.create({
    doc: text,
    extensions: sourceExtensions(undefined, 'circuit.kicad_sch'),
  });
  const tokens: { text: string; name: string }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (!node.type.isTop) tokens.push({ text: text.slice(node.from, node.to), name: node.name });
    },
  });
  assert.equal(state.doc.toString(), text);
  assert.equal(tokens.filter((token) => token.name.startsWith('parenthesis')).length, 6);
  assert.ok(
    tokens.some((token) => token.name === 'string' && token.text.includes('(not brackets)')),
  );
  assert.deepEqual(foldable(state, 0, state.doc.line(1).to), { from: 1, to: text.length - 1 });
  assert.equal(matchBrackets(state, 0, 1)?.end?.from, text.length - 1);
  assert.equal(getIndentation(state, state.doc.line(2).from), 2);
  assert.equal(getIndentation(state, state.doc.line(4).from), 0);
});

test('OpenSCAD sources receive semantic highlighting, bracket structure and statement indentation', () => {
  assert.equal(sourceLanguageForFile('emc-flyback.scad'), 'scad');
  assert.equal(sourceLanguageForFile('cad/Enclosure.SCAD'), 'scad');
  const text = [
    'include <lib/parts.scad>',
    '/* Panel',
    '   "not a string" { */',
    '$fn = 96; // segments',
    'label = "a // b";',
    'module drilled_panel(size, holes) {',
    '  difference() {',
    '    cube(size, center = true);',
    '    for (hole = holes)',
    '      translate([hole[0], hole[1], 0])',
    '        cylinder(h = 2e-1, d = hole[2], center = undef == false);',
    '  }',
    '}',
  ].join('\n');
  let state = EditorState.create({
    doc: text,
    extensions: sourceExtensions(undefined, 'enclosure.scad'),
  });
  assert.ok(ensureSyntaxTree(state, text.length, 1000));
  state = state.update({}).state;
  assert.equal(state.doc.toString(), text);

  const spans: { from: number; text: string; className: string }[] = [];
  highlightTree(
    syntaxTree(state),
    { style: (tags) => highlightingFor(state, tags) },
    (from, to, className) => spans.push({ from, text: text.slice(from, to), className }),
  );
  const classOf = (token: string) => {
    const classes = new Set(spans.filter((span) => span.text === token).map((span) => span.className));
    assert.equal(classes.size, 1, `${token} has exactly one highlight class.`);
    return [...classes][0];
  };
  for (const [token, className] of [
    ['include', 'source-token-keyword'],
    ['<lib/parts.scad>', 'source-token-string'],
    ['/* Panel', 'source-token-comment'],
    ['   "not a string" { */', 'source-token-comment'],
    ['// segments', 'source-token-comment'],
    ['$fn', 'source-token-literal'],
    ['96', 'source-token-number'],
    ['"a // b"', 'source-token-string'],
    ['module', 'source-token-keyword'],
    ['for', 'source-token-keyword'],
    ['drilled_panel', 'source-token-function'],
    ['difference', 'source-token-function'],
    ['cube', 'source-token-function'],
    ['translate', 'source-token-function'],
    ['cylinder', 'source-token-function'],
    ['label', 'source-token-key'],
    ['center', 'source-token-key'],
    ['hole', 'source-token-key'],
    ['2e-1', 'source-token-number'],
    ['true', 'source-token-literal'],
    ['undef', 'source-token-literal'],
    ['false', 'source-token-literal'],
    [';', 'source-token-punctuation'],
  ])
    assert.equal(classOf(token), className, token);
  assert.ok(
    !spans.some((span) => ['size', 'holes'].includes(span.text)),
    'Ordinary identifiers keep the body text colour.',
  );

  const translate = state.doc.line(10);
  assert.deepEqual(
    spans
      .filter((span) => span.from >= translate.from && span.from < translate.to)
      .filter((span) => /^[()[\]]$/.test(span.text))
      .map((span) => `${span.text} ${span.className}`),
    [
      '( source-bracket-2',
      '[ source-bracket-0',
      '[ source-bracket-1',
      '] source-bracket-1',
      '[ source-bracket-1',
      '] source-bracket-1',
      '] source-bracket-0',
      ') source-bracket-2',
    ],
  );

  const definition = state.doc.line(6);
  const block = definition.from + definition.text.indexOf('{');
  assert.deepEqual(foldable(state, definition.from, definition.to), {
    from: block + 1,
    to: text.length - 1,
  });
  assert.equal(foldable(state, state.doc.line(3).from, state.doc.line(3).to), null);
  assert.equal(matchBrackets(state, block, 1)?.end?.from, text.length - 1);
  assert.deepEqual(
    Array.from({ length: state.doc.lines }, (_, index) =>
      getIndentation(state, state.doc.line(index + 1).from),
    ),
    [0, 0, null, 0, 0, 0, 2, 4, 4, 6, 8, 2, 0],
  );
});
