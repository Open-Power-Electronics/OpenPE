import { pluginIcons } from '../plugins/renderer';

export function hasPluginLogo(id: string) {
  return Object.hasOwn(pluginIcons, id);
}

export default function PluginLogo({ id }: { id: string }) {
  const Icon = pluginIcons[id];
  if (!Icon) return null;
  return (
    <svg
      className="plugin-logo"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <Icon />
    </svg>
  );
}
