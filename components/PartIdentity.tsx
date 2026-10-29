import type { ReactNode } from 'react';
import type { Part } from '@/lib/circuit';
import type { SExpr } from '@/lib/sexpr';
import { displayPartValue } from '@/lib/library';
import SymbolPreview from './SymbolPreview';

export default function PartIdentity({
  part,
  library,
  actions,
}: {
  part: Part;
  library: SExpr;
  actions?: ReactNode;
}) {
  const value = displayPartValue(part);
  return (
    <div className="inspector-symbol">
      <SymbolPreview library={library} unit={part.unit} part={part} />
      <div>
        <strong aria-description={part.ref}>{part.ref}</strong>
        <span aria-description={value}>{value}</span>
      </div>
      {actions}
    </div>
  );
}
