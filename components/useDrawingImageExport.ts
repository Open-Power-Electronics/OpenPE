import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { emptyCapabilityInput, type CapabilityHost } from '@/api/capabilities';

/** Bind the mounted drawing's existing native export to its project host. */
export function useDrawingImageExport(
  host: CapabilityHost | undefined,
  surface: 'Schematic' | 'Layout' | 'Model',
  basis: unknown,
  active: boolean,
  setBusy: (busy: boolean) => void,
  save: (check: () => void) => Promise<string | null>,
) {
  const current = useRef({ view: null as object | null, save });
  const busy = useRef(false);
  useLayoutEffect(() => {
    current.current.save = save;
  });
  useLayoutEffect(() => {
    current.current.view = active ? {} : null;
    return () => {
      current.current.view = null;
    };
  }, [basis, active]);
  const availability = useCallback(() => {
    if (typeof window.openpe?.exportImage !== 'function')
      return 'Use the desktop app to export a PNG.';
    if (!current.current.view || document.querySelector('dialog[open]'))
      return `Open the originating project's ${surface} view and finish any open dialog.`;
    return true;
  }, [surface]);
  const run = useCallback(
    async (signal?: AbortSignal) => {
      const { view, save } = current.current;
      const check = () => {
        signal?.throwIfAborted();
        const available = availability();
        if (available !== true) throw new Error(available);
        if (current.current.view !== view)
          throw new Error('The drawing changed while preparing the PNG. Export it again.');
      };
      check();
      if (busy.current) throw new Error('An image export is already in progress.');
      busy.current = true;
      setBusy(true);
      try {
        const name = await save(check);
        return name ? { status: 'exported', name } : { status: 'cancelled' };
      } finally {
        busy.current = false;
        setBusy(false);
      }
    },
    [availability, setBusy],
  );
  useEffect(
    () =>
      host?.register({
        id: `workbench.export${surface}Image`,
        owner: 'host',
        kind: 'command',
        description: `Export the live ${surface} drawing as a PNG through the native destination picker. Open the view first.`,
        mutation: 'external',
        review: 'optional',
        inputSchema: emptyCapabilityInput,
        available: () => (busy.current ? 'An image export is already in progress.' : availability()),
        handler: (_, { signal }) => run(signal),
      }),
    [host, surface, availability, run],
  );
  return run;
}
