import { child, children, val, type SExpr } from './sexpr';

/** KiCad's footprint-text orientation flag is independent of its editing lock. */
export function footprintTextPlacement(node: SExpr, fail: (message: string) => never) {
  const at = child(node, 'at');
  const inPosition = at?.at(-1) === 'unlocked';
  const flags = children(node, 'unlocked');
  const bare = node.filter((item) => item === 'unlocked').length;
  const [flag] = flags;
  if (
    flags.length + bare + Number(inPosition) > 1 ||
    (flag && (flag.length !== 2 || !['yes', 'no'].includes(val(flag))))
  )
    fail('Invalid footprint text orientation flag.');
  return {
    at: inPosition ? at!.slice(0, -1) : at,
    unlocked: inPosition || bare === 1 || val(flag) === 'yes',
    flag,
    bare: bare === 1,
    inPosition,
  };
}
