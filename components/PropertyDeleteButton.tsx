import { Trash2 } from 'lucide-react';

/** One deletion affordance for all Properties docks. Domain owners retain their gates. */
export default function PropertyDeleteButton({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-button property-delete-action"
      aria-label="Delete object"
      title="Delete object"
      data-edit-action
      disabled={disabled}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={onClick}
    >
      <Trash2 size={16} aria-hidden />
    </button>
  );
}
