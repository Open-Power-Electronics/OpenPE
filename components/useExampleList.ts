import { useEffect, useMemo, useState } from 'react';
import type { DiscoveredExample } from '@/lib/bridge';
import { homeExampleSections } from '@/lib/home-examples';

export function useExampleList(active: boolean, screen: string) {
  const [discovered, setDiscovered] = useState<DiscoveredExample[] | null>(null);
  const [error, setError] = useState('');
  const [generation, refresh] = useState(0);
  useEffect(() => {
    if (!active || !window.openpe) return;
    let current = true,
      request = 0;
    const reload = async () => {
      const token = ++request;
      try {
        const result = await window.openpe!.listExamples();
        if (!current || token !== request) return;
        setDiscovered(result.entries);
        setError(result.warnings.join('\n'));
      } catch (error) {
        if (current && token === request)
          setError(error instanceof Error ? error.message : 'Could not read examples.');
      }
    };
    void reload();
    window.addEventListener('focus', reload);
    return () => {
      current = false;
      window.removeEventListener('focus', reload);
    };
  }, [active, generation, screen]);
  const sections = useMemo(
    () =>
      discovered === null
        ? homeExampleSections
        : [
            {
              id: 'recent-heading',
              title: 'Recent',
              examples: discovered.filter((entry) => entry.section === 'recent'),
            },
            {
              id: 'example-heading',
              title: 'Example',
              examples: discovered.filter((entry) => entry.section === 'examples'),
            },
          ],
    [discovered],
  );
  return { sections, error, refresh: () => refresh((value) => value + 1) };
}
