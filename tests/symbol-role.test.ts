import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolRole, symbolRoleColors } from '../lib/symbol-role';
import { parseSExpr, quote, type SExpr } from '../lib/sexpr';
import { createReferenceExample } from '../lib/reference-examples';
import { parseProject, serializeProject } from '../lib/project';
import { appearanceVariables, defaultAppearance } from '../lib/appearance';
import { partFootprint } from '../lib/library';

const library = (id: string): SExpr => ['symbol', quote(id)];

test('unassigned symbols are virtual and assigned symbols are physical, independently of library namespace', () => {
  for (const id of [
    'Simulation_SPICE:VDC',
    'Simulation_SPICE:VPULSE',
    'Simulation_SPICE:BSOURCE',
    'Simulation_SPICE:D',
    'Simulation_SPICE:DIODE',
    'Simulation_SPICE:NMOS',
    'Simulation_SPICE:NPN',
    'Simulation_SPICE:OPAMP',
    'Simulation_SPICE:Potentiometer',
    'Simulation_SPICE:IBIS_DEVICE',
    'Simulation_SPICE:Unknown',
    'Device:R',
    'Device:C',
    'Device:L',
    'Transistor_FET:IRF540N',
    'Regulator_Switching:LM2596S-5',
    'Custom:VPULSE',
  ]) {
    const symbol = library(id);
    assert.equal(symbolRole(symbol), 'virtual', id);
    symbol.push(['property', quote('Footprint'), quote('Test:Package')]);
    assert.equal(symbolRole(symbol), 'physical', id);
  }
  for (const id of ['power:GND', 'power:VCC', 'Simulation_SPICE:0'])
    assert.equal(symbolRole(library(id)), 'marker', id);
});

test('instance assignment overrides library defaults while local power markers retain their identity', () => {
  for (const id of ['Simulation_SPICE:VPULSE', 'Simulation_SPICE:D']) {
    const raw = parseSExpr(
      `(symbol (lib_id "${id}") (lib_name "local_variant") (property "Sim.Device" "V") (property "Footprint" "Test:Package"))`,
    );
    const part = { libId: 'local_variant', raw };
    assert.equal(symbolRole(library('local_variant'), part), 'physical');
    assert.equal(
      symbolRole(library('local_variant'), { ...part, fields: { Footprint: '' } }),
      'virtual',
    );
  }
  assert.equal(
    symbolRole(
      parseSExpr('(symbol "Device:D" (property "Sim.Device" "D") (property "Footprint" ""))'),
    ),
    'virtual',
  );
  const symbol = parseSExpr('(symbol "Device:R" (property "Footprint" "Test:Package"))');
  assert.equal(symbolRole(symbol), 'physical');
  assert.equal(symbolRole(symbol, { libId: 'Device:R', fields: {} }), 'virtual');
  assert.equal(symbolRole(symbol, { libId: 'Device:R', fields: { Footprint: '  ' } }), 'virtual');
  assert.equal(
    symbolRole(library('local'), {
      libId: 'local',
      raw: parseSExpr('(symbol (lib_id "power:GND") (lib_name "local"))'),
    }),
    'marker',
  );
});

test('Buck classification survives canonical round trips without mutating design data', () => {
  const project = createReferenceExample('reference-lm2598-to220-7-buck');
  const source = serializeProject(project);
  for (const candidate of [project, parseProject(source)]) {
    const { parts, libraries } = candidate.schematic;
    for (const part of parts) {
      const role = symbolRole(libraries[part.libId], part);
      if (role === 'marker') continue;
      assert.equal(role, partFootprint(part) ? 'physical' : 'virtual', part.ref);
    }
    assert.ok(parts.some((p) => p.libId === 'Device:R' && !partFootprint(p)));
  }
  assert.equal(serializeProject(project), source);
});

test('symbol colors follow actual custom canvas brightness independently of accent and foreground', () => {
  for (const [background, mode] of [
    ['#ffffff', 'light'],
    ['#101010', 'dark'],
  ] as const) {
    const appearance = structuredClone(defaultAppearance);
    appearance.profiles.shared.background = background;
    appearance.profiles.shared.accent = '#b45309';
    appearance.profiles.shared.foreground = '#b45309';
    const vars = appearanceVariables(appearance, mode === 'light' ? 'dark' : 'light');
    for (const [name, value] of Object.entries(symbolRoleColors[mode]))
      assert.equal(vars[name], value);
    assert.notEqual(vars['--symbol-physical'], vars['--symbol-virtual']);
  }
});
