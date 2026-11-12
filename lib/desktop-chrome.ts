export type DesktopChrome = 'overlay' | 'inset';

/** Custom caption is overlay on Windows and inset for macOS traffic lights. */
export function desktopChrome(
  bridge: { titleBarOverlay?: boolean; titleBarInset?: boolean } | undefined,
): DesktopChrome | null {
  if (bridge?.titleBarOverlay !== true) return null;
  if (bridge.titleBarInset === true) return 'inset';
  if (bridge.titleBarInset === false) return 'overlay';
  throw new Error('Desktop caption requires titleBarInset.');
}
