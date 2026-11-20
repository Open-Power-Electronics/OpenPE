'use client';

import { useEffect, useState } from 'react';
import WorkspaceLoading from './WorkspaceLoading';

const maximumPdfBytes = 32 * 1024 * 1024;

export default function ProjectPdfPreview({
  fileId,
  id,
  visible,
  name,
}: {
  fileId: string;
  id: string;
  visible: boolean;
  name: string;
}) {
  const [document, setDocument] = useState<{ key: string; url: string }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const key = JSON.stringify([fileId, id]);

  useEffect(() => {
    setDocument(undefined);
    if (!visible) return;
    let cancelled = false;
    let url: string | undefined;
    setFailure(undefined);
    void (async () => {
      try {
        if (!window.openpe) throw new Error('Use the desktop app to preview project PDFs.');
        const pdf = await window.openpe.projectFilePdf({ fileId, id });
        if (cancelled) return;
        if (
          !Number.isInteger(pdf.bytes) ||
          pdf.bytes < 5 ||
          pdf.bytes > maximumPdfBytes ||
          typeof pdf.base64 !== 'string' ||
          pdf.base64.length > Math.ceil(maximumPdfBytes / 3) * 4
        )
          throw new Error('The project PDF exceeds the preview limit.');
        const decoded = atob(pdf.base64);
        if (decoded.length !== pdf.bytes || !decoded.startsWith('%PDF-'))
          throw new Error('The project file does not contain a PDF document.');
        const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        setDocument({ key, url });
      } catch (reason) {
        if (!cancelled)
          setFailure({
            key,
            message: reason instanceof Error ? reason.message : 'Could not preview project PDF.',
          });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileId, id, key, visible]);

  if (!visible) return null;
  if (failure?.key === key)
    return (
      <p className="source-editor-error" role="alert" data-agent-private>
        {failure.message}
      </p>
    );
  if (document?.key !== key)
    return (
      <div className="project-pdf-loading" data-agent-private>
        <WorkspaceLoading panel label="Loading PDF" />
      </div>
    );
  return (
    <iframe
      title={name}
      src={document.url}
      referrerPolicy="no-referrer"
      className="source-editor-pdf"
      style={{ flex: '1 1 0', width: '100%', height: '100%', minWidth: 0, minHeight: 0, border: 0 }}
      data-agent-private
    />
  );
}
