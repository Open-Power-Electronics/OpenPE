import { pinPositions, type Circuit, type Part } from './circuit';
import { partFields, unitGraphics } from './library';
import { child, children, val } from './sexpr';
import {
  passiveValue,
  spiceNets,
  type SpiceDeck,
  type SpiceTrace,
  type TransientConfig,
} from './spice';
import { transientOutputStep, validateTransientTiming } from './spice-timing';
import profile from './emc-flyback-simulation.json';
import { emcFlybackControl } from './emc-flyback-control';

export const emcFlybackLoadOhms = 100;

export const isEmcFlyback = (d: Circuit) =>
  d.parts.some((p) => p.libId === 'EMC_Demo:Wurth_750311591');
const resistors = [
  'R2',
  'R3',
  'R4',
  'R5',
  'R8',
  'R9',
  'R10',
  'R20',
  'R15',
  'R16',
  'R17',
  'R18',
  'R19',
];
const capacitors = [
  'C4',
  'C5',
  'C6',
  'C10',
  'C11',
  'C12',
  'C13',
  'C15',
  'C18',
  'C19',
  'C20',
  'C21',
  'C22',
];
const configurable = new Set([...resistors, ...capacitors]);
const zeroNames = ['PGND', 'SGND'];

export function emcFlybackDefaults(): TransientConfig {
  return {
    inputId: '',
    pwmId: '',
    outputId: '',
    switchId: '',
    currentId: '',
    voltage: 24,
    frequency: 153600,
    duty: 50,
    stop: 0.01,
    step: 5e-9,
  };
}
function value(p: Part, kind: 'R' | 'C') {
  const text = p.value.trim().split(/\s+/)[0];
  return passiveValue(kind === 'R' ? text.replace(/R$/i, '') : text, kind);
}
function validate(d: Circuit) {
  if (
    d.parts.length !== profile.parts.length ||
    d.parts.length > 200 ||
    d.wires.length > 1000 ||
    d.labels.length + d.junctions.length > 1000
  )
    throw new Error('EMC Flyback simulation requires the complete bundled single-sheet circuit.');
  const groups = new Map<string, string[]>();
  const nets = spiceNets(d, zeroNames);
  for (const expected of profile.parts) {
    const matches = d.parts.filter((p) => p.ref === expected.ref);
    const p = matches[0];
    if (matches.length !== 1 || p.libId !== expected.libId || (p.unit || 1) !== 1)
      throw new Error(`${expected.ref}: restore the bundled EMC Flyback symbol and reference.`);
    if (p.excludeFromSimulation)
      throw new Error(
        `${p.ref}: this bounded EMC Flyback model requires the original simulation participation.`,
      );
    const pins = unitGraphics(d.libraries[p.libId], p.unit || 1).flatMap((s) => children(s, 'pin'));
    const signature = pins
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
    if (signature !== expected.pins)
      throw new Error(`${p.ref}: modified electrical pin definitions are not supported.`);
    const simulation = Object.fromEntries(
      Object.entries({
        ...Object.fromEntries(
          children(d.libraries[p.libId], 'property').map((property) => [
            val(property),
            val(property, 2),
          ]),
        ),
        ...partFields(p),
      }).filter(([key]) => /^spice|^sim[._]/i.test(key)),
    );
    if (JSON.stringify(simulation) !== JSON.stringify(expected.simulation))
      throw new Error(`${p.ref}: custom simulation fields are not supported by EMC Flyback.`);
    if (configurable.has(p.ref)) {
      if (
        /[\r\n]/.test(p.value) ||
        p.value.trim().replace(/^\S+/, '') !== expected.value.trim().replace(/^\S+/, '')
      )
        throw new Error(
          `${p.ref}: retain the original value rating and use a single numeric component value.`,
        );
      value(p, resistors.includes(p.ref) ? 'R' : 'C');
    } else if (p.value !== expected.value)
      throw new Error(
        `${p.ref}: this bounded EMC Flyback model requires the bundled value ${expected.value}.`,
      );
    for (const pin of pins) {
      const number = val(child(pin, 'number')),
        node = nets.node(p, number);
      groups.set(node, [...(groups.get(node) || []), `${p.ref}.${number}`]);
    }
  }
  const actual = [...groups.values()].map((group) => group.sort().join('|')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(profile.groups))
    throw new Error(
      'EMC Flyback connectivity changed. Restore its bundled topology before using this bounded model.',
    );
  const noConnectPins = (d.noConnects || [])
    .map((marker) =>
      d.parts
        .flatMap((p) => {
          const pins = unitGraphics(d.libraries[p.libId], p.unit || 1).flatMap((s) =>
            children(s, 'pin'),
          );
          return pinPositions(p, d.libraries[p.libId]).flatMap((position, i) =>
            Math.abs(position.x - marker.x) < 1e-5 && Math.abs(position.y - marker.y) < 1e-5
              ? [`${p.ref}.${val(child(pins[i], 'number'))}`]
              : [],
          );
        })
        .sort()
        .join('|'),
    )
    .sort();
  if (JSON.stringify(noConnectPins) !== JSON.stringify(profile.noConnectPins))
    throw new Error(
      'EMC Flyback supports no-connect markers only on the original omitted auxiliary winding.',
    );
  return nets;
}
export function emcFlybackSupportError(d: Circuit) {
  try {
    validate(d);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

/** A fixed application-owned execution derivative of the upstream behavioural
 * closed-loop bench. It cannot execute native notes, paths or custom models. */
export function buildEmcFlybackSpice(d: Circuit, c: TransientConfig): SpiceDeck {
  const nets = validate(d),
    expected = emcFlybackDefaults();
  if (
    Object.keys(c).length !== Object.keys(expected).length ||
    Object.keys(c).some(
      (key) =>
        !Object.hasOwn(expected, key) ||
        (!['stop', 'step'].includes(key) &&
          c[key as keyof TransientConfig] !== expected[key as keyof TransientConfig]),
    )
  )
    throw new Error(
      'Electrical settings follow the EMC Flyback schematic and bounded 24 V bench. Only Duration and Max. time step can be changed.',
    );
  validateTransientTiming(c);
  const part = (ref: string) => d.parts.find((p) => p.ref === ref)!;
  const node = (ref: string, pin: string) => nets.node(part(ref), pin);
  const nodes = new Set<string>(['0']);
  const lines = [
    'OpenPE EMC Flyback closed-loop behavioural transient',
    '.options reltol=0.001 abstol=1e-9 gmin=1e-10',
    '.param CTR=1 FOPTO=20k RDIV=30k',
    emcFlybackControl,
    '.model EMC_IRF520N VDMOS(Vto=3.6 Kp=6 lambda=0.03 Rd=0.11 Rs=0.025 Rg=2.5 Cgdmax=600p Cgdmin=25p a=0.5 Cgs=300p Cjo=260p M=0.55 Vj=0.8 Is=2e-12 Rb=0.02 N=1.1 Tt=60n)',
    '.model EMC_ES2D D(Is=1e-9 N=1.8 Rs=0.05 Cjo=20p M=0.4 Tt=20n BV=200 Ibv=5u)',
    '.model EMC_SS510C D(Is=5e-5 N=1.1 Rs=0.02 Cjo=300p M=0.5 BV=100 Ibv=50u)',
  ];
  const currents: SpiceTrace[] = [];
  const addNodes = (...ns: string[]) => ns.forEach((n) => nodes.add(n));
  for (const ref of resistors) {
    const p = part(ref),
      a = node(ref, '1'),
      b = node(ref, '2');
    addNodes(a, b);
    lines.push(`${ref} ${a} ${b} ${value(p, 'R')}`);
    currents.push({
      label: `I(${ref}) · pin 1 → 2`,
      unit: 'A',
      vector: `@${ref.toLowerCase()}[i]`,
      targets: [{ kind: 'current', id: p.id }],
      dissipation: {
        positivePin: '1',
        negativePin: '2',
        positiveNode: a,
        negativeNode: b,
        method: 'resistor',
      },
    });
  }
  const esr: Record<string, number> = {
    C4: 0.3,
    C5: 0.005,
    C6: 0.005,
    C18: 0.06,
    C19: 0.06,
    C20: 0.003,
    C21: 0.003,
  };
  for (const ref of capacitors) {
    const a = node(ref, '1'),
      b = node(ref, '2'),
      r = esr[ref];
    addNodes(a, b);
    if (r) lines.push(`RESR_${ref} ${a} emc_${ref} ${r}`);
    lines.push(`${ref} ${r ? `emc_${ref}` : a} ${b} ${value(part(ref), 'C')}`);
    currents.push({
      label: `I(${ref}) · pin 1 → 2`,
      unit: 'A',
      vector: `@${ref.toLowerCase()}[i]`,
      targets: [{ kind: 'current', id: part(ref).id }],
    });
  }
  for (const ref of ['D2', 'D3', 'D7']) {
    const a = node(ref, '2'),
      k = node(ref, '1');
    addNodes(a, k);
    lines.push(`${ref} ${a} ${k} ${ref === 'D2' ? 'EMC_ES2D' : 'EMC_SS510C'}`);
    currents.push({
      label: `I(${ref}) · pin 2 → 1`,
      unit: 'A',
      vector: `@${ref.toLowerCase()}[id]`,
      targets: [{ kind: 'current', id: part(ref).id }],
      dissipation: {
        positivePin: '2',
        negativePin: '1',
        positiveNode: a,
        negativeNode: k,
        method: 'diode',
      },
    });
  }
  const bus = node('T1', '1'),
    drain = node('Q1', '2'),
    gate = node('Q1', '1'),
    cs = node('Q1', '3'),
    sec = node('D3', '2'),
    out = node('D3', '1');
  addNodes(bus, drain, gate, cs, sec, out);
  lines.push(
    `VVIN emc_vin 0 24`,
    `RVIN emc_vin ${bus} 0.01`,
    `VVCC ${node('U1', '7')} 0 12`,
    `VRG ${node('RG', '1')} ${node('RG', '2')} 0`,
    `RPRI ${bus} emc_pri 0.015`,
    `LPRI emc_pri ${drain} 8u`,
    `RSEC ${sec} emc_sec 0.01`,
    `LSEC 0 emc_sec 3.555555555555555u`,
    'KFLYBACK LPRI LSEC 0.9747',
    `MQ1 ${drain} ${gate} emc_source EMC_IRF520N`,
    `LPCB emc_source ${cs} 10n`,
    `XU1 ${Array.from({ length: 8 }, (_, i) => node('U1', String(i + 1))).join(' ')} UC3845B`,
    `XU3 ${node('U3', '1')} ${node('U3', '3')} ${node('U3', '2')} TL431B`,
    `XU4 ${node('U4', '1')} ${node('U4', '2')} ${node('U4', '4')} ${node('U4', '3')} LTV817`,
    `RLOAD ${out} 0 ${emcFlybackLoadOhms}`,
    `ILOAD ${out} 0 PULSE(0.5 0 2m 10u 10u 2m 1)`,
    `.ic V(${out})=12.23 V(${bus})=24 V(${node('C15', '1')})=64 V(${node('U1', '8')})=5 V(${node('U1', '1')})=3.05 V(${node('U4', '1')})=10.44 V(${node('U3', '1')})=9.4 V(${node('C22', '1')})=9.4 V(${node('U3', '2')})=2.495`,
    `.ic ${Object.keys(esr)
      .map((ref) => `V(emc_${ref})=${['C4', 'C5', 'C6'].includes(ref) ? 24 : 12.23}`)
      .join(' ')}`,
  );
  currents.push(
    {
      label: 'I(Q1) · drain pin 2 → source pin 3',
      unit: 'A',
      vector: '@mq1[id]',
      targets: [{ kind: 'current', id: part('Q1').id }],
      dissipation: {
        positivePin: '2',
        negativePin: '3',
        positiveNode: drain,
        negativeNode: 'emc_source',
        method: 'mosfet',
      },
    },
    {
      label: 'I(T1) · primary pin 1 → 3',
      unit: 'A',
      vector: 'i(lpri)',
      targets: [{ kind: 'current', id: part('T1').id }],
    },
    { label: 'I(VIN) · into the source', unit: 'A', vector: 'i(vvin)' },
  );
  const traces: SpiceTrace[] = [];
  for (const entry of nets.probeNodes()) {
    if (entry.node === '0' || !nodes.has(entry.node)) continue;
    const vector = `v(${entry.node})`;
    let trace = traces.find((t) => t.vector === vector);
    if (!trace) {
      trace = { label: `V(${entry.label || entry.node})`, unit: 'V', vector, targets: [] };
      traces.push(trace);
    }
    trace.targets!.push(entry.target);
    if (d.labels.some((label) => label.id === entry.target.id)) trace.label = `V(${entry.label})`;
  }
  // Put the regulated output first for result restoration and scientific checks.
  const output = traces.findIndex((t) => t.vector === `v(${out})`);
  if (output > 0) traces.unshift(...traces.splice(output, 1));
  traces.push({ label: 'V(Q1 internal source)', unit: 'V', vector: 'v(emc_source)' });
  traces.push(...currents);
  const vectors = traces.map((t) => t.vector).join(' ');
  lines.push(
    `.save ${vectors}`,
    '.control',
    'set wr_singlescale',
    'set wr_vecnames',
    'set numdgt=15',
    `tran ${transientOutputStep(c)} ${c.stop} 0 ${c.step} uic`,
    'linearize',
    `wrdata waveforms.txt ${vectors}`,
    'quit',
    '.endc',
    '.end',
    '',
  );
  return {
    netlist: lines.join('\n'),
    traces,
    stop: c.stop,
    assumptions: [
      'Pinned AI-PCB-layout EMC Flyback closed-loop behavioural bench: fitted IRF520N, generic ES2D/SS510C and behavioural UC3845B/TL431/LTV817; these are approximate non-vendor models.',
      '24 V is applied at VBUS after the omitted input EMI/protection network; L78L12 is an ideal 12 V supply. RG selects R5 (4.7 ohm); drain snubber, indicators, output bleeder, auxiliary winding, case and common-mode/Y-cap paths are omitted. PGND and SGND share simulator ground only.',
      `T1 uses 8 uH primary, 1.5 turns ratio, coupling 0.9747 and fixed winding/ESR parasitics from the upstream bench. The external load is ${emcFlybackLoadOhms} ohm plus a 0.5 A step off at 2 ms and back on at 4 ms; initial conditions approximate steady state.`,
      'Current values and supported R/C values follow the current native schematic. Q1 heat uses the fitted model drain-source current and its internal source voltage, excluding the series 10 nH source parasitic, gate, controller, transformer and omitted-device losses.',
      'The model supports electrical trends and a bounded board heat-source estimate; it does not predict conducted EMC, junction/case temperature, complete board losses or production safety.',
    ],
  };
}
