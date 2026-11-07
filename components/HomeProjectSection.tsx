'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

export default function HomeProjectSection({
  title,
  children,
}: {
  title: string;
  children: (expanded: boolean) => ReactNode;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="home-examples" aria-labelledby={`${id}-heading`}>
      <div className="home-section-heading">
        <h2 id={`${id}-heading`}>
          <button
            type="button"
            className="home-section-toggle"
            aria-expanded={expanded}
            aria-controls={`${id}-cards`}
            onClick={() => setExpanded((value) => !value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onKeyUp={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <ChevronRight size={16} aria-hidden="true" />
            {title}
          </button>
        </h2>
      </div>
      <div id={`${id}-cards`} className="home-example-list" hidden={!expanded}>
        {children(expanded)}
      </div>
    </section>
  );
}
