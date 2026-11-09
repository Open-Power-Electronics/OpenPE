import type { Circuit, Part } from './circuit';
import {
  primitiveInitialCondition,
  spiceInitialConditions,
  type SpiceInitialCondition,
} from './simulation-initial-conditions';
import {
  activePassiveModel,
  canSelectPassiveSimulationModel,
  passiveConnectorSymbol,
  assertSimulationModelConfiguration,
  effectiveSimulationModelFields,
} from './simulation-model-source';
import { displayPartValue, partFields, unitGraphics } from './library';
import { child, children, val } from './sexpr';
import {
  passiveValue,
  spiceNets,
  type SpiceDeck,
  type SpiceTrace,
  type TransientConfig,
} from './spice';
import bundled from './buck-simulation.json';
import { participatesInSimulation, simulationParts } from './simulation-participation';
import {
  simulationSourceExpression,
  simulationSourceValues,
  sourceParameterSpecs,
} from './simulation-source-parameters';

const BUCK_MOSFET = 'Transistor_FET:IRF540N';
const BUCK_DC = 'Simulation_SPICE:VDC';
const BUCK_PULSE = 'Simulation_SPICE:VPULSE';
export const isModelBuck = (d: Circuit) => simulationParts(d).some((p) => p.libId === BUCK_MOSFET);
const pins = bundled.pins as Record<string, string>;
const permitted = new Set([
  'Sim.Device',
  'Sim.Type',
  'Sim.Pins',
  'Sim.Params',
  'Sim.Library',
  'Sim.Name',
]);
const defaults: Record<string, { device: string; type?: string; roles: string[] }> = {
  'Device:R': { device: 'R', type: '=', roles: ['+', '-'] },
  'Device:C': { device: 'C', type: '=', roles: ['+', '-'] },
  'Device:L': { device: 'L', type: '=', roles: ['+', '-'] },
  [BUCK_DC]: { device: 'V', type: 'DC', roles: ['+', '-'] },
  [BUCK_PULSE]: { device: 'V', type: 'PULSE', roles: ['+', '-'] },
  'Simulation_SPICE:D': { device: 'D', roles: ['K', 'A'] },
  [BUCK_MOSFET]: { device: 'NMOS', type: 'VDMOS', roles: ['G', 'D', 'S'] },
  'power:GND': { device: '', roles: ['0'] },
};

function basicDevice(d: Circuit, p: Part) {
  if (p.libId !== passiveConnectorSymbol) return defaults[p.libId];
  const device = activePassiveModel(partFields(p));
  return device && canSelectPassiveSimulationModel(p, d)
    ? { device, type: '=', roles: ['+', '-'] }
    : undefined;
}

function fields(d: Circuit, p: Part) {
  const basic = basicDevice(d, p);
  return effectiveSimulationModelFields(
    p,
    {
      ...Object.fromEntries(
        children(d.libraries[p.libId], 'property').map((v) => [val(v), val(v, 2)]),
      ),
      ...partFields(p),
    },
    basic
      ? {
          'Sim.Device': basic.device,
          ...(basic.type ? { 'Sim.Type': basic.type } : {}),
          'Sim.Pins': basic.roles.map((role, i) => `${i + 1}=${role}`).join(' '),
        }
      : undefined,
  );
}
function parameters(text: string, allowed: string[]) {
  const result: Record<string, number> = {};
  for (const item of text.trim().split(/\s+/).filter(Boolean)) {
    const match = item.match(
      /^([a-z][a-z0-9]*)=([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:meg|[fpnumkKMGµμ])?)$/,
    );
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(result, match[1]))
      throw new Error(
        'Unsupported simulation parameters. Use only numeric values for ' +
          allowed.join(', ') +
          '.',
      );
    result[match[1]] = number(match[2]);
  }
  return result;
}
function number(value: string) {
  if (/^[+-]?0(?:\.0*)?(?:[eE][+-]?\d+)?(?:meg|[fpnumkKMGµμ])?$/.test(value)) return 0;
  const sign = value.startsWith('-') ? -1 : 1;
  return sign * passiveValue(value.replace(/^[+-]/, ''), 'R');
}
/** KiCad Sim.Pins maps symbol pin numbers to model terminal names, not list order. */
export function buckPinMap(d: Circuit, p: Part) {
  const roles = basicDevice(d, p)?.roles;
  if (!roles) throw new Error(`${p.ref}: unsupported simulation symbol ${p.libId}.`);
  const text = fields(d, p)['Sim.Pins'];
  const mapping = new Map<string, string>();
  const numbers = new Set<string>();
  const entries = text ? text.trim().split(/\s+/) : roles.map((role, i) => `${i + 1}=${role}`);
  for (const entry of entries) {
    const match = entry.match(/^(\d+)=([A-Z+\-0]+)$/);
    if (!match || !roles.includes(match[2]) || mapping.has(match[2]) || numbers.has(match[1]))
      throw new Error(`${p.ref}: unsupported or duplicate Sim.Pins mapping.`);
    mapping.set(match[2], match[1]);
    numbers.add(match[1]);
  }
  const actual = unitGraphics(d.libraries[p.libId])
    .flatMap((s) => children(s, 'pin'))
    .map((p) => val(child(p, 'number')));
  if (
    mapping.size !== roles.length ||
    numbers.size !== actual.length ||
    actual.some((n) => !numbers.has(n))
  )
    throw new Error(`${p.ref}: Sim.Pins must map every symbol pin exactly once.`);
  return mapping;
}
export function modelBuckSupportError(d: Circuit) {
  try {
    for (const p of simulationParts(d)) {
      assertSimulationModelConfiguration(p);
      const expected = basicDevice(d, p);
      if (!expected || (p.libId !== passiveConnectorSymbol && !pins[p.libId]))
        throw new Error(`${p.ref}: no supported model for ${p.libId}.`);
      const signature = unitGraphics(d.libraries[p.libId], p.unit || 1)
        .flatMap((s) => children(s, 'pin'))
        .map((pin) =>
          JSON.stringify([
            val(child(pin, 'number')),
            child(pin, 'at')?.slice(1),
            child(pin, 'length')?.slice(1),
            pin[1],
          ]),
        )
        .sort()
        .join('|');
      if (
        (p.unit || 1) !== 1 ||
        (p.libId !== passiveConnectorSymbol && signature !== pins[p.libId])
      )
        throw new Error(
          `${p.ref}: modified pin definitions are not supported by this simulation model.`,
        );
      const f = fields(d, p);
      const model = activePassiveModel(partFields(p));
      for (const key of Object.keys(f))
        if (/^spice|^sim[._]/i.test(key) && !permitted.has(key))
          throw new Error(`${p.ref}: unsupported simulation field ${key}.`);
      if (
        f['Sim.Library'] &&
        (p.libId !== BUCK_MOSFET || f['Sim.Library'] !== 'IRF-Power-VDMOS.mod')
      )
        throw new Error(
          `${p.ref}: external model "${f['Sim.Library']}" is not bundled. Only IRF-Power-VDMOS.mod / IRF540N is supported here.`,
        );
      if (f['Sim.Name'] && (p.libId !== BUCK_MOSFET || f['Sim.Name'] !== 'IRF540N'))
        throw new Error(`${p.ref}: unsupported model name.`);
      if (
        (f['Sim.Device'] && f['Sim.Device'] !== (model ?? expected.device)) ||
        (f['Sim.Type'] &&
          f['Sim.Type'] !== expected.type &&
          !(p.libId === BUCK_DC && partFields(p)['OpenPE.SourceType']))
      )
        throw new Error(`${p.ref}: unsupported simulation device or type.`);
      const kind = model ?? p.libId.match(/^Device:([RCL])$/)?.[1];
      const allowed = kind
        ? [kind.toLowerCase()]
        : p.libId === BUCK_DC
          ? sourceParameterSpecs[f['Sim.Type'] as keyof typeof sourceParameterSpecs].map(
              (spec) => spec.key,
            )
          : p.libId === BUCK_PULSE
            ? ['y1', 'y2', 'td', 'tr', 'tf', 'tw', 'per']
            : [];
      parameters(f['Sim.Params'] || '', allowed);
      buckPinMap(d, p);
    }
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}
function pulseParameters(d: Circuit, p: Part) {
  const values = parameters(fields(d, p)['Sim.Params'] || '', [
    'y1',
    'y2',
    'td',
    'tr',
    'tf',
    'tw',
    'per',
  ]);
  if (
    Object.keys(values).length !== 7 ||
    values.y1 < 0 ||
    values.y2 <= values.y1 ||
    values.y2 > 100 ||
    values.td < 0 ||
    values.td > 0.1 ||
    values.tr <= 0 ||
    values.tf <= 0 ||
    values.tw <= 0 ||
    values.per <= 0 ||
    values.tr + values.tf + values.tw >= values.per
  )
    throw new Error(
      `${p.ref}: use bounded PULSE y1/y2/td/tr/tf/tw/per parameters with positive edges and a width shorter than the period.`,
    );
  return values;
}
export function modelBuckDefaults(d: Circuit): TransientConfig {
  const parts = simulationParts(d);
  const dc = parts.find((p) => p.libId === BUCK_DC),
    pulse = parts.find((p) => p.libId === BUCK_PULSE);
  let voltage = 12,
    frequency = 20000,
    duty = 50;
  let outputId = '',
    currentId = '';
  try {
    if (dc) {
      const f = fields(d, dc),
        v = simulationSourceValues(f['Sim.Type'], f['Sim.Params'] || '', dc.value, dc.ref);
      voltage =
        f['Sim.Type'] === 'DC'
          ? v.dc
          : f['Sim.Type'] === 'PULSE'
            ? v.y2
            : (v.dc ?? 0) + Math.abs(v.ampl);
    }
    if (pulse) {
      const v = pulseParameters(d, pulse);
      frequency = 1 / v.per;
      duty = (v.tw / v.per) * 100;
    }
  } catch {
    /* Invalid schematic values remain visible in the deck preview. */
  }
  try {
    const nets = spiceNets(d),
      sw = parts.find((p) => p.libId === BUCK_MOSFET);
    const terminal = (p: Part, role: string) => nets.node(p, buckPinMap(d, p).get(role)!);
    if (sw) {
      const switching = terminal(sw, 'S');
      for (const inductor of parts.filter((p) => p.libId === 'Device:L')) {
        const a = terminal(inductor, '+'),
          b = terminal(inductor, '-');
        const output = a === switching ? b : b === switching ? a : null;
        if (!output || output === '0') continue;
        const capacitor = parts.find(
          (p) => p.libId === 'Device:C' && terminal(p, '+') === output && terminal(p, '-') === '0',
        );
        if (capacitor) {
          outputId = capacitor.id;
          currentId = inductor.id;
          break;
        }
      }
    }
  } catch {
    /* The deck preview reports invalid connections and mappings. */
  }
  return {
    inputId: dc?.id || '',
    pwmId: pulse?.id || '',
    outputId,
    switchId: parts.find((p) => p.libId === BUCK_MOSFET)?.id || '',
    currentId,
    voltage,
    frequency,
    duty,
    stop: 0.002,
    step: 1e-7,
  };
}
export function buildModelBuck(d: Circuit, c: TransientConfig): SpiceDeck {
  const error = modelBuckSupportError(d);
  if (error) throw new Error(error);
  const derived = modelBuckDefaults(d);
  for (const key of [
    'inputId',
    'pwmId',
    'outputId',
    'switchId',
    'currentId',
    'voltage',
    'frequency',
    'duty',
  ] as const)
    if (c[key] !== derived[key])
      throw new Error(
        'Circuit parameters are read from the schematic. Update the component properties and run again.',
      );
  for (const id of [BUCK_MOSFET, BUCK_DC, BUCK_PULSE])
    if (simulationParts(d).filter((p) => p.libId === id).length !== 1)
      throw new Error('Use exactly one IRF540N, DC input and PULSE source.');
  const get = (id: string, libId: string) => {
    const p = simulationParts(d).find((p) => p.id === id && p.libId === libId);
    if (!p)
      throw new Error(
        `Cannot identify ${libId} in the Buck stage. Check the component and its connections.`,
      );
    return p;
  };
  const dc = get(c.inputId, BUCK_DC),
    pulse = get(c.pwmId, BUCK_PULSE),
    sw = get(c.switchId, BUCK_MOSFET);
  const output = get(c.outputId, 'Device:C'),
    inductor = get(c.currentId, 'Device:L');
  if (
    (activePassiveModel(partFields(output)) ?? 'C') !== 'C' ||
    (activePassiveModel(partFields(inductor)) ?? 'L') !== 'L'
  )
    throw new Error('The Buck probes require a capacitor and an inductor model.');
  // Electrical values come only from the validated schematic snapshot.
  const inputFields = fields(d, dc),
    inputValues = simulationSourceValues(
      inputFields['Sim.Type'],
      inputFields['Sim.Params'] || '',
      dc.value,
      dc.ref,
    );
  const inputVoltage =
    inputFields['Sim.Type'] === 'DC'
      ? inputValues.dc
      : inputFields['Sim.Type'] === 'PULSE'
        ? inputValues.y2
        : (inputValues.dc ?? 0) + Math.abs(inputValues.ampl);
  if (
    inputVoltage <= 0 ||
    inputVoltage > 1000 ||
    (inputFields['Sim.Type'] === 'PULSE' && (inputValues.y1 < 0 || inputValues.y1 > 1000)) ||
    (inputFields['Sim.Type'] === 'SIN' && (inputValues.dc ?? 0) - Math.abs(inputValues.ampl) < 0)
  )
    throw new Error('DC source voltage must be between 0 and 1000 V.');
  const pulseValues = pulseParameters(d, pulse);
  const period = pulseValues.per,
    width = pulseValues.tw;
  if (width + pulseValues.tr + pulseValues.tf >= period)
    throw new Error('Pulse edges and width must fit within the PWM period.');
  const nets = spiceNets(d);
  const terminal = (p: Part, role: string) => nets.node(p, buckPinMap(d, p).get(role)!);
  const out = terminal(output, '+');
  if (out === '0' || terminal(output, '-') !== '0')
    throw new Error('Choose an output capacitor with its negative terminal connected to ground.');
  const lines = [
    'OpenPE bundled IRF540N transient',
    '.options reltol=0.001 abstol=1e-9',
    bundled.definition,
    '.model OPENPE_DEMO_D D',
  ];
  const initialConditions: SpiceInitialCondition[] = [];
  const currents: SpiceTrace[] = [];
  const connected = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!connected.has(a)) connected.set(a, new Set());
    if (!connected.has(b)) connected.set(b, new Set());
    connected.get(a)!.add(b);
    connected.get(b)!.add(a);
  };
  let inductorVector = '';
  d.parts.forEach((p, i) => {
    if (!participatesInSimulation(p)) return;
    if (p.libId === 'power:GND') return;
    const map = buckPinMap(d, p);
    const nodes = [...map.values()].map((n) => nets.node(p, n));
    if (new Set(nodes).size !== nodes.length)
      throw new Error(`${p.ref}: simulation terminals are shorted together.`);
    nodes.slice(1).forEach((n) => link(nodes[0], n));
    const a = (role: string) => terminal(p, role);
    const model = activePassiveModel(partFields(p));
    const kind = model ?? (p.libId.match(/^Device:([RCL])$/)?.[1] as 'R' | 'C' | 'L' | undefined);
    const name = `${kind || (p.libId === BUCK_MOSFET ? 'M' : p.libId === 'Simulation_SPICE:D' ? 'D' : 'V')}${i + 1}`;
    let vector = `i(${name.toLowerCase()})`,
      direction = '';
    if (kind) {
      const f = fields(d, p),
        params = parameters(f['Sim.Params'] || '', [kind.toLowerCase()]);
      const value =
        params[kind.toLowerCase()] ?? passiveValue(model ? displayPartValue(p) : p.value, kind);
      if (value <= 0) throw new Error(`${p.ref}: ${kind} must be positive.`);
      if (kind !== 'L') vector = `@${name.toLowerCase()}[i]`;
      const initial =
        kind === 'C' || kind === 'L' ? primitiveInitialCondition(kind, f, p.ref) : undefined;
      if (initial !== undefined && (kind === 'C' || kind === 'L'))
        initialConditions.push({ kind, positive: a('+'), negative: a('-'), value: initial });
      lines.push(
        `${name} ${a('+')} ${a('-')} ${value}${initial === undefined ? '' : ` IC=${initial}`}`,
      );
      direction = `pin ${map.get('+')} → ${map.get('-')}`;
      if (p.id === inductor.id) inductorVector = vector;
    } else if (p.libId === BUCK_MOSFET || p.libId === 'Simulation_SPICE:D') {
      const mos = p.libId === BUCK_MOSFET,
        positive = mos ? 'D' : 'A',
        negative = mos ? 'S' : 'K';
      if (mos) lines.push(`VSENSE${i + 1} ${a(positive)} sense${i + 1} 0`);
      lines.push(
        mos
          ? `${name} sense${i + 1} ${a('G')} ${a('S')} IRF540N`
          : `${name} ${a('A')} ${a('K')} OPENPE_DEMO_D`,
      );
      vector = mos ? `i(vsense${i + 1})` : `@${name.toLowerCase()}[id]`;
      direction = `pin ${map.get(positive)} → ${map.get(negative)}`;
    } else {
      lines.push(
        p.libId === BUCK_DC
          ? `${name} ${a('+')} ${a('-')} ${simulationSourceExpression(inputFields['Sim.Type'], inputFields['Sim.Params'] || '', dc.value, dc.ref)}`
          : `${name} ${a('+')} ${a('-')} PULSE(${pulseValues.y1} ${pulseValues.y2} ${pulseValues.td} ${pulseValues.tr} ${pulseValues.tf} ${width} ${period})`,
      );
      direction = 'into source';
    }
    currents.push({
      label: `I(${p.ref}) · ${direction}`,
      unit: 'A',
      vector,
      targets: [{ kind: 'current', id: p.id }],
      ...((kind === 'R' || p.libId === BUCK_MOSFET || p.libId === 'Simulation_SPICE:D') && {
        dissipation: {
          positivePin: map.get(kind === 'R' ? '+' : p.libId === BUCK_MOSFET ? 'D' : 'A')!,
          negativePin: map.get(kind === 'R' ? '-' : p.libId === BUCK_MOSFET ? 'S' : 'K')!,
          positiveNode: terminal(p, kind === 'R' ? '+' : p.libId === BUCK_MOSFET ? 'D' : 'A'),
          negativeNode: terminal(p, kind === 'R' ? '-' : p.libId === BUCK_MOSFET ? 'S' : 'K'),
          method:
            kind === 'R'
              ? ('resistor' as const)
              : p.libId === BUCK_MOSFET
                ? ('mosfet' as const)
                : ('diode' as const),
        },
      }),
    });
  });
  const seen = new Set(['0']),
    queue = ['0'];
  for (let i = 0; i < queue.length; i++)
    for (const n of connected.get(queue[i]) || [])
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  for (const entry of nets.probeNodes())
    if (simulationParts(d).some((p) => p.id === entry.target.id) && !seen.has(entry.node))
      throw new Error('Disconnected circuit island. Connect all simulation components.');
  const traces: SpiceTrace[] = [{ label: `V(${output.ref}:+)`, unit: 'V', vector: `v(${out})` }];
  for (const entry of nets.probeNodes()) {
    if (entry.node === '0' || !seen.has(entry.node)) continue;
    const vector = `v(${entry.node})`;
    let trace = traces.find((t) => t.vector === vector);
    if (!trace) {
      trace = { label: `V(${entry.label || entry.node})`, unit: 'V', vector };
      traces.push(trace);
    }
    if (d.labels.some((l) => l.id === entry.target.id)) trace.label = `V(${entry.label})`;
    (trace.targets ||= []).push(entry.target);
  }
  currents.sort(
    (a, b) => Number(b.vector === inductorVector) - Number(a.vector === inductorVector),
  );
  traces.push(...currents);
  const vectors = traces.map((t) => t.vector).join(' ');
  const initialization = spiceInitialConditions(initialConditions);
  lines.push(
    ...initialization.lines,
    `.save ${vectors}`,
    '.control',
    'set wr_singlescale',
    'set wr_vecnames',
    'set numdgt=15',
    `tran ${Math.min(c.step, c.stop)} ${c.stop} 0 ${c.step}${initialization.uic ? ' uic' : ''}`,
    `wrdata waveforms.txt ${vectors}`,
    'quit',
    '.endc',
    '.end',
    '',
  );
  const map = buckPinMap(d, sw);
  return {
    netlist: lines.join('\n'),
    traces,
    stop: c.stop,
    assumptions: [
      `${sw.ref}: bundled KiCad IRF540N VDMOS model; no external installation or model download is required.`,
      `Sim.Pins is preserved: D → symbol pin ${map.get('D')}, G → ${map.get('G')}, S → ${map.get('S')}. Check these assignments against the symbol before interpreting results.`,
      'DC voltage and all pulse parameters follow the schematic. R/L/C use numeric Sim.Params when present. Only simulation duration and maximum time step are set here.',
      'The diode uses the KiCad demo default SPICE diode model. These are model predictions, not loss, thermal, ERC or production validation.',
    ],
  };
}
