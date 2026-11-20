'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { desktopChrome } from '@/lib/desktop-chrome';
import Select, { type SelectOption } from './Select';
import useRetainedElements from './useRetainedElements';

type MenuAction = { label: string; run: () => void; disabled?: boolean; keyShortcuts?: string };
type MenuItem = (MenuAction | { label: string; items: MenuAction[] }) & {
  separatorBefore?: boolean;
};
export type TitlebarMenu = { label: string; items: MenuItem[] };
export type EditTarget = HTMLElement | SVGElement;

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
    ...('run' in item && { disabled: item.disabled, keyShortcuts: item.keyShortcuts }),
  }));
}

export function runTitlebarMenuAction(items: MenuItem[], value: string) {
  const [index, childIndex] = value.split(':').map(Number);
  const item = items[index];
  if (!item) return;
  if ('items' in item) item.items[childIndex]?.run();
  else if (!item.disabled) item.run();
}
const menuSlots = ['File', 'Edit', 'View', 'Help'].map((id) => ({ id }));
export default function DesktopTitlebar({
  menus = [],
  editMenu,
  composing,
  onBack,
  onForward,
}: {
  menus?: TitlebarMenu[];
  editMenu?: (target: EditTarget | null, mac: boolean) => MenuAction[];
  composing?: React.RefObject<boolean>;
  onBack?: () => void;
  onForward?: () => void;
}) {
  const [chrome, setChrome] = useState<'overlay' | 'inset' | null>(null);
  useEffect(() => {
    setChrome(desktopChrome(window.openpe));
  }, []);
  const visible = chrome !== null;
  const caption = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<EditTarget | null>(null);
  const pendingEdit = useRef<number | undefined>(undefined);
  const [editOptions, setEditOptions] = useState<SelectOption[]>([]);
  const editChoice = useRef<{ target: EditTarget | null; options: SelectOption[] }>(null);
  const actions = useRef({ menus, editMenu, composing, chrome, onBack, onForward });
  // Every committed parent render refreshes actions, even when its menu labels
  // and retained drawing agree. Abandoned renders cannot replace live guards.
  useLayoutEffect(() => {
    actions.current = { menus, editMenu, composing, chrome, onBack, onForward };
  });
  useEffect(() => {
    if (!visible) return;
    const track = () => {
      const target = document.activeElement;
      if (
        (target instanceof HTMLElement || target instanceof SVGElement) &&
        !target.closest('.desktop-titlebar, .application-menu')
      )
        lastFocus.current = target;
    };
    track();
    document.addEventListener('focusin', track);
    return () => {
      document.removeEventListener('focusin', track);
      window.clearTimeout(pendingEdit.current);
      lastFocus.current = null;
    };
  }, [visible]);
  const prepareEdit = useCallback(() => {
    const { editMenu, chrome, composing } = actions.current;
    if (composing?.current || !editMenu) return false;
    const target = lastFocus.current;
    const options = titlebarMenuOptions(editMenu(target, chrome === 'inset'));
    if (!options.length) return false;
    editChoice.current = { target, options };
    setEditOptions(options);
    return true;
  }, []);
  const runMenu = useCallback((label: string, value: string) => {
    if (label === 'Edit' && actions.current.editMenu) {
      const choice = editChoice.current;
      const trigger = caption.current?.querySelector('[aria-label="Edit"]');
      const picked = choice?.options.find((option) => option.value === value);
      if (!choice || !picked || picked.disabled) return;
      window.clearTimeout(pendingEdit.current);
      // Let the Select remove its popup and finish restoring trigger focus first.
      pendingEdit.current = window.setTimeout(() => {
        const { editMenu, chrome, composing } = actions.current;
        if (composing?.current || document.activeElement !== trigger) return;
        const item = editMenu?.(choice.target, chrome === 'inset').find(
          ({ label }) => label === picked.label,
        );
        if (item && !item.disabled) item.run();
      }, 0);
      return;
    }
    const menu = actions.current.menus.find((menu) => menu.label === label);
    if (menu) runTitlebarMenuAction(menu.items, value);
  }, []);
  const goBack = useCallback(() => actions.current.onBack?.(), []);
  const goForward = useCallback(() => actions.current.onForward?.(), []);
  const canBack = Boolean(onBack);
  const canForward = Boolean(onForward);
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
        </nav>
      ),
    [visible, canBack, canForward, goBack, goForward],
  );
  // Only presentation enters the retained element cache. An already-open menu
  // resolves its current action by slot/index instead of retaining old closures.
  const hasEditMenu = Boolean(editMenu);
  const labels = menuSlots.map(({ id }) =>
    id === 'Edit' && hasEditMenu
      ? editOptions
      : titlebarMenuOptions(menus.find((menu) => menu.label === id)?.items ?? []),
  );
  const menuInputs = [visible, ...labels.map((items) => JSON.stringify(items)), hasEditMenu];
  const retainMenu = useRetainedElements(menuSlots, menuInputs);
  const menuElements = useMemo(
    () =>
      visible &&
      menuSlots.map(({ id: label }, slot) =>
        retainMenu({ key: label, labels: menuInputs[slot + 1] }, () => {
          const items = labels[slot];
          const isEdit = label === 'Edit' && hasEditMenu;
          const element = (
            <Select
              key={label}
              label={label}
              value=""
              placeholder={label}
              compact
              showChevron={false}
              popupClassName="application-menu"
              popupMatchWidth="content"
              disabled={!isEdit && !items.length}
              options={items}
              onBeforeOpen={isEdit ? prepareEdit : undefined}
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
        <div
          ref={caption}
          className="desktop-titlebar"
          data-chrome={chrome}
          aria-label="Window toolbar"
        >
          <div className="desktop-titlebar-content">
            {navigation}
            <nav
              className="caption-menus"
              aria-label="Application menus"
              onPointerDownCapture={(event) => {
                if (
                  composing?.current &&
                  event.target instanceof Element &&
                  event.target.closest('[aria-label="Edit"]')
                )
                  event.preventDefault();
              }}
            >
              {menuElements}
            </nav>
            <span className="caption-drag-space" aria-hidden="true" />
          </div>
        </div>
      ) : null,
    [visible, chrome, navigation, menuElements, composing],
  );
}
