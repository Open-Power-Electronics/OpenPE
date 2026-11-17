import test from 'node:test';
import assert from 'node:assert/strict';
import { materializedCircuitTree } from '../lib/circuit';
import { createProject } from '../lib/project';
import { toProjectDocument } from '../lib/project-document';
import { ownProject } from '../lib/immutable-project';
import { child, quote, type SExpr } from '../lib/sexpr';

function textNode(id: string, text: string, excluded?: string): SExpr {
  return [
    'text',
    quote(text),
    ['at', '10', '20', '0'],
    [
      'effects',
      ['font', ['size', '1.27', '1.27'], ['color', '12', '34', '56', '0.5'], 'bold', 'italic'],
      ['justify', 'left', 'top'],
      ['href', quote('https://example.org/note')],
    ],
    ['uuid', quote(id)],
    ...(excluded === undefined ? [] : [['exclude_from_sim', excluded] as SExpr]),
  ];
}

function textProject(...nodes: SExpr[]) {
  const project = createProject();
  project.schematic.original = materializedCircuitTree(project.schematic);
  project.schematic.original.push(...nodes);
  return project;
}

test('document text lookup retains first duplicate UUID metadata and original text order', () => {
  const id = '10000000-0000-4000-8000-000000000001';
  const first = textNode(id, 'First note', 'yes');
  const second = textNode(id, 'Second note', 'no');
  child(second, 'at')![1] = '30';
  const project = textProject(first, second);
  const texts = toProjectDocument(project).schematic.texts!;
  assert.deepEqual(
    texts.map((text) => [text.text, text.position, text.excludeFromSimulation]),
    [
      ['First note', { x: 10, y: 20 }, true],
      ['Second note', { x: 30, y: 20 }, true],
    ],
  );
  for (const text of texts) {
    assert.deepEqual(text.color, [12, 34, 56, 0.5]);
    assert.equal(text.bold, true);
    assert.equal(text.italic, true);
    assert.equal(text.href, 'https://example.org/note');
    assert.equal(text.anchor, 'start');
    assert.equal(text.vertical, 'top');
  }
  child(first, 'exclude_from_sim')![1] = 'no';
  assert.deepEqual(
    toProjectDocument(project).schematic.texts!.map((text) => text.excludeFromSimulation),
    [false, false],
  );
  first.splice(first.indexOf(child(first, 'exclude_from_sim')!), 1);
  assert.ok(
    toProjectDocument(project).schematic.texts!.every(
      (text) => !Object.hasOwn(text, 'excludeFromSimulation'),
    ),
  );
});

test('document texts validate the complete list before reading participation metadata', () => {
  const first = textNode('10000000-0000-4000-8000-000000000001', 'First', '"');
  const invalid = textNode('10000000-0000-4000-8000-000000000002', 'Invalid');
  child(invalid, 'at')![3] = '90';
  const project = textProject(first, invalid);
  assert.throws(() => toProjectDocument(project), {
    message:
      'Unsupported schematic text. Use horizontal, plain text with equal font dimensions in KiCad. The original file was not modified.',
  });
  child(invalid, 'at')![3] = '0';
  assert.throws(() => toProjectDocument(project), SyntaxError);
});

test('document text outputs stay independent and follow mutable or replaced native text', () => {
  const node = textNode('10000000-0000-4000-8000-000000000001', 'Original', 'yes');
  const project = textProject(node);
  Object.freeze(project.schematic.original);
  const before = toProjectDocument(project).schematic.texts!;
  before[0].text = 'Caller changed';
  before[0].position.x = 999;
  before[0].color![0] = 255;
  before.push({ ...before[0] });
  node[1] = quote('Current');
  child(node, 'at')![1] = '15';
  child(child(node, 'effects')!, 'font')!.push(['color', '1', '2', '3', '1']);
  assert.throws(() => toProjectDocument(project), /Unsupported schematic text/);
  child(child(node, 'effects')!, 'font')!.pop();
  const current = toProjectDocument(project).schematic.texts!;
  assert.equal(current.length, 1);
  assert.equal(current[0].text, 'Current');
  assert.equal(current[0].position.x, 15);
  assert.deepEqual(current[0].color, [12, 34, 56, 0.5]);

  const owned = ownProject(project);
  const publicText = toProjectDocument(owned).schematic.texts![0];
  publicText.position.x = 123;
  publicText.color![0] = 99;
  assert.equal(toProjectDocument(owned).schematic.texts![0].position.x, 15);
  assert.deepEqual(toProjectDocument(owned).schematic.texts![0].color, [12, 34, 56, 0.5]);
  const replacement = ownProject(
    {
      ...owned,
      schematic: {
        ...owned.schematic,
        original: [
          ...owned.schematic.original!.filter(
            (entry) => !Array.isArray(entry) || entry[0] !== 'text',
          ),
          textNode('10000000-0000-4000-8000-000000000002', 'Replacement', 'no'),
        ],
      },
    },
    owned,
  );
  assert.equal(toProjectDocument(replacement).schematic.texts![0].text, 'Replacement');
  assert.equal(toProjectDocument(replacement).schematic.texts![0].excludeFromSimulation, false);
});
