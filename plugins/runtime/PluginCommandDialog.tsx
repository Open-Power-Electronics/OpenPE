'use client';
import { useEffect, useRef, useState } from 'react';
import type { CapabilityHost } from '../../api/capabilities';
import type { PluginCommand } from '../../api/plugins';
import Dialog from '../../components/Dialog';

export default function PluginCommandDialog({
  command,
  host,
  onClose,
}: {
  command: PluginCommand;
  host: CapabilityHost;
  onClose: () => void;
}) {
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const control = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      control.current?.abort();
    },
    [],
  );
  return (
    <Dialog
      title={command.name}
      onClose={onClose}
      footer={
        <button
          className="dialog-button"
          disabled={running}
          onClick={async () => {
            const current = new AbortController();
            control.current = current;
            setError('');
            setResult('');
            setRunning(true);
            try {
              const data = JSON.parse(input);
              const output = await host.query(command.id, data, {
                actor: 'human',
                signal: current.signal,
              });
              if (!current.signal.aborted) setResult(JSON.stringify(output, null, 2));
            } catch (error) {
              if (!current.signal.aborted) setError((error as Error).message);
            } finally {
              if (!current.signal.aborted) setRunning(false);
            }
          }}
        >
          {running ? 'Running…' : 'Run'}
        </button>
      }
    >
      <div className="plugin-command-body">
        <p>{command.description}</p>
        <label>
          Inputs (JSON)
          <textarea
            aria-label="Plugin command inputs"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={8}
            spellCheck={false}
          />
        </label>
        {error && (
          <p className="plugins-error" role="alert">
            {error}
          </p>
        )}
        {result && <pre aria-label="Plugin command result">{result}</pre>}
      </div>
    </Dialog>
  );
}
