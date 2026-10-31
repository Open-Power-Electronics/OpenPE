'use client';

import { useMemo } from 'react';
import { FileCode2 } from 'lucide-react';
import type { HistoryFileChange } from '@/lib/project-history';

const maxCharacters = 12000;
const maxLines = 160;

function preview(text: string, other: string) {
  let first = 0;
  while (first < Math.min(text.length, other.length) && text[first] === other[first]) first++;
  let end = text.length,
    otherEnd = other.length;
  while (end > first && otherEnd > first && text[end - 1] === other[otherEnd - 1]) {
    end--;
    otherEnd--;
  }
  let start = first === 0 ? 0 : text.lastIndexOf('\n', first - 1) + 1;
  for (let i = 0; i < 3 && start > 0; i++) start = text.lastIndexOf('\n', start - 2) + 1;
  start = Math.max(start, first - 3000);
  let finish = end;
  for (let i = 0; i < 3 && finish < text.length; i++) {
    const next = text.indexOf('\n', finish);
    finish = next < 0 ? text.length : next + 1;
  }
  finish = Math.min(finish, start + maxCharacters);
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < start; i = text.indexOf('\n', i + 1)) line++;
  let offset = start;
  const lines = text.slice(start, finish).split('\n');
  return {
    truncated: start > 0 || finish < text.length || lines.length > maxLines,
    lines: lines.slice(0, maxLines).map((value) => {
      const position = offset;
      offset += value.length + 1;
      return {
        number: line++,
        text: value,
        changed:
          text !== other && offset > first && (first === end ? position <= end : position < end),
      };
    }),
  };
}

export default function ProjectFileComparison({
  change,
  beforeLabel,
  afterLabel,
}: {
  change: HistoryFileChange;
  beforeLabel: string;
  afterLabel: string;
}) {
  const content = useMemo(
    () => ({
      before: preview(change.before?.source ?? '', change.after?.source ?? ''),
      after: preview(change.after?.source ?? '', change.before?.source ?? ''),
    }),
    [change],
  );
  return (
    <section className="history-file-comparison" aria-label="File comparison">
      <header className="history-file-heading">
        <FileCode2 size={17} aria-hidden="true" />
        <strong title={change.name}>{change.name}</strong>
        <span data-change={change.kind}>
          {change.kind === 'added' ? 'Added' : change.kind === 'removed' ? 'Deleted' : 'Modified'}
        </span>
      </header>
      <div className="history-file-panes">
        {(['before', 'after'] as const).map((side) => {
          const file = change[side];
          const binary = file && /[\u0000-\u0008\u000e-\u001f]/.test(file.source.slice(0, 4096));
          return (
            <section
              className="history-file-pane"
              aria-label={side === 'before' ? 'Before file' : 'After file'}
              key={side}
            >
              <header>
                <span>{side === 'before' ? 'Before' : 'After'}</span>
                <strong title={side === 'before' ? beforeLabel : afterLabel}>
                  {side === 'before' ? beforeLabel : afterLabel}
                </strong>
                {file && <small>{file.encoding === 'latin1' ? 'Latin-1' : 'UTF-8'}</small>}
              </header>
              {!file ? (
                <div className="history-file-message">File not present in this version.</div>
              ) : binary ? (
                <div className="history-file-message">
                  Binary file ·{' '}
                  {(file.encoding === 'latin1'
                    ? file.source.length
                    : new TextEncoder().encode(file.source).length
                  ).toLocaleString()}{' '}
                  bytes
                </div>
              ) : (
                <div className="history-file-code">
                  <pre>
                    {content[side].lines.map((line) => (
                      <span
                        className="history-diff-line"
                        data-change={
                          line.changed ? (side === 'before' ? 'removed' : 'added') : undefined
                        }
                        key={line.number}
                      >
                        <span className="history-line-number" aria-hidden="true">
                          {line.number}
                        </span>
                        <code>{line.text || ' '}</code>
                      </span>
                    ))}
                  </pre>
                  {content[side].truncated && (
                    <p className="history-preview-notice">
                      Preview excerpt · complete file retained in the version.
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
