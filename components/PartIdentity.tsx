import type { ReactNode } from 'react';
import type { Part } from '@/lib/circuit';
import type { SExpr } from '@/lib/sexpr';
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
  return (
    <div className="inspector-symbol">
      <SymbolPreview library={library} unit={part.unit} part={part} />
      <div>
        <strong title={part.libId}>{part.libId}</strong>
      </div>
      {actions}
    </div>
  );
}
