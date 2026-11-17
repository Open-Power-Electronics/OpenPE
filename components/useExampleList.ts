import { useEffect, useMemo, useState } from 'react';
import type { DiscoveredExample, RecentProject } from '@/lib/bridge';
import { homeExamples, homeRecent } from '@/lib/home-examples';

export function useExampleList(active: boolean, screen: string) {
  const [discovered, setDiscovered] = useState<DiscoveredExample[] | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>(homeRecent);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active || !window.openpe) return;
    let current = true,
      request = 0;
    const reload = async () => {
      const token = ++request;
      const results = await Promise.allSettled([
        window.openpe!.listExamples(),
        window.openpe!.listRecent(),
      ]);
      if (!current || token !== request) return;
      const [examplesResult, recentResult] = results;
      if (examplesResult.status === 'fulfilled') setDiscovered(examplesResult.value.entries);
      if (recentResult.status === 'fulfilled') setRecent(recentResult.value.entries);
      else setRecent([]);
      setRevision((value) => value + 1);
      setError(
        results
          .flatMap((result) =>
            result.status === 'fulfilled'
              ? result.value.warnings
              : [
                  result.reason instanceof Error
                    ? result.reason.message
                    : 'Could not read Home projects.',
                ],
          )
          .join('\n'),
      );
    };
    void reload();
    window.addEventListener('focus', reload);
    const unsubscribe = window.openpe.onRecentChanged(reload);
    return () => {
      current = false;
      window.removeEventListener('focus', reload);
      unsubscribe();
    };
  }, [active, screen]);
  const sections = useMemo(
    () => [
      {
        id: 'recent-heading',
        title: 'Recent',
        examples: recent.map((entry) =>
          entry.id.startsWith('recent:')
            ? { ...entry, title: entry.title.replace(/\.kicad_pro$/i, '') }
            : entry,
        ),
      },
      {
        id: 'example-heading',
        title: 'Example',
        examples:
          discovered === null
            ? homeExamples
            : discovered.filter(
                (entry) =>
                  entry.section === 'examples' || !homeRecent.some((item) => item.id === entry.id),
              ),
      },
    ],
    [discovered, recent],
  );
  return { sections, error, revision };
}
