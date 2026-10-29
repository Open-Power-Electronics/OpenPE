import { numericSimulationParameters as parameters } from './simulation-parameters';
import { simulationSourceValues, simulationSourceExpression } from './simulation-source-parameters';
import { primitiveInitialCondition } from './simulation-initial-conditions';
import {
  assertSimulationModelConfiguration,
  effectiveSimulationModelFields,
} from './simulation-model-source';
import {
  simulationNumberLiteral as literal,
  simulationNumber as exampleNumber,
  simulationParameterValue,
} from './simulation-parameters';
import { libraries, type Circuit, type Part } from './circuit';
import { partFields, unitGraphics } from './library';
import { child, children, val } from './sexpr';
import { schematicTexts } from './schematic-text';
import { spiceNets, type SpiceDeck, type SpiceTrace, type TransientConfig } from './spice';
import snapshot from './example-simulation.json';
import referenceSnapshot from './reference-simulation.json';
import { transientOutputStep, validateTransientTiming } from './spice-timing';
import { lm2596AdjustableDerivedModel } from './ti-dcdc';
import {
  participatesInSimulation,
  simulationParts,
  hasSimulationNoConnects,
} from './simulation-participation';

type Definition = {
  ref: string;
  libId: string;
  signature: string;
  kind: string;
  terminals: string[];
  pinOrder: string[];
  sim: Record<string, string>;
  modelId: string;
  modelName: string;
  value: string;
};
type Profile = {
  id: string;
  title: string;
  stop: number;
  step: number;
  parts: Definition[];
  directives: string[];
  options: Record<string, string>;
  initialConditions?: boolean;
  input?: { pin: string; minimum: number; maximum: number; initialLimit: number };
  magnetic?: { ref: string };
};
const profiles = [...snapshot.profiles, ...referenceSnapshot.profiles] as Profile[];
function signature(d: Circuit, p: Part) {
  if (!d.libraries[p.libId]) return '';
  return unitGraphics(d.libraries[p.libId], p.unit || 1)
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
}
function fields(
  d: Circuit,
  p: Part,
  reviewedDefaults?: Record<string, string>,
): Record<string, string> {
  return effectiveSimulationModelFields(
    p,
    {
      ...Object.fromEntries(
        children(d.libraries[p.libId] ?? [], 'property').map((v) => [val(v), val(v, 2)]),
      ),
      ...partFields(p),
    },
    reviewedDefaults,
  );
}
export function exampleSimulationProfile(d: Circuit) {
  const original = profiles.find(
    (profile) =>
      simulationParts(d).every((actual) =>
        profile.parts.some((p) => actual.ref === p.ref && actual.libId === p.libId),
      ) &&
      profile.parts.every((p) =>
        d.parts.some((actual) => actual.ref === p.ref && actual.libId === p.libId),
      ),
  );
  if (original) return original;
  // Model support follows the pinned library identity and physical terminals,
  // not a project UUID, fixed reference list or provenance extension. A resistor
  // placed from the bundled library remains simulatable in an edited example.
  const candidates = profiles.filter((p) => p.id.startsWith('reference-'));
  const controllerLibraries = new Set(
    candidates.flatMap((profile) =>
      profile.parts.filter((def) => def.kind === 'X').map((def) => def.sim['Sim.Library']),
    ),
  );
  const controller = simulationParts(d).find((p) =>
    controllerLibraries.has(fields(d, p)['Sim.Library']),
  );
  if (!controller) return undefined;
  const base = candidates.find((profile) =>
    profile.parts.some(
      (def) =>
        def.kind === 'X' &&
        fields(d, controller)['Sim.Library'] === def.sim['Sim.Library'] &&
        signature(d, controller) === def.signature,
    ),
  );
  if (!base) return undefined;
  const known = candidates.flatMap((p) => p.parts);
  const parts = d.parts.map((p) => {
    const actualSignature = signature(d, p);
    if (!participatesInSimulation(p))
      return {
        ref: p.ref,
        libId: p.libId,
        signature: actualSignature,
        kind: 'excluded',
        terminals: [],
        pinOrder: [],
        sim: {},
        modelId: '',
        modelName: '',
        value: p.value,
      };
    const definition = known.find(
      (def) => def.libId === p.libId && def.signature === actualSignature,
    );
    if (definition) return { ...definition, ref: p.ref };
    const kind = /^Device:([RCL])$/.exec(p.libId)?.[1];
    if (kind && libraries[p.libId] && signature({ ...d, libraries }, p) === actualSignature)
      return {
        ref: p.ref,
        libId: p.libId,
        signature: actualSignature,
        kind,
        terminals: ['1', '2'],
        pinOrder: ['1', '2'],
        sim: {},
        modelId: '',
        modelName: '',
        value: p.value,
      };
    return {
      ref: p.ref,
      libId: p.libId,
      signature: actualSignature,
      kind: 'unsupported',
      terminals: [],
      pinOrder: [],
      sim: {},
      modelId: '',
      modelName: '',
      value: p.value,
    };
  });
  if (parts.filter((p) => p.kind === 'X').length !== 1) return undefined;
  const magnetic = parts.find((p) => p.kind === 'T');
  return {
    ...base,
    parts,
    ...(base.magnetic && magnetic ? { magnetic: { ...base.magnetic, ref: magnetic.ref } } : {}),
  };
}
export function exampleTransient(d: Circuit): TransientConfig {
  const profile = exampleSimulationProfile(d)!;
  return {
    inputId: '',
    pwmId: '',
    outputId: '',
    switchId: '',
    currentId: '',
    voltage: 1,
    frequency: 1000,
    duty: 50,
    stop: profile.stop,
    step: profile.step,
  };
}
function modelParameters(text: string, expected: string) {
  // This exact upstream legacy selector is metadata, not a subcircuit parameter.
  if (expected === 'type="X" model="OPAMP" lib=""') {
    if (text !== expected) throw new Error('Unsupported legacy model selector.');
    return {};
  }
  return parameters(
    text,
    [...expected.matchAll(/([a-z][a-z0-9]*)\s*=/gi)].map((v) => v[1].toLowerCase()),
  );
}
function passive(d: Circuit, p: Part, def: Pick<Definition, 'kind'>) {
  const text = (fields(d, p)['Sim.Params'] || p.value).trim();
  const load = text.match(
    new RegExp(
      `^r\\s*=\\s*'time\\s*>\\s*(${literal})\\s*\\?\\s*(${literal})\\s*:\\s*(${literal})'$`,
      'i',
    ),
  );
  if (load && def.kind === 'R') {
    const [time, high, low] = load.slice(1).map(exampleNumber);
    if (time < 0 || high <= 0 || low <= 0)
      throw new Error(`${p.ref}: load resistance must be positive.`);
    return `r={time > ${time} ? ${high} : ${low}}`;
  }
  const input = text.includes('=')
    ? parameters(text, [def.kind.toLowerCase()])[def.kind.toLowerCase()]
    : exampleNumber(text.replace(/(?:ohms?|Ω|[FH])$/i, ''));
  if (!Number.isFinite(input) || input <= 0)
    throw new Error(`${p.ref}: passive value must be positive.`);
  return String(input);
}
function seriesResistance(d: Circuit, p: Part) {
  const text = fields(d, p)['OpenPE.SeriesResistance'];
  if (text === undefined) return 0;
  return simulationParameterValue('OpenPE.SeriesResistance', text, p.ref);
}
function initialVoltage(d: Circuit, p: Part) {
  const text = fields(d, p)['OpenPE.InitialVoltage'];
  if (text === undefined) return undefined;
  return simulationParameterValue('OpenPE.InitialVoltage', text, p.ref);
}
function magneticValues(d: Circuit, p: Part) {
  // Preserve the intended SI literal rather than serializing floating-point
  // multiplication noise (100u must compile as 0.0001).
  const inductance = String(Number(Number(passive(d, p, { kind: 'L' })).toPrecision(15)));
  const coupling = simulationParameterValue(
    'OpenPE.Coupling',
    fields(d, p)['OpenPE.Coupling'] ?? '',
    p.ref,
  );
  return { inductance, coupling };
}
function source(d: Circuit, p: Part) {
  const f = fields(d, p),
    type = f['Sim.Type'];
  return simulationSourceExpression(type, f['Sim.Params'] || '', p.value, p.ref);
}
function validate(d: Circuit, profile: Profile) {
  for (const p of simulationParts(d)) {
    assertSimulationModelConfiguration(p);
    const def = profile.parts.find((v) => v.ref === p.ref)!;
    if (def.kind === 'unsupported')
      throw new Error(`${p.ref}: no allowlisted library model for ${p.libId}.`);
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
    if ((p.unit || 1) !== 1 || def.signature !== signature)
      throw new Error(`${p.ref}: unsupported electrical pin definitions.`);
    if (profile.id.startsWith('reference-') && def.kind === 'X' && p.value !== def.value)
      throw new Error(`${p.ref}: restore the allowlisted controller identity before simulating.`);
    const defaults = def.sim as Record<string, string>;
    const sim = fields(d, p, defaults),
      expected =
        partFields(p)['OpenPE.ModelSource'] === 'basic'
          ? effectiveSimulationModelFields(
              p,
              {
                ...defaults,
                'OpenPE.ModelSource': 'basic',
                ...(partFields(p)['OpenPE.SourceType']
                  ? { 'OpenPE.SourceType': partFields(p)['OpenPE.SourceType'] }
                  : {}),
              },
              defaults,
            )
          : defaults;
    for (const key of new Set([...Object.keys(sim), ...Object.keys(expected)])) {
      if (
        /^spice|^sim[._]/i.test(key) &&
        key !== 'Sim.Params' &&
        !(
          key === 'Sim.Type' &&
          def.kind === 'V' &&
          partFields(p)['OpenPE.SourceType'] &&
          !sim['Sim.Library']
        ) &&
        sim[key] !== expected[key]
      )
        throw new Error(`${p.ref}: unsupported simulation field or pin assignment ${key}.`);
    }
    if (['R', 'C', 'L'].includes(def.kind)) {
      passive(d, p, def);
      seriesResistance(d, p);
      if (def.kind === 'C' || def.kind === 'L')
        primitiveInitialCondition(def.kind, fields(d, p), p.ref);
    } else if (def.kind === 'V') source(d, p);
    else if (def.kind === 'T') magneticValues(d, p);
    else {
      const actualParameters = modelParameters(
        sim['Sim.Params'] || '',
        expected['Sim.Params'] || '',
      );
      if (profile.id.startsWith('reference-') && def.kind === 'X') {
        const allowedParameters = modelParameters(
          expected['Sim.Params'] || '',
          expected['Sim.Params'] || '',
        );
        if (
          Object.keys(actualParameters).some(
            (key) => actualParameters[key] !== allowedParameters[key],
          )
        )
          throw new Error(
            `${p.ref}: internal controller parameters are fixed for this allowlisted model profile.`,
          );
      }
    }
  }
  if (profile.input) {
    const active = simulationParts(d);
    const sourceDefinitions = profile.parts.filter(
      (p) => p.kind === 'V' && active.some((part) => part.ref === p.ref),
    );
    if (sourceDefinitions.length !== 1)
      throw new Error('This official chip profile requires one input voltage source.');
    const sourcePart = d.parts.find((p) => p.ref === sourceDefinitions[0].ref)!;
    const f = fields(d, sourcePart),
      type = f['Sim.Type'];
    const values = simulationSourceValues(
      type,
      f['Sim.Params'] || '',
      sourcePart.value,
      sourcePart.ref,
    );
    const voltage =
      type === 'DC'
        ? values.dc
        : type === 'PULSE'
          ? values.y2
          : (values.dc ?? 0) + Math.abs(values.ampl);
    if (
      !Number.isFinite(voltage) ||
      voltage < profile.input.minimum ||
      voltage > profile.input.maximum ||
      (type === 'PULSE' && values.y1 !== 0) ||
      (type === 'SIN' && (values.dc ?? 0) - Math.abs(values.ampl) < 0)
    )
      throw new Error(
        `Use ${profile.input.minimum}–${profile.input.maximum} V at the chip input; a startup pulse must start at 0 V.`,
      );
    const nets = spiceNets(d),
      controller = active.find(
        (p) => profile.parts.find((def) => def.ref === p.ref)?.kind === 'X',
      )!;
    if (!controller)
      throw new Error('Include the official controller in simulation before running this profile.');
    if (
      nets.node(sourcePart, '1') !== nets.node(controller, profile.input.pin) ||
      nets.node(sourcePart, '2') !== '0'
    )
      throw new Error('Connect the input voltage source to the controller VIN and ground pins.');
    for (const p of active)
      if (profile.parts.find((def) => def.ref === p.ref)?.kind === 'C') {
        const voltage = initialVoltage(d, p);
        if (voltage !== undefined && Math.abs(voltage) > profile.input.initialLimit)
          throw new Error(
            `${p.ref}: initial voltage exceeds this chip model's ${profile.input.initialLimit} V limit.`,
          );
      }
  }
  for (const t of schematicTexts(d.original))
    if (
      /(^|\n)\s*(?:\.|K\d+\s)/i.test(t.text) &&
      !profile.directives.some((directive) => directive === t.text)
    )
      throw new Error(
        'Custom simulation directives are not supported. Restore the original example annotations.',
      );
}
export function exampleSimulationSupportError(d: Circuit) {
  try {
    validate(d, exampleSimulationProfile(d)!);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}
export function buildExampleSpice(d: Circuit, c: TransientConfig): SpiceDeck {
  const profile = exampleSimulationProfile(d)!;
  validate(d, profile);
  const expected = exampleTransient(d);
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
      'Electrical settings are read from the schematic. Only Duration and Max. time step can be changed.',
    );
  validateTransientTiming(c);
  if (
    hasSimulationNoConnects(d) ||
    d.parts.length > 200 ||
    d.wires.length > 1000 ||
    d.labels.length + d.junctions.length > 1000
  )
    throw new Error('Unsupported simulation circuit size or no-connect markers.');
  const nets = spiceNets(d);
  const connections = new Map<string, Set<string>>();
  for (const p of simulationParts(d)) {
    const def = profile.parts.find((v) => v.ref === p.ref)!;
    if (def.kind === 'power') continue;
    const nodes = def.pinOrder.map((pin) => nets.node(p, pin));
    for (const a of nodes)
      for (const b of nodes) {
        if (!connections.has(a)) connections.set(a, new Set());
        connections.get(a)!.add(b);
      }
  }
  const reached = new Set(['0']),
    queue = ['0'];
  for (let i = 0; i < queue.length; i++)
    for (const n of connections.get(queue[i]) || []) {
      if (!reached.has(n)) {
        reached.add(n);
        queue.push(n);
      }
    }
  if (
    nets
      .probeNodes()
      .some(
        (entry) =>
          simulationParts(d).some((p) => p.id === entry.target.id) && !reached.has(entry.node),
      )
  )
    throw new Error('Disconnected circuit island. Connect all simulation components.');
  const modelIds = [
    ...new Set(
      profile.parts
        .filter((def) => simulationParts(d).some((p) => p.ref === def.ref))
        .map((p) => p.modelId)
        .filter(Boolean),
    ),
  ];
  const lines = [
    `OpenPE ${profile.title} transient`,
    `.options ${profile.id === 'kicad-class-d' ? 'itl4=1000 ' : ''}${Object.entries(profile.options)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
    ...modelIds.map((_, i) => `.include example-model-${i}.lib`),
    '.model OPENPE_DEFAULT_D D',
    '.model OPENPE_DEFAULT_NPN NPN',
    '.model OPENPE_DEFAULT_PNP PNP',
    '.model OPENPE_DEFAULT_M VDMOS',
    '.model OPENPE_BOOST_D D(Is=1u N=1.05 Rs=0.02)',
  ];
  let explicitInitialConditions = false;
  const currents: SpiceTrace[] = [];
  const identifiers = new Map<string, string>();
  d.parts.forEach((p, i) => {
    if (!participatesInSimulation(p)) return;
    const def = profile.parts.find((v) => v.ref === p.ref)!;
    if (def.kind === 'power') return;
    const ns = def.pinOrder.map((pin) => nets.node(p, pin));
    const name = `${def.kind}${i + 1}`;
    identifiers.set(p.ref.toLowerCase(), name);
    if (def.kind === 'T') {
      const magnetic = profile.magnetic;
      if (!magnetic || magnetic.ref !== p.ref || ns.length !== 4)
        throw new Error('Unsupported coupled inductor.');
      const { inductance, coupling } = magneticValues(d, p);
      lines.push(
        `LPRI${i} ${ns[0]} ${ns[1]} ${inductance}`,
        `LSEC${i} ${ns[2]} ${ns[3]} ${inductance}`,
        `K${i} LPRI${i} LSEC${i} ${coupling}`,
      );
      currents.push({
        label: `I(${p.ref}) · primary pin 1 → 2`,
        unit: 'A',
        vector: `i(lpri${i})`,
        targets: [{ kind: 'current', id: p.id }],
      });
      return;
    }
    const passiveBody = ['R', 'C', 'L'].includes(def.kind) ? passive(d, p, def) : '';
    // Native currents avoid extra equations and artificial shunt paths at sense nodes.
    // Time-dependent resistors become behavioral sources in ngspice; retain their
    // series measurement, along with the first-terminal measurement for BJTs.
    const measure = def.kind === 'Q' || (def.kind === 'R' && passiveBody.startsWith('r={'));
    const currentParameter = ({ R: 'i', C: 'i', D: 'id', M: 'id' } as Record<string, string>)[
      def.kind
    ];
    if (measure) {
      lines.push(`VSENSE${i + 1} ${ns[0]} sense${i + 1} 0`);
      ns[0] = `sense${i + 1}`;
    }
    if (profile.id.startsWith('reference-') && ['C', 'L'].includes(def.kind)) {
      const resistance = seriesResistance(d, p);
      if (resistance) {
        lines.push(`RSER${i} ${ns[0]} series${i} ${resistance}`);
        ns[0] = `series${i}`;
      }
    }
    let body = '';
    if (['R', 'C', 'L'].includes(def.kind)) body = passiveBody;
    else if (def.kind === 'V') body = source(d, p);
    else {
      const f = fields(d, p),
        expected = def.sim as Record<string, string>;
      const params = modelParameters(f['Sim.Params'] || '', expected['Sim.Params'] || '');
      body =
        def.modelName ||
        (def.kind === 'Q' ? `OPENPE_DEFAULT_${f['Sim.Device']}` : `OPENPE_DEFAULT_${def.kind}`);
      body +=
        ' ' +
        Object.entries(params)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ');
    }
    if (def.kind === 'C' || def.kind === 'L') {
      const initial = primitiveInitialCondition(def.kind, fields(d, p), p.ref);
      if (initial !== undefined) {
        body += ` IC=${initial}`;
        explicitInitialConditions = true;
      }
    }
    lines.push(`${name} ${ns.join(' ')} ${body}`);
    if (def.kind !== 'X')
      currents.push({
        label: `I(${p.ref}) · pin ${def.pinOrder[0]} → ${def.pinOrder.at(-1)}`,
        unit: 'A',
        vector: measure
          ? `i(vsense${i + 1})`
          : currentParameter
            ? `@${name.toLowerCase()}[${currentParameter}]`
            : `i(${name.toLowerCase()})`,
        targets: [{ kind: 'current', id: p.id }],
        ...(['R', 'D', 'M'].includes(def.kind) && {
          dissipation: {
            positivePin: def.pinOrder[0],
            negativePin: def.kind === 'M' ? def.pinOrder[2] : def.pinOrder[1],
            positiveNode: nets.node(p, def.pinOrder[0]),
            negativeNode: nets.node(p, def.kind === 'M' ? def.pinOrder[2] : def.pinOrder[1]),
            method:
              def.kind === 'R'
                ? ('resistor' as const)
                : def.kind === 'D'
                  ? ('diode' as const)
                  : ('mosfet' as const),
          },
        }),
      });
  });
  // Only verified upstream coupling declarations are compiled, using current component identities.
  for (const annotation of profile.directives) {
    if (!schematicTexts(d.original).some((t) => t.text === annotation)) {
      if (/^K\d+\s/i.test(annotation))
        throw new Error('The transformer coupling annotation is missing.');
      continue;
    }
    for (const match of annotation.matchAll(/^K(\d+)\s+(L\w+)\s+(L\w+)\s+([\d.]+)$/gim)) {
      const a = identifiers.get(match[2].toLowerCase()),
        b = identifiers.get(match[3].toLowerCase());
      if (!a || !b) throw new Error('Coupled inductor is missing.');
      lines.push(`K${match[1]} ${a} ${b} ${Number(match[4])}`);
    }
  }
  const traces: SpiceTrace[] = [];
  for (const entry of nets.probeNodes()) {
    if (entry.node === '0' || !reached.has(entry.node)) continue;
    const vector = `v(${entry.node})`;
    let trace = traces.find((t) => t.vector === vector);
    if (!trace) {
      trace = { label: `V(${entry.label || entry.node})`, unit: 'V', vector, targets: [] };
      traces.push(trace);
    }
    trace.targets!.push(entry.target);
    if (d.labels.some((l) => l.id === entry.target.id)) trace.label = `V(${entry.label})`;
  }
  traces.push(...currents);
  const vectors = traces.map((t) => t.vector).join(' ');
  lines.push(
    `.save ${vectors}`,
    '.control',
    'set wr_singlescale',
    'set wr_vecnames',
    'set numdgt=15',
    `tran ${transientOutputStep(c)} ${c.stop} 0 ${c.step}${profile.initialConditions || explicitInitialConditions ? ' uic' : ''}`,
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
    modelIds,
    compatibility: 'ps',
    assumptions: [
      profile.id.startsWith('reference-')
        ? `${
            profile.parts.some((p) => p.modelName === lm2596AdjustableDerivedModel.subcircuit)
              ? lm2596AdjustableDerivedModel.description
              : 'Hash-verified official TI controller models and source-embedded pins.'
          } Electrical values and explicit initial conditions follow the current schematic; generic diodes and ideal coupled inductors remain approximations.`
        : 'Verified KiCad demo models and original Sim.Pins. Electrical values follow the current schematic.',
      'Only generated analysis commands are executed; schematic control annotations are not executed.',
      'Model results are not ERC, thermal analysis or production validation.',
    ],
  };
}
