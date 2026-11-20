'use client';

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronRight } from 'lucide-react';

type AnalysisComponent = { id: string; reference: string };

const referenceOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const categoryLabels: Record<string, string> = {
  C: 'Capacitors',
  D: 'Diodes',
  F: 'Fuses',
  I: 'Current sources',
  J: 'Connectors',
  K: 'Relays',
  L: 'Inductors',
  P: 'Connectors',
  Q: 'Transistors',
  R: 'Resistors',
  SW: 'Switches',
  T: 'Transformers',
  TP: 'Test points',
  U: 'Integrated circuits',
  V: 'Voltage sources',
  Y: 'Crystals',
};

export default function AnalysisComponents<T extends AnalysisComponent>({
  items,
  visible,
  locateDisabled = false,
  onLocate,
  locateDescription,
  composingRef,
  disclosureRef,
  renderControl,
}: {
  items: T[];
  visible: boolean;
  locateDisabled?: boolean;
  onLocate?: (id: string) => boolean;
  locateDescription: string;
  composingRef?: RefObject<boolean>;
  disclosureRef?: RefObject<ReadonlySet<string>>;
  renderControl: (item: T, collapsed: boolean) => ReactNode;
}) {
  const localComposing = useRef(false);
  const composing = composingRef ?? localComposing;
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => disclosureRef?.current ?? new Set(),
  );
  useLayoutEffect(() => {
    if (disclosureRef) disclosureRef.current = collapsedGroups;
  }, [disclosureRef, collapsedGroups]);
  const groups = useMemo(() => {
    const categories = new Map<string, T[]>();
    for (const item of items) {
      const prefix = item.reference.match(/^[a-z]+/i)?.[0].toUpperCase() || 'Other';
      const category = categories.get(prefix);
      if (category) category.push(item);
      else categories.set(prefix, [item]);
    }
    return [...categories]
      .sort(([a], [b]) => referenceOrder.compare(a, b))
      .map(([prefix, parts]) => ({
        prefix,
        label: categoryLabels[prefix] ? `${categoryLabels[prefix]} (${prefix})` : prefix,
        parts: parts.sort((a, b) => referenceOrder.compare(a.reference, b.reference)),
      }));
  }, [items]);
  return (
    <section
      className="simulation-components"
      aria-label="Components"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
    >
      <h3>Components</h3>
      <div className="simulation-component-groups">
        {groups.map((group) => {
          const collapsed = collapsedGroups.has(group.prefix);
          return (
            <details
              className="simulation-component-group"
              aria-label={group.label}
              key={group.prefix}
              open={!collapsed}
            >
              <summary
                aria-label={group.label}
                onClick={(event) => {
                  event.preventDefault();
                  if (!visible || composing.current) return;
                  setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group.prefix)) next.delete(group.prefix);
                    else next.add(group.prefix);
                    return next;
                  });
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (
                    !visible ||
                    composing.current ||
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229
                  )
                    event.preventDefault();
                }}
              >
                <ChevronRight size={14} aria-hidden="true" />
                <span className="analysis-category-name">
                  {categoryLabels[group.prefix] || group.prefix}
                </span>
              </summary>
              <div className="simulation-fields">
                {group.parts.map((item) => (
                  <div className="simulation-field" key={item.id}>
                    <button
                      type="button"
                      className="analysis-component-locate"
                      aria-label={`Locate ${item.reference}`}
                      title={locateDescription}
                      disabled={!visible || collapsed || locateDisabled || !onLocate}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (
                          composing.current ||
                          event.nativeEvent.isComposing ||
                          event.nativeEvent.keyCode === 229
                        )
                          event.preventDefault();
                      }}
                      onClick={() => {
                        if (!visible || collapsed || locateDisabled || composing.current) return;
                        onLocate?.(item.id);
                      }}
                    >
                      {item.reference}
                    </button>
                    {renderControl(item, collapsed)}
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
