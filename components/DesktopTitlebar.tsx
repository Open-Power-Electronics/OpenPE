'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react';
import Select, { type SelectOption } from './Select';
import useRetainedElements from './useRetainedElements';

type MenuAction = { label: string; run: () => void };
type MenuItem = (MenuAction | { label: string; items: MenuAction[] }) & {
  separatorBefore?: boolean;
};
export type TitlebarMenu = { label: string; items: MenuItem[] };

export function titlebarMenuOptions(items: MenuItem[]): SelectOption[] {
  return items.map((item, index) => ({
    value: String(index),
    label: item.label,
    ...(item.separatorBefore && { separatorBefore: true }),
    ...('items' in item && {
      children: item.items.map((child, childIndex) => ({
        value: `${index}:${childIndex}`,
        label: child.label,
      })),
    }),
  }));
}

export function runTitlebarMenuAction(items: MenuItem[], value: string) {
  const [index, childIndex] = value.split(':').map(Number);
  const item = items[index];
  if (!item) return;
  if ('items' in item) item.items[childIndex]?.run();
  else item.run();
}
const menuSlots = ['File', 'Edit', 'View', 'Help'].map((id) => ({ id }));
export default function DesktopTitlebar({
  menus = [],
  onBack,
  onForward,
  onToggleSidebar,
  sidebarVisible = true,
}: {
  menus?: TitlebarMenu[];
  onBack?: () => void;
  onForward?: () => void;
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(window.openpe?.titleBarOverlay === true);
  }, []);
  const actions = useRef({ menus, onBack, onForward, onToggleSidebar });
  // Every committed parent render refreshes actions, even when its menu labels
  // and retained drawing agree. Abandoned renders cannot replace live guards.
  useLayoutEffect(() => {
    actions.current = { menus, onBack, onForward, onToggleSidebar };
  });
  const runMenu = useCallback((label: string, value: string) => {
    const menu = actions.current.menus.find((menu) => menu.label === label);
    if (menu) runTitlebarMenuAction(menu.items, value);
  }, []);
  const goBack = useCallback(() => actions.current.onBack?.(), []);
  const goForward = useCallback(() => actions.current.onForward?.(), []);
  const toggleSidebar = useCallback(() => actions.current.onToggleSidebar?.(), []);
  const canBack = Boolean(onBack);
  const canForward = Boolean(onForward);
  const canToggleSidebar = Boolean(onToggleSidebar);
  const navigation = useMemo(
    () =>
      visible && (
        <nav className="caption-navigation" aria-label="Page navigation">
          <button aria-label="Back" title="Back" disabled={!canBack} onClick={goBack}>
            <ArrowLeft size={15} />
          </button>
          <button aria-label="Forward" title="Forward" disabled={!canForward} onClick={goForward}>
            <ArrowRight size={15} />
          </button>
          <button
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            aria-pressed={sidebarVisible}
            disabled={!canToggleSidebar}
            onClick={toggleSidebar}
          >
            <PanelLeft size={15} />
          </button>
        </nav>
      ),
    [
      visible,
      canBack,
      canForward,
      canToggleSidebar,
      sidebarVisible,
      goBack,
      goForward,
      toggleSidebar,
    ],
  );
  // Only presentation enters the retained element cache. An already-open menu
  // resolves its current action by slot/index instead of retaining old closures.
  const labels = menuSlots.map(({ id }) =>
    titlebarMenuOptions(menus.find((menu) => menu.label === id)?.items ?? []),
  );
  const menuInputs = [visible, ...labels.map((items) => JSON.stringify(items))];
  const retainMenu = useRetainedElements(menuSlots, menuInputs);
  const menuElements = useMemo(
    () =>
      visible &&
      menuSlots.map(({ id: label }, slot) =>
        retainMenu({ key: label, labels: menuInputs[slot + 1] }, () => {
          const items = labels[slot];
          const element = (
            <Select
              key={label}
              label={label}
              value=""
              placeholder={label}
              compact
              showChevron={false}
              disabled={!items.length}
              options={items}
              onChange={(value) => runMenu(label, value)}
            />
          );
          return element;
        }),
      ),
    menuInputs,
  );
  return useMemo(
    () =>
      visible ? (
        <div className="desktop-titlebar" aria-label="Window toolbar">
          <div className="desktop-titlebar-content">
            {navigation}
            <nav className="caption-menus" aria-label="Application menus">
              {menuElements}
            </nav>
            <span className="caption-drag-space" aria-hidden="true" />
          </div>
        </div>
      ) : null,
    [visible, navigation, menuElements],
  );
}
