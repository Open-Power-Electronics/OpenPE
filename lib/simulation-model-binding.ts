import type { Circuit, Part } from './circuit';
import { partFields, unitGraphics } from './library';
import { child, children, val } from './sexpr';
import { reviewedSimulationDevice, reviewedSimulationPins } from './simulation-model-source';

export type ExternalModelDeclaration = {
  name: string;
  kind: 'model' | 'subcircuit';
  device?: string;
  pins: string[];
};

export type SymbolModelPin = { number: string; name: string };
export type ExternalModelBinding = {
  kind: 'model' | 'subcircuit';
  terminals: string[];
  symbolPins: SymbolModelPin[];
  /** A complete, electrically named or exact-ID mapping, never positional inference. */
  mapping: Record<string, string> | null;
  suggested: Record<string, string>;
  missing: string[];
  compatible: boolean;
  reason?: string;
};

const token = /^[^\s=\x00-\x1f\x7f]{1,128}$/;
const modelName = /^[A-Za-z0-9_][A-Za-z0-9_.$:#-]{0,127}$/;
const modelRoles: Record<string, readonly string[]> = {
  R: ['+', '-'],
  C: ['+', '-'],
  L: ['+', '-'],
  D: ['A', 'K'],
  NPN: ['C', 'B', 'E'],
  PNP: ['C', 'B', 'E'],
  NMOS: ['D', 'G', 'S', 'B'],
  PMOS: ['D', 'G', 'S', 'B'],
  VDMOS: ['D', 'G', 'S'],
  NJF: ['D', 'G', 'S'],
  PJF: ['D', 'G', 'S'],
};

function semanticRole(value: string): string {
  const name = value.trim().toUpperCase();
  return (
    (
      {
        DRAIN: 'D',
        GATE: 'G',
        SOURCE: 'S',
        ANODE: 'A',
        CATHODE: 'K',
        COLLECTOR: 'C',
        EMITTER: 'E',
        POS: '+',
        POSITIVE: '+',
        PLUS: '+',
        NEG: '-',
        NEGATIVE: '-',
        MINUS: '-',
      } as Record<string, string>
    )[name] ?? name
  );
}

function deviceFamily(device: string): string | null {
  const name = device.toUpperCase();
  if (['R', 'C', 'L', 'D', 'V', 'I'].includes(name)) return name;
  if (['NPN', 'PNP', 'NPN4', 'PNP4'].includes(name)) return 'Q';
  if (['NMOS', 'PMOS', 'VDMOS', 'MOS'].includes(name)) return 'M';
  if (['NJF', 'PJF', 'JFET'].includes(name)) return 'J';
  return null;
}

function symbolFamily(circuit: Circuit, part: Part): string | null {
  if (/^(?:Device|Simulation_SPICE):R(?:_|$)/.test(part.libId)) return 'R';
  if (/^(?:Device|Simulation_SPICE):(?:C|CP)(?:_|$)/.test(part.libId)) return 'C';
  if (/^(?:Device|Simulation_SPICE):L(?:_|$)/.test(part.libId)) return 'L';
  if (/^(?:Device|Simulation_SPICE):(?:D|LED)(?:_|$)/.test(part.libId)) return 'D';
  if (part.libId.startsWith('Transistor_BJT:')) return 'Q';
  if (part.libId.startsWith('Transistor_FET:')) return 'FET';
  const library = circuit.libraries[part.libId];
  const native =
    partFields(part)['Sim.Device'] ||
    (library &&
      val(
        children(library, 'property').find((node) => val(node) === 'Sim.Device'),
        2,
      ));
  return native ? deviceFamily(native) : null;
}

function modelDeviceAttributes(
  part: Part,
  declaration: ExternalModelDeclaration,
): Record<string, string | undefined> {
  if (declaration.kind === 'subcircuit') return { 'Sim.Device': 'SUBCKT', 'Sim.Type': undefined };
  const device = declaration.device?.toUpperCase() || '';
  if (['R', 'C', 'L', 'D'].includes(device)) return { 'Sim.Device': device, 'Sim.Type': undefined };
  const explicit = partFields(part)['Sim.Device']?.toUpperCase();
  const reviewed = reviewedSimulationDevice(part)?.toUpperCase();
  const identity = part.libId.match(/(?:^|[_:])(NPN|PNP|NMOS|PMOS|NJFET|PJFET)(?:_|$)/)?.[1];
  const known = [reviewed, identity, explicit].filter(
    (value): value is string =>
      !!value && ['NPN', 'PNP', 'NMOS', 'PMOS', 'NJFET', 'PJFET'].includes(value),
  );
  const target = [...new Set(known)];
  if (target.length !== 1)
    throw new Error('The symbol polarity is ambiguous. Choose a matching typed symbol.');
  if (device === 'VDMOS') {
    if (!['NMOS', 'PMOS'].includes(target[0]))
      throw new Error('The model polarity does not match the component.');
    return { 'Sim.Device': target[0], 'Sim.Type': 'VDMOS' };
  }
  const nativeDevice = ({ NJF: 'NJFET', PJF: 'PJFET' } as Record<string, string>)[device] || device;
  if (target[0] !== nativeDevice)
    throw new Error('The model polarity does not match the component.');
  return { 'Sim.Device': nativeDevice, 'Sim.Type': undefined };
}

function physicalPins(circuit: Circuit, part: Part): SymbolModelPin[] {
  const library = circuit.libraries[part.libId];
  if (!library) throw new Error('The component symbol is unavailable.');
  const pins = new Map<string, SymbolModelPin>();
  for (const pin of unitGraphics(library, part.unit || 1).flatMap((unit) =>
    children(unit, 'pin'),
  )) {
    const number = val(child(pin, 'number')),
      name = val(child(pin, 'name'));
    if (!token.test(number)) throw new Error('The component has an unsupported pin identifier.');
    const existing = pins.get(number);
    if (existing && existing.name !== name)
      throw new Error('The component pin definitions are ambiguous.');
    pins.set(number, { number, name });
  }
  if (!pins.size || pins.size > 64)
    throw new Error('The model requires a symbol with 1–64 physical pins.');
  return [...pins.values()];
}

function nativeRolePins(
  pins: SymbolModelPin[],
  text: string | null | undefined,
): Record<string, string> {
  if (!text) return {};
  const result: Record<string, string> = Object.create(null);
  const numbers = new Set<string>();
  for (const item of text.trim().split(/\s+/)) {
    const pair = item.split('=');
    if (
      pair.length !== 2 ||
      !token.test(pair[0]) ||
      !token.test(pair[1]) ||
      !pins.some((pin) => pin.number === pair[0]) ||
      numbers.has(pair[0])
    )
      return {};
    const role = semanticRole(pair[1]);
    if (Object.hasOwn(result, role)) return {};
    result[role] = pair[0];
    numbers.add(pair[0]);
  }
  return result;
}

export function externalModelBinding(
  circuit: Circuit,
  part: Part,
  declaration: ExternalModelDeclaration,
): ExternalModelBinding {
  if (
    !modelName.test(declaration.name) ||
    !['model', 'subcircuit'].includes(declaration.kind) ||
    !Array.isArray(declaration.pins) ||
    declaration.pins.length > 64 ||
    declaration.pins.some((pin) => !token.test(pin))
  )
    throw new Error('Invalid external model declaration.');
  const pins = physicalPins(circuit, part);
  const roles =
    declaration.kind === 'model'
      ? modelRoles[declaration.device?.toUpperCase() || '']
      : declaration.pins;
  if (!roles?.length) throw new Error('This model device type has no supported pin definition.');
  const terminals = [...roles];
  if (new Set(terminals.map((value) => value.toUpperCase())).size !== terminals.length)
    throw new Error('The model declares duplicate terminals.');
  const family = declaration.kind === 'model' ? deviceFamily(declaration.device || '') : null;
  const nativeFamily = symbolFamily(circuit, part);
  let reason: string | undefined;
  if (
    family &&
    nativeFamily &&
    family !== nativeFamily &&
    !(nativeFamily === 'FET' && ['M', 'J'].includes(family))
  )
    reason = 'The model device type does not match the component.';
  else if (terminals.length !== pins.length)
    reason = `The model has ${terminals.length} terminals; the symbol has ${pins.length} pins.`;
  if (!reason) {
    try {
      modelDeviceAttributes(part, declaration);
    } catch (error) {
      reason = error instanceof Error ? error.message : 'The model device type is unsupported.';
    }
  }
  const suggested: Record<string, string> = Object.create(null);
  const native = Object.assign(
    Object.create(null),
    nativeRolePins(pins, reviewedSimulationPins(part)),
    nativeRolePins(pins, partFields(part)['Sim.Pins']),
  ) as Record<string, string>;
  // These identities have documented positive/negative native terminal numbers.
  if (
    declaration.kind === 'model' &&
    ['R', 'C', 'L'].includes(family || '') &&
    family === nativeFamily &&
    !partFields(part)['Sim.Pins'] &&
    pins.length === 2 &&
    pins.some((pin) => pin.number === '1') &&
    pins.some((pin) => pin.number === '2')
  ) {
    if (!native['+']) native['+'] = '1';
    if (!native['-']) native['-'] = '2';
  }
  for (const terminal of terminals) {
    const role = semanticRole(terminal);
    const exact = /^\d+$/.test(terminal) ? pins.find((pin) => pin.number === terminal) : undefined;
    const named = pins.filter(
      (pin) => pin.name && pin.name !== '~' && semanticRole(pin.name) === role,
    );
    const number =
      declaration.kind === 'subcircuit' && /^\d+$/.test(terminal)
        ? exact?.number
        : native[role] || exact?.number || (named.length === 1 ? named[0].number : undefined);
    if (number) suggested[terminal] = number;
  }
  const missing = terminals.filter((terminal) => !suggested[terminal]);
  const unique = new Set(Object.values(suggested)).size === Object.keys(suggested).length;
  const compatible = !reason;
  return {
    kind: declaration.kind,
    terminals,
    symbolPins: pins,
    mapping: compatible && !missing.length && unique ? { ...suggested } : null,
    suggested,
    missing,
    compatible,
    ...(reason ? { reason } : {}),
  };
}

export function validateExternalModelMapping(
  binding: ExternalModelBinding,
  mapping: Record<string, string>,
): string {
  if (!binding.compatible)
    throw new Error(binding.reason || 'The model is incompatible with this symbol.');
  if (
    Object.keys(mapping).length !== binding.terminals.length ||
    Object.keys(mapping).some((key) => !binding.terminals.includes(key)) ||
    binding.terminals.some(
      (terminal) => !binding.symbolPins.some((pin) => pin.number === mapping[terminal]),
    ) ||
    new Set(Object.values(mapping)).size !== binding.terminals.length
  )
    throw new Error('Map every model terminal to a different symbol pin.');
  return binding.terminals
    .map(
      (terminal, index) =>
        `${mapping[terminal]}=${binding.kind === 'subcircuit' ? index + 1 : terminal}`,
    )
    .join(' ');
}

export function externalModelBindingFields(
  circuit: Circuit,
  part: Part,
  declaration: ExternalModelDeclaration,
  mapping?: Record<string, string>,
): Record<string, string | undefined> {
  const binding = externalModelBinding(circuit, part, declaration),
    selected = mapping ?? binding.mapping;
  if (!selected) throw new Error(binding.reason || 'Confirm the model pin mapping.');
  return {
    ...modelDeviceAttributes(part, declaration),
    'Sim.Name': declaration.name,
    'Sim.Pins': validateExternalModelMapping(binding, selected),
  };
}
