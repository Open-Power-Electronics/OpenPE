import type { Part } from '@/lib/circuit';
import type { SExpr } from '@/lib/sexpr';
import SymbolPreview from './SymbolPreview';

export default function PartIdentity({ part, library }: { part: Part; library: SExpr }) {
  return (
    <div className="inspector-symbol">
      <SymbolPreview library={library} unit={part.unit} part={part} />
      <div>
        <strong aria-description={part.ref}>{part.ref}</strong>
        <span aria-description={part.libId}>{part.libId.split(':').at(-1)}</span>
      </div>
    </div>
  );
}
