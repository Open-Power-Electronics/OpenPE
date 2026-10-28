import { createPart, catalog, type Circuit, type Kind } from './circuit';
import { partFields } from './library';
import { preparePartProperties } from './part-properties';
import { removeSelection } from './schematic-edit';
export type Operation =
  | { type: 'setValue'; ref: string; value: string }
  | { type: 'addPart'; kind: Kind; x: number; y: number; value?: string }
  | { type: 'removePart'; ref: string };
export function extractProposal(text: string): Operation[] | null {
  const match = text.match(/```openpe\s*([\s\S]*?)```/);
  if (!match) return null;
  const parsed = JSON.parse(match[1]);
  if (!Array.isArray(parsed) || parsed.length > 100)
    throw new Error('A proposal must be an array of at most 100 operations.');
  if (!parsed.length) return null;
  for (const p of parsed) {
    if (!p || typeof p !== 'object') throw new Error('Invalid edit proposal.');
    if (p.type === 'setValue') {
      if (
        typeof p.ref !== 'string' ||
        typeof p.value !== 'string' ||
        !p.value.trim() ||
        p.value.length > 200
      )
        throw new Error('Invalid component value.');
    } else if (p.type === 'addPart') {
      if (
        !catalog.some((c) => c.kind === p.kind) ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        Math.abs(p.x) > 1000 ||
        Math.abs(p.y) > 1000 ||
        (p.value !== undefined && (typeof p.value !== 'string' || p.value.length > 200))
      )
        throw new Error('Invalid component or position.');
    } else if (p.type === 'removePart') {
      if (typeof p.ref !== 'string') throw new Error('Invalid reference.');
    } else throw new Error('The proposal contains an unsupported operation.');
  }
  return parsed;
}
export function applyProposal(doc: Circuit, ops: Operation[]): Circuit {
  let d = structuredClone(doc);
  for (const op of ops) {
    if (op.type === 'addPart') {
      const part = createPart(d, op.kind, op.x, op.y);
      if (op.value) part.value = op.value;
      d.parts.push(part);
    } else {
      const p = d.parts.find((p) => p.ref === op.ref);
      if (!p) throw new Error(`Cannot find ${op.ref}. Generate a fresh proposal.`);
      if (op.type === 'setValue') {
        for (const unit of d.parts.filter((x) => x.ref === op.ref)) {
          const change = preparePartProperties(
            unit,
            unit.ref,
            op.value,
            Object.entries(partFields(unit)).map(([name, value]) => ({ name, value })),
          );
          if (change) Object.assign(unit, change);
        }
      } else
        d = removeSelection(
          d,
          d.parts.filter((x) => x.ref === op.ref).map((x) => x.id),
        );
    }
  }
  return d;
}
