import type { LucideIcon } from 'lucide-react';

export default function RevealButton({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`reveal-button${active ? ' active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="reveal-button-label" aria-hidden="true">
        <span>{label}</span>
      </span>
    </button>
  );
}
