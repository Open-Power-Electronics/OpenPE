'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  popupPlacement?: 'bottom' | 'right';
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
    if (!open || !enabled || !trigger.current || !popup.current) return;
    const place = () => {
      const rect = (
        popupMatchWidth === 'parent' ? trigger.current!.parentElement! : trigger.current!
      ).getBoundingClientRect();
      const menu = popup.current!;
      const anchor =
        popupMatchWidth === 'parent' ? trigger.current!.parentElement! : trigger.current!;
      const matchedWidth = popupMatchWidth
        ? Math.min(anchor.getBoundingClientRect().width, window.innerWidth - 16)
        : undefined;
      const width = matchedWidth ?? menu.getBoundingClientRect().width;
      const height = Math.min(
        menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
        popupMaxHeight ?? Infinity,
      );
      const below = Math.max(0, window.innerHeight - rect.bottom - 14);
      const above = Math.max(0, rect.top - 14);
      const flip = below < height && above > below;
      const right = popupPlacement === 'right';
      const maxHeight = Math.min(
        right ? window.innerHeight - 16 : flip ? above : below,
        popupMaxHeight ?? Infinity,
      );
      const top = right
        ? Math.max(8, Math.min(rect.bottom - height, window.innerHeight - height - 8))
        : flip
          ? Math.max(8, rect.top - Math.min(height, maxHeight) - 6)
          : rect.bottom + 6;
      const left = Math.max(
        8,
        Math.min(right ? rect.right + 8 : rect.left, window.innerWidth - width - 8),
      );
      setPosition((current) =>
        current.top === top &&
        current.left === left &&
        current.maxHeight === maxHeight &&
        current.width === matchedWidth
          ? current
          : { left, top, maxHeight, width: matchedWidth },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(popup.current);
    observer.observe(
      popupMatchWidth === 'parent' ? trigger.current.parentElement! : trigger.current,
    );
    return () => observer.disconnect();
  }, [open, enabled, options, popupMaxHeight, popupPlacement, popupMatchWidth]);
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
            style={position}
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
