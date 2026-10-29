import { pinPositions, libraries, type Circuit, type Part, type Point } from './circuit';
import { displayPartValue, partFields, unitGraphics } from './library';
import {
  assertSimulationModelConfiguration,
  effectiveSimulationModelFields,
} from './simulation-model-source';
import { primitiveInitialCondition } from './simulation-initial-conditions';
import { child, children, val } from './sexpr';
import { onWire, samePoint } from './wiring';
import { tiPart, tiDcdcParts } from './ti-dcdc';
import { transientOutputStep, validateTransientTiming } from './spice-timing';
import {
  participatesInSimulation,
  simulationParts,
  hasSimulationNoConnects,
} from './simulation-participation';
import {
  exampleSimulationProfile,
  exampleSimulationSupportError,
  exampleTransient,
  buildExampleSpice,
} from './spice-examples';
import {
  isModelBuck,
  modelBuckSupportError,
  modelBuckDefaults,
  buildModelBuck,
} from './spice-buck';
import {
  isEmcFlyback,
  emcFlybackSupportError,
  emcFlybackDefaults,
  buildEmcFlybackSpice,
} from './spice-emc-flyback';
export { validatedSimulationResult } from './waveform';

export type TransientConfig = {
  inputId: string;
  pwmId: string;
  outputId: string;
  switchId: string;
  currentId: string;
  voltage: number;
  frequency: number;
  duty: number;
  stop: number;
  step: number;
};
export type ProbeTarget = { kind: 'voltage' | 'current'; id: string; pin?: number };
export type SpiceTrace = {
  label: string;
  unit: 'V' | 'A';
  vector: string;
  targets?: ProbeTarget[];
  /** Compiler-owned dissipative path, using the same passive current convention. */
  dissipation?: {
    positivePin: string;
    negativePin: string;
    positiveNode: string;
    negativeNode: string;
    method: 'resistor' | 'diode' | 'switch' | 'mosfet';
  };
};
export type SpiceDeck = {
  modelId?: string;
  modelIds?: string[];
  compatibility?: 'ps' | 'psa';
  netlist: string;
  traces: SpiceTrace[];
  assumptions: string[];
  stop: number;
};
export type SimulationResult = {
  version: string;
  time: number[];
  traces: (SpiceTrace & { values: number[] })[];
  log: string;
  /** Signed power integrated before display reduction, over the final 20%. */
  dissipation?: {
    startS: number;
    endS: number;
    sampleCount: number;
    powers: { vector: string; powerW: number }[];
  };
};
export const SPICE_PORT = 'Connector_Generic:Conn_01x01';
export const SPICE_SWITCH = 'Transistor_FET:Q_NMOS_GDS';
const supported = new Set([
  'Device:R',
  'Device:C',
  'Device:L',
  'Device:D_Schottky',
  'power:GND',
  SPICE_PORT,
  SPICE_SWITCH,
  ...tiDcdcParts.map((p) => p.id),
]);

export function simulationSupportError(d: Circuit): string {
  try {
    for (const p of simulationParts(d)) assertSimulationModelConfiguration(p);
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid simulation model configuration.';
  }
  if (isEmcFlyback(d)) return emcFlybackSupportError(d);
  if (isModelBuck(d)) return modelBuckSupportError(d);
  if (exampleSimulationProfile(d)) return exampleSimulationSupportError(d);
  for (const p of simulationParts(d)) {
    const model = effectiveSimulationModelFields(p, partFields(p), {})['Sim.Library'];
    if (model)
      return `${p.ref}: external model "${model}" is not included or supported. This schematic cannot be simulated here. Use a supported OpenPE simulation circuit.`;
    if (!supported.has(p.libId))
      return `${p.ref}: no simulation model for ${p.libId}. Use the supported symbols listed in the simulation model documentation.`;
  }
  return '';
}

export function defaultTransient(d: Circuit): TransientConfig {
  if (isEmcFlyback(d)) return emcFlybackDefaults();
  if (isModelBuck(d)) return modelBuckDefaults(d);
  if (exampleSimulationProfile(d)) return exampleTransient(d);
  const parts = simulationParts(d);
  const regulator = parts.find((p) => tiPart(p.libId));
  const ports = parts.filter((p) => p.libId === SPICE_PORT);
  const find = (pattern: RegExp) => ports.find((p) => pattern.test(p.value))?.id || '';
  return {
    inputId: find(/^VIN\b/i),
    pwmId: find(/^PWM\b/i),
    outputId: find(/^VOUT\b/i),
    switchId: regulator?.id || parts.find((p) => p.libId === SPICE_SWITCH)?.id || '',
    currentId: parts.find((p) => p.libId === 'Device:L')?.id || '',
    voltage: 24,
    frequency: regulator ? 150_000 : 100_000,
    duty: 50,
    stop: regulator ? 0.003 : 0.002,
    step: 0.0000001,
  };
}

/** Parse engineering notation ourselves: SPICE's M means milli, whereas our UI uses SI M. */
export function passiveValue(text: string, kind: 'R' | 'C' | 'L'): number {
  const primary = text.split('/')[0].trim();
  const unit = kind === 'R' ? '(?:Ω|ohms?)?' : kind === 'C' ? 'F?' : 'H?';
  const match = primary.match(
    new RegExp(
      `^([+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)\\s*(meg|[fpnuµμmkKMG])?\\s*${unit}$`,
    ),
  );
  if (!match)
    throw new Error(
      `Unsupported ${kind} value "${text}". Use a value such as 10k, 47uF or 22uH; a rating may follow /. `,
    );
  const scales: Record<string, number> = {
    f: 1e-15,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    µ: 1e-6,
    μ: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    meg: 1e6,
    G: 1e9,
  };
  const value = Number(match[1]) * (scales[match[2]] ?? 1);
  if (!Number.isFinite(value) || value < 1e-15 || value > 1e12)
    throw new Error(`Value "${text}" must be positive and between 1e-15 and 1e12.`);
  return value;
}

/** Only anchors connect crossings: endpoints, pins, labels and explicit junctions. */
export function spiceNets(d: Circuit, groundNames: readonly string[] = []) {
  const points: Point[] = [];
  const parent: number[] = [];
  const add = (p: Point) => {
    points.push(p);
    parent.push(parent.length);
    return parent.length - 1;
  };
  const root = (n: number): number => {
    while (parent[n] !== n) {
      parent[n] = parent[parent[n]];
      n = parent[n];
    }
    return n;
  };
  const join = (a: number, b: number) => {
    parent[root(a)] = root(b);
  };
  const wires = d.wires.map((w) => {
    const a = add(w.a),
      b = add(w.b);
    join(a, b);
    return a;
  });
  const pins = new Map<string, Map<string, number>>();
  for (const p of d.parts) {
    const definitions = unitGraphics(d.libraries[p.libId], p.unit || 1).flatMap((s) =>
      children(s, 'pin'),
    );
    const positions = pinPositions(p, d.libraries[p.libId]);
    pins.set(
      p.id,
      new Map(definitions.map((pin, i) => [val(child(pin, 'number')), add(positions[i])])),
    );
  }
  const labels = d.labels.map((l) => add(l));
  d.junctions.forEach(add);
  points.forEach((p, i) => {
    for (let j = 0; j < i; j++) if (samePoint(p, points[j])) join(i, j);
    d.wires.forEach((w, j) => {
      if (onWire(p, w)) join(i, wires[j]);
    });
  });
  const names = new Map<string, number>();
  d.labels.forEach((l, i) => {
    const previous = names.get(l.text);
    if (previous !== undefined) join(labels[i], previous);
    names.set(l.text, labels[i]);
  });
  const grounds: number[] = [];
  for (const p of d.parts) {
    const lib = d.libraries[p.libId];
    if (!child(lib, 'power') && !p.libId.startsWith('power:') && p.libId !== 'Simulation_SPICE:0')
      continue;
    const pin = pins.get(p.id);
    if (pin?.size !== 1 || p.value === 'PWR_FLAG') continue;
    const index = [...pin.values()][0];
    const powerName = groundNames.includes(p.value) ? 'GND' : p.value;
    const previous = names.get(powerName);
    if (previous !== undefined) join(index, previous);
    names.set(powerName, index);
    if (
      p.value === 'GND' ||
      p.value === '0' ||
      p.libId === 'power:GND' ||
      p.libId === 'Simulation_SPICE:0' ||
      groundNames.includes(p.value)
    )
      grounds.push(index);
  }
  if (!grounds.length) throw new Error('Add a power:GND symbol before simulating.');
  grounds.forEach((n) => join(n, grounds[0]));
  const nodeNames = new Map<number, string>([[root(grounds[0]), '0']]);
  const name = (index: number) => {
    const r = root(index);
    if (!nodeNames.has(r)) nodeNames.set(r, `n${nodeNames.size}`);
    return nodeNames.get(r)!;
  };
  const node = (p: Part, pin: string) => {
    const index = pins.get(p.id)?.get(pin);
    if (index === undefined) throw new Error(`${p.ref}: missing simulation pin ${pin}.`);
    return name(index);
  };
  const probeNodes = () => {
    const entries: { node: string; target: ProbeTarget; label?: string }[] = [];
    const addTarget = (index: number, id: string, pin?: number, label?: string) =>
      entries.push({
        node: name(index),
        target: { kind: 'voltage', id, ...(pin === undefined ? {} : { pin }) },
        label,
      });
    d.wires.forEach((w, i) => addTarget(wires[i], w.id));
    d.labels.forEach((l, i) => addTarget(labels[i], l.id, undefined, l.text));
    simulationParts(d).forEach((p) =>
      [...pins.get(p.id)!.entries()].forEach(([number, index], i) =>
        addTarget(index, p.id, i, `${p.ref}:${number}`),
      ),
    );
    const junctionStart = points.length - d.junctions.length;
    d.junctions.forEach((j, i) => addTarget(junctionStart + i, j.id));
    return entries;
  };
  return { node, probeNodes };
}
/** Model-owned reference selection never changes native electrical joins. */
export const simulationSpiceNets = (d: Circuit) =>
  spiceNets(d, isEmcFlyback(d) ? ['PGND', 'SGND'] : []);

export function buildSpiceDeck(d: Circuit, input: unknown): SpiceDeck {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid transient settings.');
  const c = input as TransientConfig;
  const fields = [
    'inputId',
    'pwmId',
    'outputId',
    'switchId',
    'currentId',
    'voltage',
    'frequency',
    'duty',
    'stop',
    'step',
  ];
  if (Object.keys(c).length !== fields.length || Object.keys(c).some((k) => !fields.includes(k)))
    throw new Error('Unknown or missing transient settings.');
  for (const p of simulationParts(d)) assertSimulationModelConfiguration(p);
  if (isEmcFlyback(d)) return buildEmcFlybackSpice(d, c);
  if (exampleSimulationProfile(d)) return buildExampleSpice(d, c);
  for (const [key, lo, hi] of [
    ['voltage', 0.01, 1000],
    ['frequency', 100, 1e6],
    ['duty', 1, 99],
  ] as const) {
    if (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || c[key] < lo || c[key] > hi)
      throw new Error(`${key} must be between ${lo} and ${hi}.`);
  }
  validateTransientTiming(c);
  if (d.parts.length > 200 || d.wires.length > 1000 || d.labels.length + d.junctions.length > 1000)
    throw new Error('Simulation supports up to 200 components and 1,000 wires/annotations.');
  if (hasSimulationNoConnects(d))
    throw new Error(
      'Simulation does not support no-connect markers. Remove unused components and their markers from the simulation circuit.',
    );
  if (isModelBuck(d)) return buildModelBuck(d, c);
  // Report missing external models before comparing unrelated upstream symbol graphics.
  // Imported KiCad demos are not automatically executable simulation projects.
  const unsupported = simulationSupportError(d);
  if (unsupported) throw new Error(unsupported);
  for (const p of simulationParts(d)) {
    // A matching library ID alone cannot establish an electrical pin mapping.
    const pinSignature = (lib: (typeof libraries)[string]) =>
      unitGraphics(lib, p.unit || 1)
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
      pinSignature(d.libraries[p.libId]) !== pinSignature(libraries[p.libId])
    )
      throw new Error(
        `${p.ref}: modified pin definitions are not supported by this simulation model.`,
      );
    if (
      [
        ...Object.keys(effectiveSimulationModelFields(p, partFields(p), {})).filter(
          (key) => partFields(p)['OpenPE.ModelSource'] !== 'basic' || key !== 'Sim.Params',
        ),
        ...children(d.libraries[p.libId], 'property').map((property) => val(property)),
      ].some((k) => /^spice|^sim[._]/i.test(k))
    )
      throw new Error(
        `${p.ref}: custom SPICE fields are not supported; remove them before using the ideal switching model.`,
      );
  }
  const get = (id: string, libId: string, label: string) => {
    const p = simulationParts(d).find((p) => p.id === id && p.libId === libId);
    if (!p) throw new Error(`Choose a ${label}.`);
    return p;
  };
  const source = get(c.inputId, SPICE_PORT, 'DC input terminal');
  const vendor = tiPart(simulationParts(d).find((p) => p.id === c.switchId)?.libId || '');
  if (vendor && (c.pwmId !== '' || c.frequency !== 150000 || c.duty !== 50))
    throw new Error('LM2596 uses its internal 150 kHz controller. Reset the simulation settings.');
  if (vendor && (c.voltage < Math.max(4.5, vendor.model.voltage + 2) || c.voltage > 40))
    throw new Error(
      `Use an input from ${Math.max(4.5, vendor.model.voltage + 2)} to 40 V for this fixed-output Buck simulation.`,
    );
  const pwm = vendor ? null : get(c.pwmId, SPICE_PORT, 'PWM terminal');
  const output = get(c.outputId, SPICE_PORT, 'voltage probe terminal');
  const sw = get(c.switchId, vendor?.id || SPICE_SWITCH, 'switch or supported TI regulator');
  const inductor = get(c.currentId, 'Device:L', 'current probe inductor');
  if (simulationParts(d).filter((p) => p.libId === SPICE_SWITCH || tiPart(p.libId)).length !== 1)
    throw new Error('This model supports exactly one PWM-controlled switch.');
  const { node, probeNodes } = spiceNets(d);
  const vin = node(source, '1'),
    gate = vendor ? '' : node(sw, '1'),
    drain = node(sw, vendor ? '1' : '2'),
    switching = node(sw, vendor ? '2' : '3'),
    out = node(output, '1');
  if (
    vendor
      ? new Set(['0', vin, switching, out]).size !== 4 ||
        drain !== vin ||
        node(sw, '3') !== '0' ||
        node(sw, '5') !== '0' ||
        node(sw, '4') !== out
      : new Set(['0', vin, gate, switching, out]).size !== 5 ||
        drain !== vin ||
        node(pwm!, '1') !== gate
  )
    throw new Error(
      vendor
        ? 'Connect LM2596 VIN (1) to input, FB (4) to output, GND (3) and ON/OFF (5) to ground. Keep OUT (2), input, output and ground separate.'
        : 'For a high-side Buck, connect input to switch pin 2 (drain), PWM to pin 1 (gate), and keep output, ground and pin 3 (source) on separate nets.',
    );
  const lines = [
    vendor ? 'OpenPE TI LM2596 transient' : 'OpenPE ideal switching transient',
    '.options reltol=0.001 abstol=1e-9',
  ];
  let explicitInitialConditions = false;
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      if (!adjacency.has(x)) adjacency.set(x, new Set());
      adjacency.get(x)!.add(y);
    }
  };
  const identifiers = new Map<string, string>();
  const currentTraces: SpiceTrace[] = [];
  d.parts.forEach((p, i) => {
    if (!participatesInSimulation(p)) return;
    const kind =
      p.libId === 'Device:R'
        ? 'R'
        : p.libId === 'Device:C'
          ? 'C'
          : p.libId === 'Device:L'
            ? 'L'
            : null;
    if (kind || p.libId === 'Device:D_Schottky') {
      const a = node(p, '1'),
        b = node(p, '2');
      if (a === b) throw new Error(`${p.ref}: both pins are on the same net.`);
      if ([a, b].includes(gate))
        throw new Error(
          `${p.ref}: the ideal gate drive must connect only to the switch gate and PWM terminal.`,
        );
      connect(a, b);
      const name = `${kind || 'D'}${i + 1}`;
      identifiers.set(p.id, name);
      const positive = kind ? a : b;
      // Retain the validated TI measurement topology: its switching macro-model
      // is sensitive to matrix ordering. The ideal stage needs no added nodes.
      const measured = !!vendor && kind !== 'L';
      const internal = `sense${i + 1}`;
      if (measured) lines.push(`VSENSE${i + 1} ${positive} ${internal} 0`);
      const initial =
        kind === 'C' || kind === 'L'
          ? primitiveInitialCondition(kind, partFields(p), p.ref)
          : undefined;
      if (initial !== undefined) explicitInitialConditions = true;
      lines.push(
        kind
          ? `${name} ${measured ? internal : positive} ${b} ${passiveValue(partFields(p)['OpenPE.ModelSource'] === 'basic' ? displayPartValue(p) : p.value, kind)}${initial === undefined ? '' : ` IC=${initial}`}`
          : `${name} ${measured ? internal : positive} ${a} OPENPE_DIODE`,
      );
      currentTraces.push({
        label: `I(${p.ref}) · pin ${kind ? '1 → 2' : '2 → 1'}`,
        unit: 'A',
        vector: measured
          ? `i(vsense${i + 1})`
          : kind === 'L'
            ? `i(${name.toLowerCase()})`
            : `@${name.toLowerCase()}[${kind ? 'i' : 'id'}]`,
        targets: [{ kind: 'current', id: p.id }],
        ...((kind === 'R' || !kind) && {
          dissipation: {
            positivePin: kind ? '1' : '2',
            negativePin: kind ? '2' : '1',
            positiveNode: positive,
            negativeNode: kind ? b : a,
            method: kind ? ('resistor' as const) : ('diode' as const),
          },
        }),
      });
    }
  });
  connect(vin, '0');
  if (!vendor) connect(gate, switching);
  connect(drain, switching);
  const seen = new Set(['0']);
  const queue = ['0'];
  for (let i = 0; i < queue.length; i++)
    for (const n of adjacency.get(queue[i]) || [])
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  for (const p of simulationParts(d))
    for (const pin of unitGraphics(d.libraries[p.libId]).flatMap((s) => children(s, 'pin'))) {
      if (!seen.has(node(p, val(child(pin, 'number')))))
        throw new Error(
          `${p.ref}: disconnected circuit island. Connect it or remove it before simulating.`,
        );
    }
  const period = 1 / c.frequency,
    edge = period / 1000;
  if (vendor)
    lines.push(
      '.include ti-model.lib',
      `VINPUT ${vin} 0 PWL(0 0 10u ${c.voltage})`,
      `XREG ${vin} ${out} ${switching} 0 0 ${vendor.model.subcircuit}`,
      '.model OPENPE_DIODE D(Is=1e-6 N=1.05 Rs=0.02 Cjo=0 Tt=0)',
    );
  else
    lines.push(
      `VINPUT ${vin} 0 DC ${c.voltage}`,
      `VPWM ${gate} ${switching} PULSE(0 10 ${period / 10} ${edge} ${edge} ${(period * c.duty) / 100 - edge} ${period})`,
      `VSENSESW ${drain} sensesw 0`,
      `SMAIN sensesw ${switching} ${gate} ${switching} OPENPE_SWITCH`,
      '.model OPENPE_SWITCH SW(Ron=0.02 Roff=1e9 Vt=5 Vh=0)',
      '.model OPENPE_DIODE D(Is=1e-6 N=1.05 Rs=0.02 Cjo=0 Tt=0)',
    );
  const traces: SpiceTrace[] = [
    { label: `V(${output.ref})`, unit: 'V', vector: `v(${out})` },
    { label: `V(${sw.ref}:${vendor ? 'OUT' : 'S'})`, unit: 'V', vector: `v(${switching})` },
    {
      label: `I(${inductor.ref}) · pin 1 → 2`,
      unit: 'A',
      vector: `i(${identifiers.get(inductor.id)!.toLowerCase()})`,
      targets: [{ kind: 'current', id: inductor.id }],
    },
  ];
  for (const entry of probeNodes()) {
    if (entry.node === '0' || !seen.has(entry.node)) continue;
    const vector = `v(${entry.node})`;
    let trace = traces.find((t) => t.vector === vector);
    if (!trace) {
      trace = { label: `V(${entry.label || entry.node})`, unit: 'V', vector, targets: [] };
      traces.push(trace);
    }
    if (d.labels.some((l) => l.id === entry.target.id)) trace.label = `V(${entry.label})`;
    (trace.targets ||= []).push(entry.target);
  }
  currentTraces.push({
    label: `I(${source.ref}) · into DC source`,
    unit: 'A',
    vector: 'i(vinput)',
    targets: [{ kind: 'current', id: source.id }],
  });
  if (!vendor)
    currentTraces.push(
      {
        label: `I(${sw.ref}) · pin 2 → 3`,
        unit: 'A',
        vector: 'i(vsensesw)',
        targets: [{ kind: 'current', id: sw.id }],
        dissipation: {
          positivePin: '2',
          negativePin: '3',
          positiveNode: drain,
          negativeNode: switching,
          method: 'switch',
        },
      },
      {
        label: `I(${pwm!.ref}) · into PWM source`,
        unit: 'A',
        vector: 'i(vpwm)',
        targets: [{ kind: 'current', id: pwm!.id }],
      },
    );
  for (const trace of currentTraces)
    if (!traces.some((t) => t.vector === trace.vector)) traces.push(trace);
  const vectors = traces.map((t) => t.vector).join(' ');
  // Include the exact end time when linearizing a vendor transient, even for nonintegral ratios.
  const sampleStep = vendor ? transientOutputStep(c) : Math.min(c.step, c.stop);
  lines.push(
    `.save ${vectors}`,
    '.control',
    'set wr_singlescale',
    'set wr_vecnames',
    'set numdgt=15',
    `tran ${sampleStep} ${c.stop} 0 ${c.step}${explicitInitialConditions ? ' uic' : ''}`,
    ...(vendor ? ['linearize'] : []),
    `wrdata waveforms.txt ${vectors}`,
    'quit',
    '.endc',
    '.end',
    '',
  );
  return {
    ...(vendor ? { modelId: vendor.model.id } : {}),
    netlist: lines.join('\n'),
    traces,
    stop: c.stop,
    assumptions: vendor
      ? [
          `${sw.ref}: TI ${vendor.model.subcircuit}, unencrypted PSpice transient model 1.00 (2015), executed in ngspice PSpice compatibility mode.`,
          'The official model is downloaded from ti.com on first run and verified by SHA-256. TI evaluation-item terms apply; this is not TI validation of ngspice results.',
          'Input ramps from 0 V to the chosen voltage in 10 µs. ON/OFF is held low; the internal controller regulates the fixed output.',
          'Diode uses a generic Schottky model. R, L and C use schematic values; model ESR or winding resistance with explicit resistors. No loss, thermal, saturation or production validation.',
          'Waveforms are interpolated onto the requested time step after a completed transient.',
        ]
      : [
          `${sw.ref}: ideal voltage-controlled switch, Ron 20 mΩ / Roff 1 GΩ; no MOSFET body diode or switching losses.`,
          'Diodes: generic model, Is 1 µA, N 1.05, Rs 20 mΩ; no charge storage or junction capacitance.',
          'R, L and C use schematic values; ratings after / are ignored. No ESR, winding resistance, saturation or thermal model.',
          'PWM is a 0–10 V source referenced to the switch source. DC operating point precedes the transient; this is open-loop operation.',
        ],
  };
}
