import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ComponentProps, type KeyboardEvent, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PartProperties from '../components/PartProperties';
import SchematicSectionSwitch from '../components/SchematicSectionSwitch';
import Select from '../components/Select';
import { createPart, emptyCircuit } from '../lib/circuit';
import type { SchematicSectionView } from '../lib/schematic-section';

function switchFixture({
  value = 'all',
  composing = false,
  disabled = false,
  accepted = true,
}: {
  value?: SchematicSectionView;
  composing?: boolean;
  disabled?: boolean;
  accepted?: boolean;
} = {}) {
  const changes: SchematicSectionView[] = [];
  const composition = { current: composing };
  const element = SchematicSectionSwitch({
    value,
    disabled,
    composing: composition,
    onChange: (section) => {
      changes.push(section);
      return accepted;
    },
  }) as ReactElement<ComponentProps<'div'>>;
  const select = element.props.children as ReactElement<ComponentProps<typeof Select>>;
  function key(key: string, nativeEvent: { isComposing?: boolean; keyCode?: number } = {}) {
    const event = {
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
    element.props.onKeyDownCapture!(event as unknown as KeyboardEvent<HTMLDivElement>);
    return event;
  }
  function pointerOrClick(kind: 'onPointerDownCapture' | 'onClickCapture') {
    const event = {
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    if (kind === 'onPointerDownCapture')
      element.props.onPointerDownCapture!(
        event as unknown as Parameters<
          NonNullable<ComponentProps<'div'>['onPointerDownCapture']>
        >[0],
      );
    else
      element.props.onClickCapture!(
        event as unknown as Parameters<NonNullable<ComponentProps<'div'>['onClickCapture']>>[0],
      );
    return event;
  }
  return { element, select, changes, composition, key, pointerOrClick };
}

test('schematic section opening checks the draft guard and delegates navigation to shared Select', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']) {
    const accepted = switchFixture({ value: 'simulation' });
    const normal = accepted.key(key);
    assert.equal(normal.prevented, false);
    assert.equal(normal.stopped, false);
    assert.deepEqual(accepted.changes, ['simulation'], 'Opening only checks the current view.');
    const blocked = switchFixture({ accepted: false });
    const rejected = blocked.key(key);
    assert.equal(rejected.prevented, true);
    assert.equal(rejected.stopped, true);
    assert.deepEqual(blocked.changes, ['all']);
  }
  const disabled = switchFixture({ disabled: true });
  assert.equal(disabled.key('ArrowDown').prevented, true);
  assert.deepEqual(disabled.changes, []);
  const tab = switchFixture();
  assert.equal(tab.key('Tab').prevented, false);
  assert.deepEqual(tab.changes, []);
});

test('IME and key code 229 cannot switch the schematic section', () => {
  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    const fixture = switchFixture();
    const event = fixture.key('ArrowRight', nativeEvent);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(fixture.changes, []);
  }
  const fixture = switchFixture({ composing: true });
  for (const key of ['ArrowRight', 'Enter', ' ']) {
    assert.equal(fixture.key(key).prevented, true);
    assert.deepEqual(fixture.changes, []);
  }
  fixture.select.props.onChange('simulation');
  assert.equal(fixture.pointerOrClick('onPointerDownCapture').prevented, true);
  assert.equal(fixture.pointerOrClick('onClickCapture').stopped, true);
  assert.deepEqual(fixture.changes, []);
  fixture.composition.current = false;
  fixture.select.props.onChange('simulation');
  assert.deepEqual(fixture.changes, ['simulation']);
});

test('section pointer interaction retains input focus until the draft guard runs', () => {
  const blocked = switchFixture({ value: 'simulation', accepted: false });
  const pointer = blocked.pointerOrClick('onPointerDownCapture');
  assert.equal(pointer.prevented, true, 'A pending draft cannot blur before the guard runs.');
  assert.equal(pointer.stopped, true);
  const click = blocked.pointerOrClick('onClickCapture');
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
  assert.deepEqual(blocked.changes, ['simulation', 'simulation']);
  const accepted = switchFixture();
  assert.equal(accepted.pointerOrClick('onPointerDownCapture').prevented, false);
  assert.equal(accepted.pointerOrClick('onClickCapture').stopped, false);
});

test('compact footer Select exposes the three supported sections and rejects other values', () => {
  const fixture = switchFixture({ value: 'all' });
  assert.equal(fixture.select.type, Select);
  assert.equal(fixture.select.props.label, 'Schematic section');
  assert.equal(fixture.select.props.value, 'all');
  assert.equal(fixture.select.props.popupPlacement, 'top-end');
  assert.equal(fixture.select.props.popupMatchWidth, 'content');
  assert.deepEqual(
    fixture.select.props.options.map(({ value, label }) => [value, label]),
    [
      ['all', 'All'],
      ['hardware', 'Real'],
      ['simulation', 'Virtual'],
    ],
  );
  for (const next of ['simulation', 'hardware', 'all']) fixture.select.props.onChange(next);
  fixture.select.props.onChange('invalid');
  fixture.select.props.onChange('');
  assert.deepEqual(fixture.changes, ['simulation', 'hardware', 'all']);
  const disabled = switchFixture({ disabled: true });
  assert.equal(disabled.select.props.disabled, true);
  disabled.select.props.onChange('simulation');
  assert.deepEqual(disabled.changes, []);
});

test('component Properties omit the section picker for both Real and Virtual parts', () => {
  const circuit = emptyCircuit();
  for (const footprint of ['', 'Resistor_SMD:R_0805_2012Metric']) {
    const part = createPart(circuit, 'R', 0, 0);
    if (footprint) part.fields = { Footprint: footprint };
    const markup = renderToStaticMarkup(
      createElement(PartProperties, { circuit, part, onSave: () => true }),
    );
    assert.match(markup, /aria-label="Component reference"/);
    assert.doesNotMatch(markup, /aria-label="Schematic section"/);
  }
});
