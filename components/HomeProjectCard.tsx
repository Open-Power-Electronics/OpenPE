'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, Pin, PinOff, Trash2 } from 'lucide-react';
import type { Circuit } from '@/lib/circuit';
import type { RecentProject } from '@/lib/bridge';
import CanvasContextMenu from './CanvasContextMenu';
import ExamplePreview from './ExamplePreview';

export default function HomeProjectCard({
  entry,
  active,
  recent,
  revision,
  preview,
  onOpen,
  onError,
}: {
  entry: RecentProject;
  active: boolean;
  recent: boolean;
  revision: number;
  preview?: Circuit;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
}) {
  const target = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [nativePreview, setNativePreview] = useState<Circuit | null>(null);
  const [previewError, setPreviewError] = useState('');
  const native = entry.id.startsWith('recent:');
  useEffect(() => {
    if (!active || !native || !target.current) return;
    const observer = new IntersectionObserver(([item]) => setVisible(item.isIntersecting), {
      rootMargin: '160px',
    });
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [active, native]);
  useEffect(() => {
    if (!active || !visible || !native || !window.openpe) return;
    let current = true;
    void window.openpe
      .previewRecent(entry.id)
      .then((circuit) => {
        if (!current) return;
        setNativePreview(circuit);
        setPreviewError('');
      })
      .catch((error: unknown) => {
        if (!current) return;
        setNativePreview(null);
        setPreviewError(error instanceof Error ? error.message : 'Preview unavailable.');
      });
    return () => {
      current = false;
    };
  }, [active, visible, native, entry.id, revision]);
  const circuit = native ? nativePreview : preview;
  return (
    <>
      <button
        ref={target}
        className="home-example"
        onClick={() => onOpen(entry.id)}
        aria-label={`Open ${entry.title}${native ? '' : ' example'}`}
        title={entry.description}
      >
        {recent && entry.pinned && (
          <Pin size={16} className="home-example-pin" aria-label="Pinned" />
        )}
        <div className="home-example-preview" aria-hidden="true">
          {circuit ? (
            <ExamplePreview circuit={circuit} />
          ) : previewError ? (
            <span title={previewError}>Preview unavailable</span>
          ) : (
            <FolderOpen style={{ width: 32, height: 32 }} />
          )}
        </div>
        <div className="home-example-description">
          <div className="home-example-heading">
            <h3>{entry.title}</h3>
            <ArrowRight size={18} className="home-example-arrow" aria-hidden="true" />
          </div>
          <small style={{ overflowWrap: 'anywhere' }}>{entry.description}</small>
        </div>
      </button>
      <CanvasContextMenu
        target={target}
        active={active && recent}
        identity={entry.id}
        label="Recent project actions"
        onError={onError}
        actions={[
          {
            id: 'pin-recent',
            label: entry.pinned ? 'Unpin' : 'Pin',
            icon: entry.pinned ? PinOff : Pin,
            disabled: typeof window === 'undefined' || !window.openpe,
            run: async () => {
              await window.openpe!.pinRecent(
                native ? entry.id : `default:${entry.id}`,
                !entry.pinned,
              );
              onError('');
            },
          },
          {
            id: 'remove-recent',
            label: 'Remove',
            icon: Trash2,
            destructive: true,
            disabled: !!entry.pinned || typeof window === 'undefined' || !window.openpe,
            run: async () => {
              await window.openpe!.removeRecent(native ? entry.id : `default:${entry.id}`);
              onError('');
            },
          },
        ]}
      />
    </>
  );
}
