import type { LucideIcon } from 'lucide-react';

export default function PropertiesEmptyState({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="properties-empty-state">
      <Icon size={28} aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}
