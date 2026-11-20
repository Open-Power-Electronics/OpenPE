import { parseCircuit, type Circuit } from '../lib/circuit';
import { child, children, quote, val, writeSExpr, parseSExpr } from '../lib/sexpr';

// Reviewed physical symbol pins follow the bounded compiler's terminal order.
// The EMC Q1 symbol is named IRF540N upstream, but its fitted model is IRF520N
// and its physical gate/drain pins are 1/2, unlike the separate Buck fixture.
const bindings = [
  ['Q1', 'Transistor_FET:IRF540N', 'EMC_IRF520N', 'EMC_IRF520N', 'NMOS', 'VDMOS', '2=D 1=G 3=S'],
  ['D2', 'Device:D', 'EMC_ES2D', 'EMC_ES2D', 'D', '', '2=A 1=K'],
  ['D3', 'Device:D_Schottky', 'EMC_SS510C', 'EMC_SS510C', 'D', '', '2=A 1=K'],
  ['D7', 'Device:D_Schottky', 'EMC_SS510C', 'EMC_SS510C', 'D', '', '2=A 1=K'],
  [
    'U1',
    'Regulator_Controller:UC3845_SOIC8',
    'EMC_flyback_control',
    'UC3845B',
    'SUBCKT',
    '',
    '1=1 2=2 3=3 4=4 5=5 6=6 7=7 8=8',
  ],
  [
    'U3',
    'Reference_Voltage:TL431DBZ',
    'EMC_flyback_control',
    'TL431B',
    'SUBCKT',
    '',
    '1=1 3=2 2=3',
  ],
  ['U4', 'Isolator:LTV-817S', 'EMC_flyback_control', 'LTV817', 'SUBCKT', '', '1=1 2=2 4=3 3=4'],
] as const;

/** Generation only: persist the libraries actually used by the reviewed bench. */
export function prepareEmcFlybackModelBindings(circuit: Circuit) {
  for (const [ref, libId, library, name, device, type, pins] of bindings) {
    const parts = circuit.parts.filter((part) => part.ref === ref && part.libId === libId);
    if (parts.length !== 1) throw new Error(`Restore the reviewed EMC Flyback ${ref} symbol.`);
    const part = parts[0];
    part.fields = {
      ...part.fields,
      'Sim.Library': `models/${library}.lib`,
      'Sim.Name': name,
      'Sim.Device': device,
      ...(type ? { 'Sim.Type': type } : {}),
      'Sim.Pins': pins,
    };
  }
}

/** Keep unrelated native records, order and metadata while adding hidden bindings. */
export function prepareEmcFlybackNativeModelBindings(source: string) {
  const circuit = parseCircuit(source);
  prepareEmcFlybackModelBindings(circuit);
  const root = parseSExpr(source);
  for (const [ref] of bindings) {
    const part = circuit.parts.find((part) => part.ref === ref)!;
    const symbol = children(root, 'symbol').find(
      (symbol) => val(child(symbol, 'uuid')) === part.id,
    )!;
    for (const [name, value] of Object.entries(part.fields!).filter(([name]) =>
      name.startsWith('Sim.'),
    )) {
      const existing = children(symbol, 'property').find((property) => val(property) === name);
      if (existing) existing[2] = quote(value);
      else
        symbol.push([
          'property',
          quote(name),
          quote(value),
          ['at', String(part.x), String(part.y), '0'],
          ['effects', ['font', ['size', '1.27', '1.27']], 'hide'],
        ]);
    }
  }
  return writeSExpr(root) + '\n';
}
