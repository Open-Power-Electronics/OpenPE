import { useId, useState, type ReactElement, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

type TabProps = {
  label: string;
  icon: LucideIcon;
  children: ReactNode | (() => ReactNode);
};

export function PropertyTab({ children }: TabProps) {
  return <>{typeof children === 'function' ? children() : children}</>;
}

type Tab = ReactElement<TabProps>;

function PropertyTabPanel({
  tab,
  selected,
  locked,
  id,
  tabbed,
}: {
  tab: Tab;
  selected: boolean;
  locked: boolean;
  id: string;
  tabbed: boolean;
}) {
  const [visited, setVisited] = useState(selected);
  if (selected && !visited) setVisited(true);
  return (
    <div
      role={tabbed ? 'tabpanel' : undefined}
      id={`${id}-panel`}
      aria-labelledby={tabbed ? `${id}-tab` : undefined}
      hidden={!selected}
      inert={!selected}
    >
      {(selected || visited) && (
        <fieldset className="property-tab-fields" disabled={locked}>
          {tab}
        </fieldset>
      )}
    </div>
  );
}

export function PropertyTabs({
  children,
  locked = false,
}: {
  children: (Tab | false | null | undefined)[];
  locked?: boolean;
}) {
  const id = useId();
  const [selection, select] = useState('General');
  const tabs = children.filter((tab): tab is Tab => Boolean(tab));
  const current = tabs.some((tab) => tab.props.label === selection)
    ? selection
    : tabs[0].props.label;
  if (current !== selection) select(current);
  const tabbed = tabs.length > 1;
  return (
    <>
      {tabbed && (
        <div
          className="editor-dock-tabs property-tabs"
          role="tablist"
          aria-label="Property sections"
        >
          {tabs.map(({ props: { label, icon: Icon } }, index) => (
            <button
              key={label}
              type="button"
              className="editor-dock-tab reveal-button"
              role="tab"
              id={`${id}-${index}-tab`}
              aria-controls={`${id}-${index}-panel`}
              aria-label={label}
              aria-selected={current === label}
              tabIndex={current === label ? 0 : -1}
              title={label}
              data-edit-action
              onClick={() => select(label)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                let next: number;
                if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
                else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = tabs.length - 1;
                else return;
                event.preventDefault();
                select(tabs[next].props.label);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
            >
              <Icon size={16} aria-hidden />
              <span className="reveal-button-label" aria-hidden>
                <span>{label}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {tabs.map((tab, index) => (
        <PropertyTabPanel
          key={tab.props.label}
          id={`${id}-${index}`}
          tab={tab}
          selected={current === tab.props.label}
          locked={locked}
          tabbed={tabbed}
        />
      ))}
    </>
  );
}
