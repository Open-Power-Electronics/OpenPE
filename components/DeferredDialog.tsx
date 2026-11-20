'use client';

import { Suspense, type ReactNode } from 'react';
import Dialog from './Dialog';
import WorkspaceLoading from './WorkspaceLoading';

/** Keep background input blocked while an on-demand dialog module loads. */
export default function DeferredDialog({
  title,
  onClose,
  compact = false,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  compact?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <Dialog title={title} onClose={onClose} compact={compact} wide={wide}>
          <WorkspaceLoading panel label={`Loading ${title}`} />
        </Dialog>
      }
    >
      {children}
    </Suspense>
  );
}
