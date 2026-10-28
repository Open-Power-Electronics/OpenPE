'use client';

import { Suspense, type ReactNode } from 'react';
import Dialog from './Dialog';

/** Keep background input blocked while an on-demand dialog module loads. */
export default function DeferredDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <Dialog title={title} onClose={onClose}>
          <p role="status">Loading…</p>
        </Dialog>
      }
    >
      {children}
    </Suspense>
  );
}
