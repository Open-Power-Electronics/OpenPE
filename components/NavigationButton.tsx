import type { LucideIcon } from 'lucide-react';

export default function NavigationButton({
  icon: Icon,
  label,
  onClick,
  compact = false,
  active = false,
  unsaved = false,
  accessibleLabel = label,
  hasMenu = false,
  menuOpen = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  compact?: boolean;
  active?: boolean;
  unsaved?: boolean;
  accessibleLabel?: string;
  hasMenu?: boolean;
  menuOpen?: boolean;
}) {
  const className = `navigation-button ${compact ? 'rail-button' : 'home-nav-item'}${active ? ' active' : ''}`;
  const content = (
    <>
      <Icon size={18} aria-hidden="true" />
      {!compact && <span>{label}</span>}
      {unsaved && <span className="dirty-dot" aria-hidden="true" />}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={className}
      title={compact ? label : undefined}
      aria-description={label}
      aria-label={accessibleLabel}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      aria-haspopup={hasMenu ? 'menu' : undefined}
      aria-expanded={hasMenu ? menuOpen : undefined}
    >
      {content}
    </button>
  ) : (
    <span
      className={className}
      role="img"
      title={compact ? label : undefined}
      aria-description={label}
      aria-label={accessibleLabel}
      aria-current={active ? 'page' : undefined}
    >
      {content}
    </span>
  );
}
