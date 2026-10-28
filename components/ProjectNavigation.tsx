'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Folder,
  FolderSearch,
  Pin,
  PinOff,
  Save,
  SaveAll,
  Trash2,
  X,
} from 'lucide-react';
import type { SessionAction } from '@/lib/chat-sessions';
import { scrollMovesAnchor } from '@/lib/popup-scroll';
import NavigationButton from './NavigationButton';
import DockNamePopup, { type DockNameTarget } from './DockNamePopup';
import { emptyWorkspaceProjects, useWorkspaceProjects } from './WorkspacePresentation';

export type ProjectNavigationItem = {
  id: string;
  title: string;
  unsaved: boolean;
  pinned?: true;
  sessions?: readonly { id: string; title: string; pinned?: true; archived?: true }[];
};
export type ProjectFileAction = 'save' | 'save-as' | 'duplicate' | 'reveal' | 'close';
export type ProjectAction = ProjectFileAction | 'pin' | 'unpin';
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
  activeSessionId,
  onSelectSession,
  onSessionAction,
}: {
  projects?: readonly ProjectNavigationItem[];
  active?: boolean;
  activeId?: string;
  activeSessionId?: string;
  onSelectSession?: (projectId: string, sessionId: string) => void;
  onSessionAction?: (projectId: string, sessionId: string, action: SessionAction) => void;
  onSelect: (id: string) => void;
  onAction: (id: string, action: ProjectAction) => void;
}) {
  const projects = useWorkspaceProjects(fallbackProjects, active);
  const [menu, setMenu] = useState<{ id: string; sessionId?: string; x: number; y: number } | null>(
    null,
  );
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [namePopup, setNamePopup] = useState<DockNameTarget | null>(null);
  function showName(title: string, element: HTMLElement) {
    if (!active || menu) return;
    const bounds = element.getBoundingClientRect();
    setNamePopup({
      title,
      x: bounds.right + 10,
      y: Math.max(32, Math.min(window.innerHeight - 32, bounds.top + bounds.height / 2)),
    });
  }
  useEffect(() => {
    if (!namePopup) return;
    const hide = () => setNamePopup(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', key);
    };
  }, [namePopup]);
  function dismiss(restoreFocus = false) {
    setMenu(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show(id: string, element: HTMLElement, x?: number, y?: number, sessionId?: string) {
    if (!active) return;
    setNamePopup(null);
    const button = element instanceof HTMLButtonElement ? element : element.querySelector('button');
    if (!button) return;
    trigger.current = button;
    const bounds = button.getBoundingClientRect();
    setMenu({ id, sessionId, x: x ?? bounds.right + 6, y: y ?? bounds.top });
  }
  const menuProject = projects.find((project) => project.id === menu?.id);
  const menuSession = menuProject?.sessions?.find((session) => session.id === menu?.sessionId);
  const menuActive = Boolean(active && menuProject && (!menu?.sessionId || menuSession));
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
        {projects
          .toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
          .map((project, index) => (
            <span
              key={project.id}
              className="project-session-group"
              data-active={project.id === activeId || undefined}
              data-pinned={project.pinned}
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
              <span
                className="project-folder"
                data-pinned={project.pinned}
                onPointerEnter={(event) => showName(project.title, event.currentTarget)}
                onPointerLeave={(event) => {
                  if (!event.currentTarget.contains(document.activeElement)) setNamePopup(null);
                }}
                onFocus={(event) => showName(project.title, event.currentTarget)}
                onBlur={() => setNamePopup(null)}
              >
                <NavigationButton
                  compact
                  nativeTitle={false}
                  icon={Folder}
                  label={project.title}
                  active={project.id === activeId}
                  unsaved={project.unsaved}
                  accessibleLabel={`${project.title}, Project ${index + 1}${project.pinned ? ', Pinned project' : ''}${project.unsaved ? ', Unsaved changes' : ''}`}
                  onClick={() => {
                    if (active) onSelect(project.id);
                  }}
                  hasMenu
                  menuOpen={menu?.id === project.id}
                />
              </span>
              {project.sessions && onSelectSession && (
                <div
                  className="project-session-list"
                  role="group"
                  aria-label={project.title + ' conversations'}
                >
                  {project.sessions
                    .filter((session) => !session.archived)
                    .toReversed()
                    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
                    .map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        className="project-session"
                        data-session-id={session.id}
                        data-pinned={session.pinned}
                        aria-label={session.title}
                        aria-description={session.pinned ? 'Pinned conversation.' : undefined}
                        aria-haspopup="menu"
                        aria-expanded={menu?.sessionId === session.id}
                        onPointerEnter={(event) => showName(session.title, event.currentTarget)}
                        onPointerLeave={(event) => {
                          if (!event.currentTarget.contains(document.activeElement))
                            setNamePopup(null);
                        }}
                        onFocus={(event) => showName(session.title, event.currentTarget)}
                        onBlur={() => setNamePopup(null)}
                        aria-current={
                          project.id === activeId && session.id === activeSessionId
                            ? 'true'
                            : undefined
                        }
                        onClick={() => {
                          if (active) onSelectSession?.(project.id, session.id);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          show(
                            project.id,
                            event.currentTarget,
                            event.clientX || undefined,
                            event.clientY || undefined,
                            session.id,
                          );
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'ContextMenu' ||
                            (event.shiftKey && event.key === 'F10')
                          ) {
                            event.preventDefault();
                            event.stopPropagation();
                            show(project.id, event.currentTarget, undefined, undefined, session.id);
                          }
                        }}
                      >
                        <span className="project-session-dot" aria-hidden="true" />
                      </button>
                    ))}
                </div>
              )}
            </span>
          ))}
      </div>
      <DockNamePopup target={namePopup} enabled={active && !menu} />
      {menu &&
        menuActive &&
        createPortal(
          <div
            ref={popup}
            role="menu"
            aria-label={menuSession ? 'Conversation actions' : 'Project file actions'}
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
            {menuSession && onSessionAction
              ? [
                  {
                    id: menuSession.pinned ? 'unpin' : 'pin',
                    label: menuSession.pinned ? 'Unpin' : 'Pin',
                    icon: menuSession.pinned ? PinOff : Pin,
                  },
                  { id: 'archive', label: 'Archive', icon: Archive },
                  { id: 'delete', label: 'Delete conversation', icon: Trash2 },
                ].map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    className="select-option"
                    data-destructive={id === 'delete' || undefined}
                    data-separated={id === 'delete' || undefined}
                    onClick={() => {
                      dismiss(true);
                      onSessionAction(menu.id, menuSession.id, id as SessionAction);
                    }}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {label}
                  </button>
                ))
              : [
                  {
                    id: menuProject?.pinned ? ('unpin' as const) : ('pin' as const),
                    label: menuProject?.pinned ? 'Unpin' : 'Pin',
                    icon: menuProject?.pinned ? PinOff : Pin,
                  },
                  ...actions,
                ].map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    className="select-option"
                    data-separated={id === 'close' || undefined}
                    data-destructive={id === 'close' || undefined}
                    disabled={id === 'reveal' && !window.openpe}
                    aria-description={
                      id === 'reveal' && !window.openpe ? 'Requires the desktop app.' : undefined
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
            {!menuSession &&
              onSessionAction &&
              menuProject?.sessions
                ?.filter((session) => session.archived)
                .map((session, index) => (
                  <button
                    key={session.id}
                    type="button"
                    role="menuitem"
                    className="select-option"
                    data-separated={index === 0 || undefined}
                    onClick={() => {
                      dismiss(true);
                      onSessionAction(menu.id, session.id, 'restore');
                    }}
                  >
                    <ArchiveRestore size={16} aria-hidden="true" />
                    Restore {session.title}
                  </button>
                ))}
          </div>,
          document.body,
        )}
    </>
  );
}
