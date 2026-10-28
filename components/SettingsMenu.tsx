'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info, Settings } from 'lucide-react';
import { scrollMovesAnchor } from '@/lib/popup-scroll';
import NavigationButton from './NavigationButton';

export default function SettingsMenu({
  active,
  onSettings,
  onAbout,
}: {
  active: boolean;
  onSettings: () => void;
  onAbout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const actions = [
    { label: 'Settings', icon: Settings, run: onSettings },
    { label: 'About OpenPE', icon: Info, run: onAbout },
  ];
  function dismiss(restore = false) {
    setOpen(false);
    if (restore) host.current?.querySelector('button')?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  useLayoutEffect(() => {
    if (!open || !popup.current || !host.current) return;
    const menu = popup.current;
    const place = () => {
      const anchor = host.current!.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(anchor.right + 8, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(anchor.bottom - menu.offsetHeight, innerHeight - menu.offsetHeight - 8))}px`;
    };
    place();
    menu.querySelector('button')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !host.current?.contains(event.target as Node)
      )
        dismiss();
    };
    const hide = () => dismiss(true);
    const scroll = (event: Event) => {
      if (scrollMovesAnchor(event, host.current)) hide();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  return (
    <>
      <span ref={host} className="settings-menu-trigger">
        <NavigationButton
          compact
          icon={Settings}
          label="Settings"
          hasMenu
          menuOpen={open}
          onClick={() => setOpen((value) => !value)}
        />
      </span>
      {open &&
        createPortal(
          <div
            ref={popup}
            role="menu"
            aria-label="OpenPE menu"
            className="select-popup settings-menu rail-menu"
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node) &&
                !host.current?.contains(event.relatedTarget as Node)
              )
                dismiss();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              const items = Array.from(popup.current?.querySelectorAll('button') ?? []);
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                        items.length;
                items[next]?.focus();
              } else if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') event.preventDefault();
                dismiss(true);
              }
            }}
          >
            {actions.map(({ label, icon: Icon, run }) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                className="select-option"
                onClick={() => {
                  dismiss(true);
                  run();
                }}
              >
                <Icon size={18} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
