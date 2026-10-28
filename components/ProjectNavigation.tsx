'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Folder, FolderSearch, Save, SaveAll, X } from 'lucide-react';
import { scrollMovesAnchor } from '@/lib/popup-scroll';
import NavigationButton from './NavigationButton';
import { emptyWorkspaceProjects, useWorkspaceProjects } from './WorkspacePresentation';

export type ProjectNavigationItem = { id: string; title: string; unsaved: boolean };
export type ProjectFileAction = 'save' | 'save-as' | 'duplicate' | 'reveal' | 'close';
const actions = [
  { id: 'save', label: 'Save', icon: Save },
  { id: 'save-as', label: 'Save as', icon: SaveAll },
  { id: 'duplicate', label: 'Duplicate project', icon: Copy },
  { id: 'reveal', label: 'Show in File Explorer', icon: FolderSearch },
  { id: 'close', label: 'Close project', icon: X },
] as const;
export default function ProjectNavigation({
  projects: fallbackProjects = emptyWorkspaceProjects,
  active = true,
  activeId,
  onSelect,
  onAction,
}: {
  projects?: readonly ProjectNavigationItem[];
  active?: boolean;
  activeId?: string;
  onSelect: (id: string) => void;
  onAction: (id: string, action: ProjectFileAction) => void;
}) {
  const projects = useWorkspaceProjects(fallbackProjects, active);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  function dismiss(restoreFocus = false) {
    setMenu(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show(id: string, element: HTMLElement, x?: number, y?: number) {
    if (!active) return;
    const button = element.querySelector('button');
    if (!button) return;
    trigger.current = button;
    const bounds = button.getBoundingClientRect();
    setMenu({ id, x: x ?? bounds.right + 6, y: y ?? bounds.top });
  }
  const menuActive = Boolean(active && menu && projects.some((project) => project.id === menu.id));
  useLayoutEffect(() => {
    if (menu && !menuActive) setMenu(null);
  }, [menu, menuActive]);
  useLayoutEffect(() => {
    if (!menu || !menuActive || !popup.current) return;
    const bounds = popup.current.getBoundingClientRect();
    popup.current.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    popup.current.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    popup.current.querySelector('button')?.focus({ preventScroll: true });
  }, [menu, menuActive]);
  useEffect(() => {
    if (!menu || !menuActive) return;
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) setMenu(null);
    };
    const hide = () => setMenu(null);
    const scroll = (event: Event) => {
      if (scrollMovesAnchor(event, trigger.current)) hide();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [menu, menuActive]);
  if (!projects.length) return null;
  return (
    <>
      <div className="project-navigation" role="group" aria-label="Open projects">
        {projects.map((project, index) => (
          <span
            key={project.id}
            data-project-id={project.id}
            onContextMenu={(event) => {
              event.preventDefault();
              show(
                project.id,
                event.currentTarget,
                event.clientX || undefined,
                event.clientY || undefined,
              );
            }}
            onKeyDown={(event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault();
                event.stopPropagation();
                show(project.id, event.currentTarget);
              }
            }}
          >
            <NavigationButton
              compact
              icon={Folder}
              label={project.title}
              active={project.id === activeId}
              unsaved={project.unsaved}
              accessibleLabel={`${project.title}, Project ${index + 1}${project.unsaved ? ', Unsaved changes' : ''}`}
              onClick={() => {
                if (active) onSelect(project.id);
              }}
              hasMenu
              menuOpen={menu?.id === project.id}
            />
          </span>
        ))}
      </div>
      {menu &&
        menuActive &&
        createPortal(
          <div
            ref={popup}
            role="menu"
            aria-label="Project file actions"
            className="select-popup project-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              event.stopPropagation();
              const buttons = Array.from(
                popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
              );
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              } else if (event.key === 'Escape' || event.key === 'Tab') {
                event.preventDefault();
                dismiss(true);
              }
            }}
          >
            {actions.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="select-option"
                data-separated={id === 'close' || undefined}
                disabled={id === 'reveal' && !window.openpe}
                aria-description={
                  id === 'reveal' && !window.openpe
                    ? 'Requires the desktop app.'
                    : undefined
                }
                onClick={() => {
                  if (!active || !projects.some((project) => project.id === menu.id)) return;
                  dismiss(true);
                  onAction(menu.id, id);
                }}
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
