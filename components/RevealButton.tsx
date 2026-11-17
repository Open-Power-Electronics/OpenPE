import type { LucideIcon } from 'lucide-react';

export default function RevealButton({
  icon: Icon,
  label,
  onClick,
  active,
  className = '',
  iconSize = 16,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  className?: string;
  iconSize?: number;
}) {
  return (
    <button
      type="button"
      className={`reveal-button${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon size={iconSize} aria-hidden="true" />
      <span className="reveal-button-label" aria-hidden="true">
        <span>{label}</span>
      </span>
    </button>
  );
}
