'use client';

import { Suspense, type ReactNode } from 'react';
import Dialog from './Dialog';
import WorkspaceLoading from './WorkspaceLoading';

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
          <WorkspaceLoading panel label={`Loading ${title}`} />
        </Dialog>
      }
    >
      {children}
    </Suspense>
  );
}
