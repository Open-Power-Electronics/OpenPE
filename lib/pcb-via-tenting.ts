import type { PCB } from './pcb';
import { children, type SExpr } from './sexpr';

type Tenting = NonNullable<PCB['vias'][number]['tenting']>;
const sides = ['front', 'back'] as const;

export function readPCBViaTenting(node: SExpr, fail: (message: string) => never) {
  const records = children(node, 'tenting');
  if (records.length === 0) return;
  const [record] = records;
  if (records.length !== 1 || record.length < 2 || record.length > 3)
    return fail('Invalid via tenting settings.');
  const tenting: Tenting = {};
  for (const side of record.slice(1)) {
    if (
      !Array.isArray(side) ||
      side.length !== 2 ||
      (side[0] !== 'front' && side[0] !== 'back') ||
      (side[1] !== 'yes' && side[1] !== 'no') ||
      Object.hasOwn(tenting, side[0])
    )
      return fail('Invalid via tenting settings.');
    tenting[side[0]] = side[1] === 'yes';
  }
  return tenting;
}

export function writePCBViaTenting(tenting: Tenting) {
  const flags = sides.flatMap((side) =>
    tenting[side] === undefined ? [] : [`(${side} ${tenting[side] ? 'yes' : 'no'})`],
  );
  return `(tenting ${flags.join(' ')})`;
}
