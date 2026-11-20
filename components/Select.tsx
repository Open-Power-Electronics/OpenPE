'use client';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { scrollMovesAnchor } from '@/lib/popup-scroll';

export type SelectOption = {
  value: string;
  label: string;
  keyShortcuts?: string;
  description?: ReactNode;
  icon?: ReactNode;
  muted?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  children?: SelectOption[];
};

function selectionPath(options: SelectOption[], value: string): number[] | null {
  for (const [index, option] of options.entries()) {
    if (option.value === value) return [index];
    const nested = option.children && selectionPath(option.children, value);
    if (nested) return [index, ...nested];
  }
  return null;
}
const samePath = (a: number[], b: number[]) =>
  a.length === b.length && a.every((index, depth) => index === b[depth]);

export default function Select({
  label,
  hint = label,
  value,
  options,
  onChange,
  onBeforeOpen,
  onExpand,
  onClosedEscape,
  disabled = false,
  active: enabled = true,
  icon,
  suffix,
  compact = false,
  iconOnly = false,
  showChevron = true,
  placeholder = 'Choose an option',
  selectedLabel,
  fitLabels,
  triggerClassName = '',
  popupStatus,
  popupClassName = '',
  popupMaxHeight,
  popupMaxOptions,
  popupPlacement = 'bottom',
  popupAnchor,
  popupBoundary,
  popupMatchWidth = iconOnly ? 'content' : 'trigger',
}: {
  label: string;
  hint?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  onBeforeOpen?: () => boolean;
  onExpand?: (value: string) => void;
  onClosedEscape?: () => void;
  disabled?: boolean;
  active?: boolean;
  icon?: ReactNode;
  suffix?: ReactNode;
  compact?: boolean;
  iconOnly?: boolean;
  showChevron?: boolean;
  placeholder?: string;
  selectedLabel?: string;
  fitLabels?: readonly string[];
  triggerClassName?: string;
  popupStatus?: string;
  popupClassName?: string;
  popupMaxHeight?: number;
  popupMaxOptions?: number;
  popupPlacement?: 'bottom' | 'right' | 'top-end';
  popupAnchor?: string;
  popupBoundary?: string;
  popupMatchWidth?: 'trigger' | 'parent' | 'content';
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menus = useRef<(HTMLDivElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndices, setActiveIndices] = useState<number[]>([0]);
  const [path, setPath] = useState<number[]>([]);
  const hadPopupStatus = useRef(false);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    maxHeight: 300,
    width: undefined as number | undefined,
    maxWidth: undefined as number | undefined,
  });
  const [childPositions, setChildPositions] = useState<
    { left: number; top: number; maxHeight: number }[]
  >([]);
  const chosenPath = selectionPath(options, value);
  let selected: SelectOption | undefined;
  if (chosenPath) {
    let items = options;
    for (const index of chosenPath) {
      selected = items[index];
      items = selected.children ?? [];
    }
  }
  const selectionLabel = selectedLabel ?? (selected?.label || placeholder);
  const levels = [popupStatus ? [] : options];
  for (const index of path) {
    const option = levels.at(-1)?.[index];
    if (!option?.children?.length || option.disabled) break;
    levels.push(option.children);
  }
  const depth = levels.length - 1;
  const activeIndex = activeIndices[depth] ?? 0;
  const menuId = (level: number) => (level ? `${id}-submenu-${level}` : id);
  const search = useRef({ text: '', at: 0 });
  const chosenIndex = chosenPath?.[0] ?? 0;
  useLayoutEffect(() => {
    if (open && !popupStatus && hadPopupStatus.current) {
      setActiveIndices([chosenIndex]);
      setPath([]);
      search.current = { text: '', at: 0 };
    }
    hadPopupStatus.current = open && Boolean(popupStatus);
  }, [chosenIndex, open, popupStatus]);
  function activate(level: number, index: number) {
    setActiveIndices((current) => {
      const next = [...current.slice(0, level), index];
      return samePath(current, next) ? current : next;
    });
  }
  function collapse(level: number) {
    setPath((current) => (current.length > level ? current.slice(0, level) : current));
  }
  function expand(level: number, index: number) {
    const option = levels[level]?.[index];
    if (!option?.children?.length || option.disabled) return;
    if (path[level] !== index || path.length <= level) {
      setPath([...path.slice(0, level), index]);
      const first = Math.max(
        0,
        option.children.findIndex((child) => !child.disabled),
      );
      setActiveIndices([...activeIndices.slice(0, level), index, first]);
      search.current = { text: '', at: 0 };
      onExpand?.(option.value);
    }
  }
  function show() {
    if (disabled || !enabled || onBeforeOpen?.() === false) return;
    const rect = (
      popupMatchWidth === 'parent' ? trigger.current!.parentElement! : trigger.current!
    ).getBoundingClientRect();
    setPosition({
      left: 8,
      top: rect.bottom + 6,
      maxHeight: Math.min(window.innerHeight - 16, popupMaxHeight ?? Infinity),
      maxWidth: undefined,
      width:
        popupMatchWidth !== 'content'
          ? Math.min(
              (popupMatchWidth === 'parent'
                ? trigger.current!.parentElement!
                : trigger.current!
              ).getBoundingClientRect().width,
              window.innerWidth - 16,
            )
          : undefined,
    });
    setActiveIndices([chosenIndex]);
    setPath([]);
    search.current = { text: '', at: 0 };
    setOpen(true);
  }
  function choose(level: number, index: number) {
    if (!enabled || disabled) return;
    const option = levels[level]?.[index];
    if (!option || option.disabled) return;
    if (option.children?.length) {
      expand(level, index);
      return;
    }
    onChange(option.value);
    setOpen(false);
    setPath([]);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    const button = trigger.current;
    const menu = menus.current[0];
    if (!open || !enabled || !button || !menu) return;
    const widthAnchor = popupMatchWidth === 'parent' ? button.parentElement! : button;
    const anchor = (popupAnchor && button.closest(popupAnchor)) || widthAnchor;
    const boundary = popupBoundary ? button.closest(popupBoundary) : null;
    const topEnd = popupPlacement === 'top-end';
    const gap = topEnd ? 8 : 6;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const bounds = boundary?.getBoundingClientRect();
      const innerLeft = boundary && bounds ? bounds.left + boundary.clientLeft : 0;
      const innerRight = boundary ? innerLeft + boundary.clientWidth : window.innerWidth;
      const leftEdge = Math.max(0, innerLeft) + 8;
      const rightEdge = Math.min(window.innerWidth, innerRight) - 8;
      const topEdge = Math.max(0, bounds?.top ?? 0) + 8;
      const bottomEdge = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight) - 8;
      const availableWidth = Math.max(0, rightEdge - leftEdge);
      const maxWidth = bounds ? availableWidth : undefined;
      const matchedWidth =
        popupMatchWidth !== 'content'
          ? Math.min(widthAnchor.getBoundingClientRect().width, availableWidth)
          : undefined;
      const measuredWidth = matchedWidth ?? menu.getBoundingClientRect().width;
      const width = Math.min(measuredWidth, maxWidth ?? Infinity);
      const lastVisibleOption =
        popupMaxOptions !== undefined && menu.children.length > popupMaxOptions
          ? menu.children.item(popupMaxOptions - 1)
          : null;
      const heightLimit = Math.min(
        popupMaxHeight ?? Infinity,
        lastVisibleOption
          ? lastVisibleOption.getBoundingClientRect().bottom -
              menu.getBoundingClientRect().top +
              menu.scrollTop +
              menu.clientTop
          : Infinity,
      );
      const height = Math.min(
        menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
        heightLimit,
      );
      const below = Math.max(0, bottomEdge - rect.bottom - gap);
      const above = Math.max(0, rect.top - topEdge - gap);
      const flip = topEnd || (below < height && above > below);
      const right = popupPlacement === 'right';
      const maxHeight = Math.min(
        right ? bottomEdge - topEdge : flip ? above : below,
        heightLimit,
      );
      const top = right
        ? Math.max(topEdge, Math.min(rect.bottom - height, bottomEdge - height))
        : flip
          ? Math.max(topEdge, rect.top - Math.min(height, maxHeight) - gap)
          : rect.bottom + gap;
      const left = Math.max(
        leftEdge,
        Math.min(
          right ? rect.right + 8 : topEnd ? rect.right - width : rect.left,
          rightEdge - width,
        ),
      );
      setPosition((current) =>
        current.top === top &&
        current.left === left &&
        current.maxHeight === maxHeight &&
        current.maxWidth === maxWidth &&
        current.width === matchedWidth
          ? current
          : { left, top, maxHeight, maxWidth, width: matchedWidth },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    observer.observe(widthAnchor);
    if (anchor !== widthAnchor) observer.observe(anchor);
    if (boundary) observer.observe(boundary);
    return () => observer.disconnect();
  }, [
    open,
    enabled,
    options,
    popupMaxHeight,
    popupMaxOptions,
    popupPlacement,
    popupAnchor,
    popupBoundary,
    popupMatchWidth,
  ]);
  useLayoutEffect(() => {
    if (!open || !enabled || levels.length < 2) return;
    const place = () => {
      const next: { left: number; top: number; maxHeight: number }[] = [];
      for (let level = 1; level < levels.length; level++) {
        const parent = menus.current[level - 1];
        const menu = menus.current[level];
        const anchor = parent?.children[path[level - 1]]?.getBoundingClientRect();
        if (!parent || !menu || !anchor) return;
        const bounds = parent.getBoundingClientRect();
        const width = menu.getBoundingClientRect().width;
        const maxHeight = Math.min(innerHeight - 16, popupMaxHeight ?? Infinity);
        const height = Math.min(
          menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
          maxHeight,
        );
        const ancestor = level > 1 ? menus.current[level - 2]?.getBoundingClientRect() : null;
        const hasDescendants = levels[level].some((option) => option.children?.length);
        const preferLeft = ancestor
          ? bounds.left < ancestor.left
          : hasDescendants && bounds.left - 8 > innerWidth - bounds.right - 8;
        const right = bounds.right + 2;
        const leftward = bounds.left - width - 2;
        const nextLeft =
          preferLeft && leftward >= 8
            ? leftward
            : right + width <= innerWidth - 8
              ? right
              : leftward;
        const left = Math.max(8, Math.min(nextLeft, innerWidth - width - 8));
        const top = Math.max(8, Math.min(anchor.top, innerHeight - height - 8));
        next.push({ left, top, maxHeight });
      }
      setChildPositions((current) =>
        current.length === next.length &&
        current.every((item, index) =>
          Object.entries(item).every(
            ([key, value]) => value === next[index][key as keyof typeof item],
          ),
        )
          ? current
          : next,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    const listeners: (() => void)[] = [];
    for (let level = 0; level < levels.length; level++) {
      const menu = menus.current[level];
      if (!menu) continue;
      observer.observe(menu);
      if (level < levels.length - 1) {
        const hide = () => collapse(level);
        menu.addEventListener('scroll', hide);
        listeners.push(() => menu.removeEventListener('scroll', hide));
      }
    }
    return () => {
      observer.disconnect();
      for (const remove of listeners) remove();
    };
  }, [open, enabled, path, options, position, childPositions, popupMaxHeight]);
  useLayoutEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  useEffect(() => {
    if (!open || !enabled) return;
    const outside = (e: PointerEvent) => {
      if (
        !trigger.current?.contains(e.target as Node) &&
        !menus.current.some((menu) => menu?.contains(e.target as Node))
      )
        setOpen(false);
    };
    const dismiss = () => setOpen(false);
    const scroll = (e: Event) => {
      if (scrollMovesAnchor(e, trigger.current)) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open, enabled]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    menus.current[depth]?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [depth, activeIndex, open]);
  function optionElement(option: SelectOption, index: number, level: number) {
    const nested = !!option.children?.length;
    const expanded = nested && levels.length > level + 1 && path[level] === index;
    return (
      <div
        key={option.value}
        id={`${menuId(level)}-${index}`}
        role="option"
        aria-selected={value === option.value}
        aria-disabled={option.disabled || undefined}
        aria-keyshortcuts={option.keyShortcuts}
        aria-haspopup={nested ? 'listbox' : undefined}
        aria-expanded={nested ? expanded : undefined}
        aria-controls={expanded ? menuId(level + 1) : undefined}
        data-separated={option.separatorBefore || undefined}
        className={`select-option ${(activeIndices[level] ?? 0) === index ? 'highlighted' : ''}${option.muted ? ' muted' : ''}`}
        onPointerMove={() => {
          if (nested) expand(level, index);
          else {
            activate(level, index);
            collapse(level);
          }
        }}
        onClick={() => choose(level, index)}
      >
        {option.icon}
        <span>
          <strong title={option.label}>{option.label}</strong>
          {option.description && <small>{option.description}</small>}
        </span>
        {nested ? (
          <ChevronRight size={15} className="select-option-chevron" aria-hidden="true" />
        ) : (
          <Check
            size={15}
            className={`select-option-check${value === option.value ? '' : ' select-check-hidden'}`}
            aria-hidden="true"
          />
        )}
      </div>
    );
  }
  return (
    <>
      <button
        ref={trigger}
        className={`select-trigger ${compact ? 'select-compact' : ''} ${triggerClassName}`}
        type="button"
        role="combobox"
        aria-label={label}
        aria-description={selectionLabel}
        title={iconOnly ? hint : undefined}
        aria-expanded={open && enabled}
        aria-controls={
          open && enabled ? levels.map((_, level) => menuId(level)).join(' ') : undefined
        }
        aria-haspopup="listbox"
        aria-activedescendant={
          open && enabled && levels[depth].length ? `${menuId(depth)}-${activeIndex}` : undefined
        }
        disabled={disabled || !enabled}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!enabled) return;
          e.stopPropagation();
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
            if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') e.preventDefault();
            return;
          }
          if (
            e.repeat &&
            (e.key === 'Enter' || e.key === ' ') &&
            options.some((option) => option.children)
          ) {
            e.preventDefault();
            return;
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            if (!open) {
              show();
              return;
            }
            const length = levels[depth].length;
            if (!length) return;
            activate(
              depth,
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? length - 1
                  : (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + length) % length,
            );
          } else if (
            open &&
            e.key === 'ArrowRight' &&
            levels[depth][activeIndex]?.children?.length
          ) {
            e.preventDefault();
            expand(depth, activeIndex);
          } else if (depth > 0 && open && e.key === 'ArrowLeft') {
            e.preventDefault();
            collapse(depth - 1);
            search.current = { text: '', at: 0 };
          } else if (open && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            choose(depth, activeIndex);
          } else if (e.key === 'Escape') {
            if (open) {
              e.preventDefault();
              if (depth > 0) collapse(depth - 1);
              else setOpen(false);
            } else if (onClosedEscape && !e.repeat) {
              e.preventDefault();
              onClosedEscape();
            }
          } else if (e.key === 'Tab') {
            setOpen(false);
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
            e.preventDefault();
            if (!open) show();
            const now = performance.now();
            search.current.text =
              (now - search.current.at < 600 ? search.current.text : '') + e.key.toLowerCase();
            search.current.at = now;
            const next = levels[open ? depth : 0].findIndex((option) =>
              option.label.toLowerCase().startsWith(search.current.text),
            );
            if (next >= 0) activate(open ? depth : 0, next);
          }
        }}
      >
        {icon}
        {!iconOnly &&
          (fitLabels ? (
            <span className="select-sized-value">
              <span className="select-value">{selectionLabel}</span>
              {fitLabels.length > 0 && (
                <span className="select-size-samples" aria-hidden="true">
                  {fitLabels.map((label, index) => (
                    <span key={index} data-label={label} />
                  ))}
                </span>
              )}
            </span>
          ) : (
            <span className="select-value">{selectionLabel}</span>
          ))}
        {suffix}
        {showChevron && <ChevronDown size={14} />}
      </button>
      {open &&
        enabled &&
        levels.map((items, level) =>
          createPortal(
            <div
              ref={(element) => {
                menus.current[level] = element;
              }}
              id={menuId(level)}
              role="listbox"
              aria-label={level ? levels[level - 1][path[level - 1]].label : label}
              className={`select-popup ${level ? 'select-submenu ' : ''}${popupClassName}`}
              data-match-width={level === 0 && position.width !== undefined ? true : undefined}
              data-narrow-field={
                level === 0 && position.width !== undefined && position.width < 72 ? true : undefined
              }
              style={
                (level
                  ? (childPositions[level - 1] ?? { left: 8, top: 8, maxHeight: 300 })
                  : {
                      ...position,
                      minWidth: position.width,
                      '--select-popup-width-limit':
                        position.maxWidth === undefined ? undefined : `${position.maxWidth}px`,
                    }) as CSSProperties
              }
              onPointerDown={(event) => event.preventDefault()}
            >
              {popupStatus ? (
                <div
                  className="select-option"
                  role="option"
                  aria-label={popupStatus}
                  aria-disabled="true"
                  aria-selected="false"
                >
                  <span role="status">
                    <strong title={popupStatus}>{popupStatus}</strong>
                  </span>
                </div>
              ) : (
                items.map((option, index) => optionElement(option, index, level))
              )}
            </div>,
            trigger.current?.closest('dialog') ?? document.body,
            String(level),
          ),
        )}
    </>
  );
}
