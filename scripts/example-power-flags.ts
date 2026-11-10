import { libraries, type Circuit, type Point } from '../lib/circuit';
import { createLibraryPart } from '../lib/library';

export function addLabeledPowerFlag(
  circuit: Circuit,
  rail: string,
  position: Point,
  stable: (key: string) => string,
) {
  const libId = 'power:PWR_FLAG';
  const library = (circuit.libraries[libId] ??= structuredClone(libraries[libId]));
  const flag = createLibraryPart(circuit, library, position.x, position.y);
  flag.id = stable(`power-flag:${rail}`);
  circuit.parts.push(flag);
  circuit.labels.push({ ...position, id: stable(`power-flag:${rail}:label`), text: rail });
  return flag;
}
