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
  description?: ReactNode;
  icon?: ReactNode;
  muted?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  children?: Omit<SelectOption, 'children'>[];
};
export default function Select({
  label,
  hint = label,
  value,
  options,
  onChange,
  onClosedEscape,
  disabled = false,
  active: enabled = true,
  icon,
  suffix,
  compact = false,
  iconOnly = false,
  showChevron = true,
  placeholder = 'Choose an option',
  popupClassName = '',
  popupMaxHeight,
  popupPlacement = 'bottom',
  popupAnchor,
  popupBoundary,
  popupMatchWidth,
}: {
  label: string;
  hint?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  onClosedEscape?: () => void;
  disabled?: boolean;
  active?: boolean;
  icon?: ReactNode;
  suffix?: ReactNode;
  compact?: boolean;
  iconOnly?: boolean;
  showChevron?: boolean;
  placeholder?: string;
  popupClassName?: string;
  popupMaxHeight?: number;
  popupPlacement?: 'bottom' | 'right' | 'top-end';
  popupAnchor?: string;
  popupBoundary?: string;
  popupMatchWidth?: 'trigger' | 'parent';
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const childPopup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [submenu, setSubmenu] = useState<number | null>(null);
  const [childActive, setChildActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    maxHeight: 300,
    width: undefined as number | undefined,
    maxWidth: undefined as number | undefined,
  });
  const [childPosition, setChildPosition] = useState({ left: 8, top: 8, maxHeight: 300 });
  const chosen = options.findIndex((option) => option.value === value);
  const selectionLabel = options[chosen]?.label || placeholder;
  const children = submenu === null ? undefined : options[submenu]?.children;
  const childOpen = open && enabled && !!children?.length;
  const search = useRef({ text: '', at: 0 });
  function expand(index: number) {
    if (!options[index]?.children?.length || options[index]?.disabled) return;
    setActive(index);
    if (submenu !== index) {
      setSubmenu(index);
      setChildActive(0);
      search.current = { text: '', at: 0 };
    }
  }
  function show() {
    if (disabled || !enabled) return;
    const rect = (
      popupMatchWidth === 'parent' ? trigger.current!.parentElement! : trigger.current!
    ).getBoundingClientRect();
    setPosition({
      left: 8,
      top: rect.bottom + 6,
      maxHeight: Math.min(window.innerHeight - 16, popupMaxHeight ?? Infinity),
      maxWidth: undefined,
      width: popupMatchWidth
        ? Math.min(
            (popupMatchWidth === 'parent'
              ? trigger.current!.parentElement!
              : trigger.current!
            ).getBoundingClientRect().width,
            window.innerWidth - 16,
          )
        : undefined,
    });
    setActive(Math.max(0, chosen));
    setSubmenu(null);
    setOpen(true);
  }
  function choose(index: number) {
    if (!enabled || disabled) return;
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.children?.length) {
      expand(index);
      return;
    }
    chooseValue(option.value);
  }
  function chooseValue(next: string) {
    if (!enabled || disabled) return;
    const option = options
      .flatMap((option) => [option, ...(option.children || [])])
      .find((option) => option.value === next);
    if (option?.disabled) return;
    onChange(next);
    setOpen(false);
    setSubmenu(null);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    const button = trigger.current;
    const menu = popup.current;
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
      const matchedWidth = popupMatchWidth
        ? Math.min(widthAnchor.getBoundingClientRect().width, availableWidth)
        : undefined;
      const measuredWidth = matchedWidth ?? menu.getBoundingClientRect().width;
      const width = Math.min(measuredWidth, maxWidth ?? Infinity);
      const height = Math.min(
        menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
        popupMaxHeight ?? Infinity,
      );
      const below = Math.max(0, bottomEdge - rect.bottom - gap);
      const above = Math.max(0, rect.top - topEdge - gap);
      const flip = topEnd || (below < height && above > below);
      const right = popupPlacement === 'right';
      const maxHeight = Math.min(
        right ? bottomEdge - topEdge : flip ? above : below,
        popupMaxHeight ?? Infinity,
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
    popupPlacement,
    popupAnchor,
    popupBoundary,
    popupMatchWidth,
  ]);
  useLayoutEffect(() => {
    if (!childOpen || submenu === null || !popup.current || !childPopup.current) return;
    const parent = popup.current;
    const menu = childPopup.current;
    const place = () => {
      const anchor = parent.children[submenu]?.getBoundingClientRect();
      if (!anchor) return;
      const bounds = parent.getBoundingClientRect();
      const width = menu.getBoundingClientRect().width;
      const maxHeight = Math.min(innerHeight - 16, popupMaxHeight ?? Infinity);
      const height = Math.min(menu.scrollHeight + menu.offsetHeight - menu.clientHeight, maxHeight);
      const left = Math.max(
        8,
        Math.min(
          bounds.right + width + 2 <= innerWidth - 8 ? bounds.right + 2 : bounds.left - width - 2,
          innerWidth - width - 8,
        ),
      );
      const top = Math.max(8, Math.min(anchor.top, innerHeight - height - 8));
      setChildPosition((current) =>
        current.left === left && current.top === top && current.maxHeight === maxHeight
          ? current
          : { left, top, maxHeight },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    const hide = () => setSubmenu(null);
    parent.addEventListener('scroll', hide);
    return () => {
      observer.disconnect();
      parent.removeEventListener('scroll', hide);
    };
  }, [childOpen, submenu, children, position, popupMaxHeight]);
  useLayoutEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  useEffect(() => {
    if (!open || !enabled) return;
    const outside = (e: PointerEvent) => {
      if (
        !trigger.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node) &&
        !childPopup.current?.contains(e.target as Node)
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
    if (childOpen) childPopup.current?.children[childActive]?.scrollIntoView({ block: 'nearest' });
    else popup.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, childActive, childOpen, open]);
  function optionElement(option: SelectOption, index: number, child = false) {
    const nested = !child && !!option.children?.length;
    return (
      <div
        key={option.value}
        id={`${id}${child ? '-submenu' : ''}-${index}`}
        role="option"
        aria-selected={value === option.value}
        aria-disabled={option.disabled || undefined}
        aria-haspopup={nested ? 'listbox' : undefined}
        aria-expanded={nested ? childOpen && submenu === index : undefined}
        aria-controls={nested && childOpen && submenu === index ? `${id}-submenu` : undefined}
        data-separated={option.separatorBefore || undefined}
        className={`select-option ${(child ? childActive : active) === index ? 'highlighted' : ''}${option.muted ? ' muted' : ''}`}
        onPointerMove={() => {
          if (child) setChildActive(index);
          else {
            setActive(index);
            if (nested) expand(index);
            else setSubmenu(null);
          }
        }}
        onClick={() => (child ? chooseValue(option.value) : choose(index))}
      >
        {option.icon}
        <span>
          <strong>{option.label}</strong>
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
        className={`select-trigger ${compact ? 'select-compact' : ''}`}
        type="button"
        role="combobox"
        aria-label={label}
        aria-description={selectionLabel}
        title={iconOnly ? hint : undefined}
        aria-expanded={open && enabled}
        aria-controls={open && enabled ? `${id}${childOpen ? ` ${id}-submenu` : ''}` : undefined}
        aria-haspopup="listbox"
        aria-activedescendant={
          open && enabled
            ? `${id}${childOpen ? '-submenu' : ''}-${childOpen ? childActive : active}`
            : undefined
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
            const index = childOpen ? childActive : active;
            const length = childOpen ? children!.length : options.length;
            (childOpen ? setChildActive : setActive)(
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? length - 1
                  : (index + (e.key === 'ArrowDown' ? 1 : -1) + length) % length,
            );
          } else if (open && e.key === 'ArrowRight' && options[active]?.children?.length) {
            e.preventDefault();
            expand(active);
          } else if (childOpen && e.key === 'ArrowLeft') {
            e.preventDefault();
            setSubmenu(null);
          } else if (open && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            if (childOpen) {
              const child = children?.[childActive];
              if (child) chooseValue(child.value);
            } else choose(active);
          } else if (e.key === 'Escape') {
            if (open) {
              e.preventDefault();
              if (childOpen) setSubmenu(null);
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
            const next = (childOpen ? children! : options).findIndex((option) =>
              option.label.toLowerCase().startsWith(search.current.text),
            );
            if (next >= 0) (childOpen ? setChildActive : setActive)(next);
          }
        }}
      >
        {icon}
        {!iconOnly && <span className="select-value">{selectionLabel}</span>}
        {suffix}
        {showChevron && <ChevronDown size={14} />}
      </button>
      {open &&
        enabled &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="listbox"
            aria-label={label}
            className={`select-popup ${popupClassName}`}
            style={
              {
                ...position,
                '--select-popup-width-limit':
                  position.maxWidth === undefined ? undefined : `${position.maxWidth}px`,
              } as CSSProperties
            }
            onPointerDown={(e) => e.preventDefault()}
          >
            {options.map((option, index) => optionElement(option, index))}
          </div>,
          trigger.current?.closest('dialog') ?? document.body,
        )}
      {childOpen &&
        createPortal(
          <div
            ref={childPopup}
            id={`${id}-submenu`}
            role="listbox"
            aria-label={options[submenu!].label}
            className={`select-popup select-submenu ${popupClassName}`}
            style={childPosition}
            onPointerDown={(event) => event.preventDefault()}
          >
            {children!.map((option, index) => optionElement(option, index, true))}
          </div>,
          trigger.current?.closest('dialog') ?? document.body,
        )}
    </>
  );
}
