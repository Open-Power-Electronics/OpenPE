import type { KeyboardEvent } from 'react';
import styles from './RuleCheckPanel.module.css';

export default function RuleTabs<T extends string>({
  id,
  label,
  tabs,
  active,
  onSelect,
  guardKey,
}: {
  id: string;
  label: string;
  tabs: readonly T[];
  active: T;
  onSelect: (tab: T) => void;
  guardKey: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <div
      className={`editor-dock-tabs editor-visualization-tabs ${styles.settingsTabs}`}
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab}
          type="button"
          className="editor-dock-tab"
          role="tab"
          id={`${id}-tab-${index}`}
          aria-controls={`${id}-panel-${index}`}
          aria-selected={active === tab}
          tabIndex={active === tab ? 0 : -1}
          onClick={() => onSelect(tab)}
          onKeyUp={guardKey}
          onKeyDown={(event) => {
            guardKey(event);
            if (event.defaultPrevented) return;
            let next: number;
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabs.length - 1;
            else return;
            event.preventDefault();
            onSelect(tabs[next]);
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus();
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}
