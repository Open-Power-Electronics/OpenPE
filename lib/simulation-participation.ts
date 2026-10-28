import { pinPositions, type Circuit, type Part } from './circuit';
import { child, val, type SExpr } from './sexpr';
import { onWire } from './wiring';

/** Defaults apply only to new placements; existing documents retain their flags. */
export function defaultSimulationParticipation(library: SExpr): boolean {
  const namespace = val(library).split(':')[0];
  return !/^Connector(?:_|$)/.test(namespace) && val(child(library, 'exclude_from_sim')) !== 'yes';
}

export function participatesInSimulation(part: Part): boolean {
  return part.excludeFromSimulation === undefined
    ? val(child(part.raw ?? [], 'exclude_from_sim')) !== 'yes'
    : !part.excludeFromSimulation;
}

export function simulationParts(circuit: Circuit): Part[] {
  return circuit.parts.filter(participatesInSimulation);
}

/** Unused connector terminals can retain their no-connect markers. */
export function hasSimulationNoConnects(circuit: Circuit): boolean {
  if (!circuit.noConnects?.length) return false;
  const at = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) < 0.0001 && Math.abs(a.y - b.y) < 0.0001;
  const pins = circuit.parts.flatMap((part) =>
    pinPositions(part, circuit.libraries[part.libId]).map((point) => ({
      ...point,
      included: participatesInSimulation(part),
    })),
  );
  return (circuit.noConnects ?? []).some((marker) => {
    const terminals = pins.filter((pin) => at(pin, marker));
    return (
      !terminals.length ||
      terminals.some((pin) => pin.included) ||
      circuit.wires.some((wire) => onWire(marker, wire))
    );
  });
}
