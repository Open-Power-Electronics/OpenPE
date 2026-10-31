import { createHash } from 'node:crypto';
import {
  createPart,
  libraries,
  pinPositions,
  serializeCircuit,
  snap,
  type Circuit,
  type Part,
} from '../lib/circuit';
import { createLibraryPart, partFields, unitGraphics } from '../lib/library';
import { child, children, parseSExpr, quote, val } from '../lib/sexpr';
import { moveSelection } from '../lib/schematic-edit';
import { onWire, samePoint } from '../lib/wiring';
import { spiceNets } from '../lib/spice';
import models from '../resources/reference-models-lock.json';
import { lm2596AdjustableDerivedModel, tiModels } from '../lib/ti-dcdc';

const stable = (seed: string) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const settings: Record<
  string,
  {
    voltage: number;
    load: number;
    pins: string[];
    values?: Record<string, string>;
    sourceRise?: string;
  }
> = {
  'lm2596-5': {
    voltage: 12,
    load: 100,
    pins: ['1', '4', '2', '3', '5'],
    values: { R1: '3.09k', R2: '1.01k' },
  },
  'reference-lm2735y': {
    voltage: 5,
    load: 100,
    pins: ['3', '4', '7', '5', '2'],
    values: { R2: '180k' },
  },
  'reference-lm5001': { voltage: 24, load: 100, pins: ['1', '2', '3', '4', '5', '6', '7', '8'] },
  'reference-lm27761': {
    voltage: 5,
    load: 100,
    pins: ['7', '8', '6', '5', '3', '1', '4', '9', '2'],
    values: { R1: '17.4k' },
  },
  'reference-tps61046': {
    voltage: 3.3,
    load: 1000,
    pins: ['A1', 'C1', 'A2', 'B1', 'C2', 'B2'],
    values: { R1: '232k' },
  },
  'reference-lm2598-adj': {
    voltage: 24,
    load: 100,
    pins: ['2', '6', '1', '4', '5', '7', '3'],
    values: { R1: '4.7k' },
  },
  'reference-lmr12010x': { voltage: 12, load: 100, pins: ['1', '2', '3', '4', '5', '6'] },
  'reference-lmr70503': {
    voltage: 5,
    load: 100,
    pins: ['D2', 'B1', 'C1', 'A1', 'A2', 'B2', 'D1'],
    values: { C2: '47pF', R3: '300k' },
  },
  'reference-lm25017': {
    voltage: 24,
    load: 100,
    pins: ['4', '1', '9', '5', '8', '7', '6', '2', '3'],
    values: { L1: '100uH', C5: '10nF' },
    sourceRise: '100u',
  },
};

// Curated against rendered symbol/annotation bounds. Columns include the complete
// terminal assembly, followed by the source and loads; stacked single-pin pairs
// remain together. The row spans the lower circuit with equal visible gaps.
const benchLayouts: Record<string, { connectors: number[]; simulation: number[]; dy?: number }> = {
  'reference-lm2596-to220-5-buck': {
    connectors: [34.29, 73.66],
    simulation: [104.14, 133.35],
  },
  'reference-tps61046-bga6-boost': {
    connectors: [35.56, 66.04],
    simulation: [86.36, 106.68],
    dy: -6.35,
  },
  'reference-lm2735-msop8-sepic': {
    connectors: [33.02, 59.69, 86.36],
    simulation: [102.87, 154.94],
    dy: -1.27,
  },
  'reference-lm25017-wson8-flybuck': {
    connectors: [38.1, 63.5, 88.9],
    simulation: [104.14, 157.48, 171.45],
    dy: -2.54,
  },
  'reference-lm5001-soic8-boost': {
    connectors: [36.83, 72.39],
    simulation: [97.79, 160.02],
  },
  'reference-lm27761-wson8-pump': {
    connectors: [29.21, 69.85],
    simulation: [97.79, 115.57],
  },
  'reference-lmr12010-sot236-buck': {
    connectors: [34.29, 66.04, 97.79],
    simulation: [113.03, 165.1],
  },
  'reference-lmr70503-bga8-buckboost': {
    connectors: [34.29, 68.58],
    simulation: [93.98, 118.11],
  },
  'reference-lm2598-to220-7-buck': {
    connectors: [39.37, 77.47, 115.57],
    simulation: [144.78, 172.72],
    dy: -1.27,
  },
};

/** Move only the physically attached terminal assemblies, never named-net peers. */
function simulationBenchPosition(d: Circuit, id: string) {
  const connectors = d.parts.filter(
    (part) => /^J\d+$/.test(part.ref) && /^Connector(?:_|:)/.test(part.libId),
  );
  if (!connectors.length) throw new Error('Example testbench requires a connector row.');
  const pins = connectors.flatMap((part) => pinPositions(part, d.libraries[part.libId]));
  const columns = [...new Set(connectors.map((part) => part.x))].sort((a, b) => a - b);
  const layout = benchLayouts[id];
  if (!layout || layout.connectors.length !== columns.length)
    throw new Error(`${id}: missing terminal row layout.`);
  const assemblies = columns.map((x) => {
    const parts = connectors.filter((part) => part.x === x);
    const points = parts.flatMap((part) => pinPositions(part, d.libraries[part.libId]));
    const wires = new Set<string>();
    for (let changed = true; changed;) {
      changed = false;
      for (const wire of d.wires) {
        if (wires.has(wire.id) || !points.some((point) => onWire(point, wire))) continue;
        wires.add(wire.id);
        points.push(wire.a, wire.b);
        changed = true;
      }
    }
    const attached = (point: { x: number; y: number }) =>
      points.some((pin) => samePoint(point, pin)) ||
      d.wires.some((wire) => wires.has(wire.id) && onWire(point, wire));
    const ids = [
      ...parts.map((part) => part.id),
      ...d.parts
        .filter(
          (part) =>
            part.ref.startsWith('#') && pinPositions(part, d.libraries[part.libId]).some(attached),
        )
        .map((part) => part.id),
      ...wires,
      ...[...d.labels, ...d.junctions, ...(d.noConnects || [])]
        .filter(attached)
        .map((item) => item.id),
    ];
    return { x, ids };
  });
  const moved = new Set<string>();
  for (const [i, assembly] of assemblies.entries()) {
    if (assembly.ids.some((identifier) => moved.has(identifier)))
      throw new Error(`${id}: terminal assemblies must be physically separate.`);
    for (const identifier of assembly.ids) moved.add(identifier);
    Object.assign(
      d,
      moveSelection(d, assembly.ids, {
        x: snap(layout.connectors[i] - assembly.x),
        y: layout.dy ?? 0,
      }),
    );
  }
  return {
    x: layout.simulation,
    y: snap(
      (Math.min(...pins.map((pin) => pin.y)) + Math.max(...pins.map((pin) => pin.y))) / 2 +
        (layout.dy ?? 0),
    ),
  };
}

/** Testbench components are design content. No hidden input or output load is injected. */
export function prepareReferenceSimulation(d: Circuit, id: string, modelId: string) {
  const config = settings[modelId];
  if (!config) throw new Error(`${id}: missing official simulation model.`);
  const model = [...tiModels, ...models.models].find((m) => m.id === modelId)!;
  const controller = d.parts.find((p) => p.ref === 'U1')!;
  const originalIdentity = controller.libId;
  // Preserve source-embedded geometry, while giving modified dataset drawings an
  // honest project-local identity rather than the name of a different catalog chip.
  const localId = `Reference_${id.replace('reference-', '').replaceAll('-', '_')}`;
  const symbol = structuredClone(d.libraries[controller.libId]);
  symbol[1] = quote(localId);
  for (const unit of children(symbol, 'symbol')) {
    const suffix = val(unit).match(/_\d+_\d+$/)?.[0];
    if (!suffix) throw new Error(`${id}: invalid embedded unit identity.`);
    unit[1] = quote(localId + suffix);
  }
  d.libraries[localId] = symbol;
  controller.libId = localId;
  if (controller.raw) {
    const catalog: Record<string, string> = {
      'lm2596-5': 'Regulator_Switching:LM2596T-ADJ',
      'reference-lm5001': 'Regulator_Switching:LM5001MA',
      'reference-lm27761': 'Regulator_SwitchedCapacitor:LM27761',
    };
    child(controller.raw, 'lib_id')![1] = quote(
      catalog[modelId] ?? `Reference:${id.replace('reference-', '')}`,
    );
    const name = child(controller.raw, 'lib_name');
    if (name) name[1] = quote(localId);
    else controller.raw.push(['lib_name', quote(localId)]);
  }
  const pinOrder = config.pins;
  controller.value =
    modelId === 'lm2596-5' ? 'LM2596T-ADJ' : model.subcircuit.replace(/_TRANS$/i, '');
  controller.fields = {
    ...partFields(controller),
    'Sim.Device': 'SUBCKT',
    'Sim.Name': model.subcircuit,
    'Sim.Library': `TI:${model.id}`,
    'Sim.Pins': pinOrder.map((pin, i) => `${pin}=${i + 1}`).join(' '),
  };
  if (modelId === 'lm2596-5') {
    controller.fields['Sim.Name'] = lm2596AdjustableDerivedModel.subcircuit;
    controller.fields['Sim.Library'] = lm2596AdjustableDerivedModel.library;
    controller.fields.Description = lm2596AdjustableDerivedModel.description;
  }
  if (modelId === 'reference-tps61046') controller.fields['Sim.Params'] = 'STEADY=1';
  for (const p of d.parts) {
    if (/^Connector(?:_|:)/.test(p.libId)) p.excludeFromSimulation = true;
    if (config.values?.[p.ref]) p.value = config.values[p.ref];
    if (/^[CL]\d+$/.test(p.ref) && !(modelId === 'reference-lm25017' && p.ref === 'L1'))
      p.fields = { ...partFields(p), 'OpenPE.SeriesResistance': '50m' };
    if (modelId === 'reference-lm25017' && p.ref === 'L1')
      p.fields = { ...partFields(p), 'OpenPE.Coupling': '0.99' };
  }
  const initialVoltages: Record<string, Record<string, string>> = {
    'lm2596-5': { C1: '12', C2: '5' },
    'reference-lm2598-adj': { C3: '3' },
    'reference-tps61046': { C1: '3.3', C2: '-19', C3: '-19' },
    'reference-lm27761': { C1: '5', C2: '5', C3: '-5', C4: '-3.3' },
    'reference-lmr70503': { C1: '5', C2: '3.3', C3: '-3.3', C4: '-3.3' },
  };
  for (const p of d.parts)
    if (initialVoltages[modelId]?.[p.ref])
      p.fields = { ...partFields(p), 'OpenPE.InitialVoltage': initialVoltages[modelId][p.ref] };
  const before = spiceNets(d);
  const originalProbes = before.probeNodes();
  const rail = (name: string) => {
    const label = d.labels.find((l) => l.text === name);
    if (!label) throw new Error(`${id}: missing ${name}.`);
    return originalProbes.find((n) => n.target.id === label.id)!.node;
  };
  const grounds: { ref: string; x: number; y: number }[] = [];
  const attach = (part: Part, positive: string, levels: { top: number; ground: number }) => {
    part.id = stable(`${id}:${part.ref}`);
    d.parts.push(part);
    const pins = pinPositions(part, d.libraries[part.libId]);
    for (const [i, pin] of pins.entries()) {
      const endpoint = { x: pin.x, y: i === 0 ? levels.top : levels.ground };
      d.wires.push({ id: stable(`${id}:${part.ref}:lead:${i}`), a: pin, b: endpoint });
      if (i === 0) {
        d.labels.push({ id: stable(`${id}:${part.ref}:label:0`), ...endpoint, text: positive });
      } else {
        grounds.push({ ref: part.ref, ...endpoint });
      }
    }
  };
  const dc = !!initialVoltages[modelId];
  const bench = simulationBenchPosition(d, id);
  const source = createLibraryPart(
    d,
    libraries[dc ? 'Simulation_SPICE:VDC' : 'Simulation_SPICE:VPULSE'],
    bench.x[0],
    bench.y,
  );
  d.libraries[source.libId] = structuredClone(libraries[source.libId]);
  source.ref = 'V1';
  source.value = '${SIM.PARAMS}';
  source.fields = {
    'Sim.Device': 'V',
    'Sim.Type': dc ? 'DC' : 'PULSE',
    'Sim.Pins': '1=+ 2=-',
    'Sim.Params': dc
      ? `dc=${config.voltage}`
      : `y1=0 y2=${config.voltage} td=0 tr=${config.sourceRise ?? '10u'} tf=${config.sourceRise ?? '10u'} tw=1 per=2`,
  };
  // Align every rail label and GND marker with the source's short leads. The
  // smaller resistor symbols need slightly longer wires to reach those levels.
  const [positivePin, negativePin] = pinPositions(source, d.libraries[source.libId]);
  const levels = { top: snap(positivePin.y - 2.54), ground: snap(negativePin.y + 2.54) };
  attach(source, 'VIN', levels);
  const outputs = [...new Set(d.labels.filter((l) => /^VOUT\d*$/.test(l.text)).map((l) => l.text))];
  if (bench.x.length !== outputs.length + 1)
    throw new Error(`${id}: missing simulation row layout.`);
  const loads: string[] = [];
  for (const [i, name] of outputs.entries()) {
    rail(name);
    const load = createPart(d, 'R', bench.x[i + 1], bench.y);
    // Never inherit a resistor package from a source-library default.
    load.fields = { ...partFields(load), Footprint: '' };
    load.value = String(config.load);
    loads.push(load.ref);
    attach(load, name, levels);
  }
  // Append markers after every stamped component to retain their execution identities.
  for (const endpoint of grounds) {
    const ground = createPart(d, 'GND', endpoint.x, endpoint.y);
    ground.id = stable(`${id}:${endpoint.ref}:ground`);
    d.parts.push(ground);
  }
  // Discard only the now-unreferenced source alias, keeping all other embedded symbols.
  if (!d.parts.some((p) => p.libId === originalIdentity)) delete d.libraries[originalIdentity];
  // Materialize translated instance fields before the separate text-only layout
  // pass assigns absolute anchors. This avoids applying a terminal delta twice.
  const instances = new Map(
    children(parseSExpr(serializeCircuit(d)), 'symbol').map((symbol) => [
      val(child(symbol, 'uuid')),
      symbol,
    ]),
  );
  for (const part of d.parts) part.raw = instances.get(part.id);
  return {
    modelId,
    ...(modelId === 'lm2596-5' ? { derivedModel: lm2596AdjustableDerivedModel } : {}),
    originalIdentity,
    symbolIdentity: localId,
    testbench: { source: source.ref, loads, placement: 'distributed-above-circuit', virtual: true },
    correctedComponents: Object.keys(config.values ?? {}),
    initializedComponents: Object.keys(initialVoltages[modelId] ?? {}),
    ...(modelId === 'reference-lm25017' ? { magnetic: { windingRatio: '1:1' } } : {}),
  };
}

export function referenceProfile(d: Circuit, id: string, title: string, modelId: string) {
  const parts = d.parts.map((p) => {
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
    const sim = Object.fromEntries(
      Object.entries(partFields(p)).filter(([key]) => /^Sim\./.test(key)),
    );
    const kind =
      p.ref === 'U1'
        ? 'X'
        : p.ref === 'V1'
          ? 'V'
          : p.ref === 'L1' && modelId === 'reference-lm25017'
            ? 'T'
            : /^[RCLD]\d+$/.test(p.ref)
              ? p.ref[0]
              : 'power';
    const pinOrder =
      kind === 'X'
        ? sim['Sim.Pins'].split(/\s+/).map((m) => m.split('=')[0])
        : kind === 'D'
          ? ['2', '1']
          : pins.map((pin) => val(child(pin, 'number')));
    return {
      ref: p.ref,
      libId: p.libId,
      signature,
      kind,
      terminals: pinOrder,
      pinOrder,
      sim,
      modelId: kind === 'X' ? modelId : '',
      modelName: kind === 'X' ? sim['Sim.Name'] : kind === 'D' ? 'OPENPE_BOOST_D' : '',
      value: p.value,
    };
  });
  const inputLimits: Record<string, [number, number, number, number]> = {
    'lm2596-5': [0, 4.5, 40, 40],
    'reference-lm2735y': [0, 2.7, 5.5, 24],
    'reference-lm5001': [1, 3.1, 75, 75],
    'reference-lm27761': [5, 2.7, 5.5, 5.5],
    'reference-tps61046': [0, 1.8, 5.5, 28],
    'reference-lm2598-adj': [0, 4.5, 40, 40],
    'reference-lmr12010x': [4, 3, 20, 20],
    'reference-lmr70503': [0, 2.8, 5.5, 5.5],
    'reference-lm25017': [7, 4.5, 48, 48],
  };
  const [terminal, minimum, maximum, initialLimit] = inputLimits[modelId];
  return {
    id,
    title,
    stop: ['reference-tps61046', 'reference-lm27761'].includes(modelId) ? 0.002 : 0.01,
    input: {
      pin: parts.find((p) => p.kind === 'X')!.pinOrder[terminal],
      minimum,
      maximum,
      initialLimit,
    },
    step: modelId === 'reference-lm5001' ? 1e-8 : 2e-7,
    parts,
    directives: [],
    options: {
      itl4: '50',
      reltol: '0.005',
      method: 'gear',
      ...(modelId === 'lm2596-5'
        ? {}
        : {
            rshunt: '1e9',
            ...(modelId === 'reference-lmr70503' ? {} : { cshunt: '2f' }),
          }),
    },
    initialConditions: modelId !== 'reference-tps61046',
    magnetic: modelId === 'reference-lm25017' ? { ref: 'L1' } : undefined,
  };
}
